import { queryClient, queryKeys } from "../../queryClient.js";
import {
  getStaticPlaylistOperation,
  moveStaticPlaylistTracks,
  removeStaticPlaylistTracks,
} from "../../utils/api/endpoints/playlists.js";

const UNDO_DURATION_MS = 8000;
const MAX_POLL_DELAY_MS = 8000;
const MAX_POLL_ERRORS = 30;
const EMPTY_IDS = new Set();

export const trackCountLabel = (count) => `${count} track${count === 1 ? "" : "s"}`;

const stayLabel = (count) => (count === 1 ? "It stays" : "They stay");

const errorReason = (error) => {
  const reason = error?.response?.data?.message || error?.response?.data?.error || "";
  return reason && !/[.!?]$/.test(reason) ? `${reason}.` : reason;
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const describeTracks = (tracks, jobIds) => {
  const named = jobIds.length === 1 ? tracks.find((track) => track?.id === jobIds[0])?.trackName : "";
  return named || trackCountLabel(jobIds.length);
};

const playlistName = (playlistId) =>
  queryClient
    .getQueryData(queryKeys.playlistStatus)
    ?.sharedPlaylists?.find((playlist) => playlist.id === playlistId)?.name || "the playlist";

export function createPlaylistTrackChanges(toast) {
  let changes = [];
  let hidden = new Map();
  let nextKey = 0;
  const listeners = new Set();

  const publish = (next) => {
    changes = next;
    hidden = new Map();
    for (const change of changes) {
      const ids = hidden.get(change.sourceId) || new Set();
      change.jobIds.forEach((id) => ids.add(id));
      hidden.set(change.sourceId, ids);
    }
    listeners.forEach((listener) => listener());
  };
  const find = (key) => changes.find((change) => change.key === key);
  const update = (key, patch) =>
    publish(changes.map((change) => (change.key === key ? { ...change, ...patch } : change)));
  const release = (key) => publish(changes.filter((change) => change.key !== key));

  const settle = async (change, { error = null, success = null } = {}) => {
    await Promise.all(
      [change.sourceId, change.targetId].filter(Boolean).map((id) =>
        queryClient.invalidateQueries({ queryKey: queryKeys.playlistJobs(id) })),
    ).catch(() => {});
    await queryClient.invalidateQueries({ queryKey: queryKeys.playlistStatus }).catch(() => {});
    release(change.key);
    if (success) toast.showSuccess(success);
    if (error) toast.showError(error, 8000);
  };

  const report = (change, result) => {
    const outcomes = Array.isArray(result?.outcomes) ? result.outcomes : [];
    const failed = outcomes.filter((outcome) => outcome.status === "failed");
    const moved = outcomes.filter((outcome) => outcome.status === "moved").length;
    const targetName = change.targetName || playlistName(result?.targetPlaylistId);
    const phrase = (what) =>
      change.action === "move" ? `move ${what} to ${targetName}` : `remove ${what} from ${change.sourceName}`;
    let error = null;
    if (result?.state === "failed") {
      error = `Could not ${phrase(change.label)}. ${result.message || "Review the playlist before retrying."}`;
    } else if (failed.length) {
      const reason = failed[0].message ? `: ${failed[0].message.replace(/\.$/, "")}` : "";
      error = `Could not ${phrase(trackCountLabel(failed.length))}${reason}. ${stayLabel(failed.length)} in ${change.sourceName}.`;
    }
    const success = change.action === "move" && moved
      ? `Moved ${moved === change.jobIds.length ? change.label : trackCountLabel(moved)} to ${targetName}`
      : null;
    return settle({ ...change, targetId: change.targetId || result?.targetPlaylistId }, { error, success });
  };

  const follow = async (change, operationId) => {
    let errors = 0;
    for (let attempt = 0; ; attempt += 1) {
      if (attempt > 0) await wait(Math.min(1000 * 2 ** (attempt - 1), MAX_POLL_DELAY_MS));
      let result;
      try {
        result = await getStaticPlaylistOperation(change.sourceId, operationId, { bypassCache: true });
        errors = 0;
      } catch (error) {
        if (error?.response?.status === 404 || ++errors >= MAX_POLL_ERRORS) {
          return settle(change, {
            error: `Could not confirm the change to ${change.sourceName}. Review the playlist before trying again.`,
          });
        }
        continue;
      }
      if (["completed", "failed"].includes(result?.state)) return report(change, result);
    }
  };

  const submit = async (change, request) => {
    let response;
    try {
      response = await request();
    } catch (error) {
      const action = change.action === "move" ? "move" : "remove";
      const where = change.action === "move" ? `to ${change.targetName}` : `from ${change.sourceName}`;
      return settle(change, {
        error: error?.response
          ? `Could not ${action} ${change.label} ${where}. Nothing changed. ${errorReason(error) || "Try again."}`
          : `Could not confirm the change to ${change.sourceName}. Check the playlist before trying again.`,
      });
    }
    if (response?.rejected?.length) {
      toast.showError(
        `Could not ${change.action === "move" ? "move" : "remove"} ${trackCountLabel(response.rejected.length)}. ${response.rejected[0].message}`,
        8000,
      );
    }
    if (!response?.queued) return settle(change);
    return follow(change, response.operationId);
  };

  const commit = (key) => {
    const change = find(key);
    if (!change || change.phase !== "undo") return;
    update(key, { phase: "saving" });
    void submit(change, () =>
      removeStaticPlaylistTracks(change.sourceId, change.jobIds, { keepalive: true }));
  };

  const undo = (key) => {
    const change = find(key);
    if (!change || change.phase !== "undo") return;
    release(key);
    toast.showSuccess(`Restored ${change.label} to ${change.sourceName}`);
  };

  const pendingIds = (source, tracks) => {
    const taken = hidden.get(source?.id) || EMPTY_IDS;
    return [...new Set(tracks.map((track) => track?.id).filter(Boolean))].filter((id) => !taken.has(id));
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getHidden: () => hidden,
    remove(source, tracks) {
      const jobIds = pendingIds(source, tracks);
      if (!source?.id || !jobIds.length) return;
      const key = ++nextKey;
      const change = {
        key,
        action: "remove",
        sourceId: source.id,
        sourceName: source.name || "the playlist",
        jobIds,
        label: describeTracks(tracks, jobIds),
        phase: "undo",
      };
      publish([...changes, change]);
      const toastId = toast.addToast(
        {
          message: `Removed ${change.label} from ${change.sourceName}`,
          action: { label: "Undo", onClick: () => undo(key) },
          onClose: () => commit(key),
        },
        "success",
        UNDO_DURATION_MS,
      );
      if (find(key)) update(key, { toastId });
    },
    move(source, tracks, target) {
      const jobIds = pendingIds(source, tracks);
      if (!source?.id || !jobIds.length || !target) return;
      const creating = target.mode === "new";
      const targetName = creating
        ? String(target.name || "").trim() || "Playlist"
        : playlistName(target.playlistId);
      const change = {
        key: ++nextKey,
        action: "move",
        sourceId: source.id,
        sourceName: source.name || "the playlist",
        targetId: creating ? null : target.playlistId,
        targetName,
        jobIds,
        label: describeTracks(tracks, jobIds),
        phase: "saving",
      };
      publish([...changes, change]);
      void submit(change, () =>
        moveStaticPlaylistTracks(
          source.id,
          jobIds,
          creating ? { name: targetName } : { playlistId: target.playlistId },
        ));
    },
    flush() {
      for (const change of changes.filter((entry) => entry.phase === "undo")) {
        commit(change.key);
        if (change.toastId) toast.removeToast(change.toastId);
      }
    },
  };
}

import { db } from "../../config/db-sqlite.js";
import { dbOps, userOps } from "../../db/helpers/index.js";
import { getBulkOperation, saveBulkOperation } from "./bulkOperationStore.js";
import { downloadTracker } from "../downloadJobs/downloadTracker.js";
import { flowPlaylistConfig, invalidateFlowPlaylistConfigCache, tracksShareMembership } from "./flowPlaylistConfig.js";
import {
  commitStaticPlaylistTracks,
  isStaticPlaylistSelectionCurrent,
  withStaticPlaylistRelease,
} from "./staticPlaylistJobs.js";
import { playlistManager } from "./playlistManager.js";
import { isArtistBlockedForUser } from "../discovery/feedback.js";

function persist(record) {
  record.updatedAt = Date.now();
  saveBulkOperation(record);
}

function persistMembership(operation) {
  try { return db.transaction(operation)(); }
  catch (error) {
    dbOps.invalidateSettingsCache();
    invalidateFlowPlaylistConfigCache();
    throw error;
  }
}

export async function processStaticPlaylistBulkOperation(operationId) {
  const record = getBulkOperation(operationId);
  if (!record || ["completed", "failed"].includes(record.state)) return record;
  let user = userOps.getUserById(record.ownerUserId);
  const source = user && flowPlaylistConfig.getStaticPlaylistForUser(user, record.sourcePlaylistId);
  if (!source || user.status !== "active") throw new Error("Source playlist access is no longer available");
  await withStaticPlaylistRelease([source.id, record.target?.playlistId].filter(Boolean), async () => {
    user = userOps.getUserById(record.ownerUserId);
    if (!user || user.status !== "active") throw new Error("Source playlist access is no longer available");
    const lockedSource = flowPlaylistConfig.getStaticPlaylistForUser(user, source.id);
    if (!lockedSource) throw new Error("Source playlist access is no longer available");
    record.state = "running";
    persist(record);
    let target = null;
    let creatingTarget = false;
    if (record.action === "move") {
      target = flowPlaylistConfig.getStaticPlaylist(record.target.playlistId);
      if (!target && record.target.create) {
        creatingTarget = true;
        target = { id: record.target.playlistId, name: record.target.name, ownerUserId: user.id, tracks: [] };
      }
      if (!target || !flowPlaylistConfig.canUserAccessStaticPlaylist(user, target) || target.id === source.id) {
        throw new Error("Destination playlist access is no longer available");
      }
    }
    const finished = new Set(record.outcomes.map((outcome) => outcome.jobId));
    const remaining = record.selections.filter((selection) => !finished.has(selection.jobId));
    const eligible = [];
    const rejected = [];
    for (const selection of remaining) {
      const job = downloadTracker.getJob(selection.jobId);
      if (target && !job) {
        rejected.push({ jobId: selection.jobId, status: "alreadyAbsent" });
      } else if (!isStaticPlaylistSelectionCurrent(selection, lockedSource)) {
        rejected.push(job
          ? { jobId: selection.jobId, status: "failed", message: "The selected membership changed. Select the track again." }
          : { jobId: selection.jobId, status: "alreadyAbsent" });
      } else if (target && job && target.tracks.some((track) => tracksShareMembership(track, job) && track.jobId !== job.id)) {
        rejected.push({ jobId: selection.jobId, status: "failed", message: "The destination already contains a separate membership for this track. The source was kept." });
      } else if (target && job && isArtistBlockedForUser(target.ownerUserId, job)) {
        rejected.push({ jobId: selection.jobId, status: "failed", message: "The destination owner has blocked this artist." });
      } else eligible.push(selection);
    }
    if (target && eligible.length) {
      const tracks = eligible
        .map((selection) => lockedSource.tracks.find((track) => track.jobId === selection.jobId))
        .filter(Boolean)
        .map(({ membershipId: _membershipId, ...track }) => track);
      target = persistMembership(() => {
        const result = creatingTarget
          ? flowPlaylistConfig.createStaticPlaylist({ id: target.id, name: target.name, ownerUserId: user.id, tracks })
          : flowPlaylistConfig.appendStaticPlaylistTracks(target.id, tracks);
        if (!result || !tracks.every((track) => result.tracks.some((entry) => entry.jobId === track.jobId))) {
          throw new Error("Could not persist destination membership");
        }
        record.synchronization[target.id] = false;
        persist(record);
        return result;
      });
    }
    const removedJobIds = new Set(eligible.map((selection) => selection.jobId));
    await commitStaticPlaylistTracks({
      playlistId: source.id,
      tracks: lockedSource.tracks.filter((track) => !removedJobIds.has(track.jobId)),
      deleteFiles: record.action === "remove",
      onCommitted(outcomes) {
        record.outcomes.push(...rejected, ...outcomes.map((outcome) => ({ ...outcome,
          ...(target && outcome.status === "removed" ? { status: "moved", targetPlaylistId: target.id } : {}),
        })));
        if (eligible.length) record.synchronization[source.id] = false;
        record.outcomes.sort((a, b) => record.selections.findIndex((selection) => selection.jobId === a.jobId) - record.selections.findIndex((selection) => selection.jobId === b.jobId));
        persist(record);
      },
    });
  });
  playlistManager.updateConfig(false);
  for (const [id, synchronized] of Object.entries(record.synchronization)) {
    if (synchronized) continue;
    await playlistManager.refreshPlaylist(id);
    record.synchronization[id] = true;
    persist(record);
  }
  if (Object.keys(record.synchronization).length && !record.scanScheduled) {
    await playlistManager.scheduleScanLibrary(true);
    record.scanScheduled = true;
    persist(record);
  }
  record.state = "completed";
  delete record.message;
  persist(record);
  return record;
}

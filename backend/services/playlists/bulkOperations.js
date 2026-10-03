import { finalizeRetainedPlaylistRelocations } from "./mediaRelocation.js";
import { downloadWorker } from "../downloadJobs/downloadWorker.js";
import { db } from "../../config/db-sqlite.js";
import { dbOps, userOps } from "../../db/helpers/index.js";
import { getBulkOperation, saveBulkOperation } from "./bulkOperationStore.js";
import { downloadTracker } from "../downloadJobs/downloadTracker.js";
import { flowPlaylistConfig, invalidateFlowPlaylistConfigCache, tracksShareMembership } from "./flowPlaylistConfig.js";
import { withStaticPlaylistRemovalMutation, isStaticPlaylistSelectionCurrent, removeStaticPlaylistSelectionsLocked } from "./trackRemoval.js";
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
  await withStaticPlaylistRemovalMutation({ playlistId: source.id,
    jobIds: record.selections.map((selection) => selection.jobId), extraPlaylistIds: [record.target?.playlistId],
  }, async () => {
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
      if (target && (!job || !isStaticPlaylistSelectionCurrent(selection, lockedSource, job))) {
        rejected.push({ jobId: selection.jobId, status: job ? "failed" : "alreadyAbsent", message: "The selected membership changed. Select the track again." });
      } else if (target && job && target.tracks.some((track) => tracksShareMembership(track, job) && track.canonicalJobId !== job.id)) {
        rejected.push({ jobId: selection.jobId, status: "failed", message: "The destination already contains a separate membership for this track. The source was kept." });
      } else if (target && job && isArtistBlockedForUser(target.ownerUserId, job)) {
        rejected.push({ jobId: selection.jobId, status: "failed", message: "The destination owner has blocked this artist." });
      } else eligible.push(selection);
    }
    if (target && eligible.length) {
      const tracks = eligible.map((selection) => {
        const job = downloadTracker.getJob(selection.jobId);
        return job && { ...job, canonicalJobId: job.id };
      }).filter(Boolean);
      target = persistMembership(() => {
        const result = creatingTarget
          ? flowPlaylistConfig.createStaticPlaylist({ id: target.id, name: target.name, ownerUserId: user.id, tracks })
          : flowPlaylistConfig.appendStaticPlaylistTracks(target.id, tracks);
        if (!result || !tracks.every((track) => result.tracks.some((entry) => tracksShareMembership(entry, track) && entry.canonicalJobId === track.canonicalJobId))) {
          throw new Error("Could not persist destination membership");
        }
        record.synchronization[target.id] = false;
        persist(record);
        return result;
      });
    }
    await removeStaticPlaylistSelectionsLocked({
      playlistId: source.id, selections: eligible, deleteFiles: record.action === "remove",
      onCommitted(outcomes, affectedPlaylistIds) {
        record.outcomes.push(...rejected, ...outcomes.map((outcome) => ({ ...outcome,
          ...(target && outcome.status === "removed" ? { status: "moved", targetPlaylistId: target.id } : {}),
        })));
        for (const id of affectedPlaylistIds) record.synchronization[id] = false;
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
  await finalizeRetainedPlaylistRelocations(record.sourcePlaylistId, { downloadRoot: downloadWorker.downloadRoot });
  record.state = "completed";
  delete record.message;
  persist(record);
  return record;
}

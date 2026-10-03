import { logger } from "./logger.js";

export function getPayloadCandidate(payload) {
  const candidateIndex = Number(payload?.candidateIndex || 0);
  return (
    payload?.candidate ||
    (Array.isArray(payload?.candidates)
      ? payload.candidates[candidateIndex]
      : null)
  );
}

export function hasNextCandidate(payload) {
  return (
    Number(payload?.candidateIndex || 0) + 1 <
    (Array.isArray(payload?.candidates) ? payload.candidates.length : 0)
  );
}

export function buildNextCandidatePayload(payload, sourceResetFields = {}) {
  return {
    ...payload,
    phase: "download",
    candidate: null,
    candidateIndex: Number(payload?.candidateIndex || 0) + 1,
    pollAttempts: 0,
    ...sourceResetFields,
  };
}

export function mergeSearchResults(aggregated, seen, items, buildKey) {
  for (const item of items) {
    const key = buildKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    aggregated.push(item);
  }
}

export function blockPipelineJobForReview({
  downloadTracker,
  job,
  validation,
  sourcePath,
}) {
  const stagingPath = String(sourcePath || "").trim();
  if (!validation?.blocked || !stagingPath) return false;
  const reason = validation.reason || "Blocked for review";
  if (!downloadTracker.setBlocked(job.id, reason, stagingPath)) return false;
  import("./aurralHistoryService.js")
    .then(({ recordTrackJobBlocked }) => recordTrackJobBlocked(job, reason))
    .catch((error) => {
      logger.warn("history", "Could not record blocked download job", {
        jobId: job.id,
        reason: error?.message || String(error),
      });
    });
  return true;
}

export async function finalizePipelineJobSuccess(options) {
  if (await recordPipelineJobSuccess(options)) {
    await refreshCompletedPipelinePlaylist(options.job);
  }
  return null;
}

export async function recordPipelineJobSuccess({
  downloadTracker,
  job,
  committedFinalPath,
  album,
  quality,
  onSuccess,
}) {
  if (job.upgradeForJobId) {
    const { finalizeQualityUpgradeSuccess } = await import("./qualityProfileService.js");
    if (onSuccess) await onSuccess();
    await finalizeQualityUpgradeSuccess(job, committedFinalPath, quality);
    return false;
  }
  if (downloadTracker.setDone(job.id, committedFinalPath, album) === false) return false;
  if (quality) downloadTracker.updateQuality(job.id, quality);

  if (job.playlistType === "library" && job.managedBy === "aurral" && committedFinalPath) {
    const { scheduleLibraryScan } = await import("./libraryScanWorker.js");
    scheduleLibraryScan({
      includeLidarr: false,
      changedPaths: [committedFinalPath],
    });
  }

  if (onSuccess) await onSuccess();

  import("./aurralHistoryService.js")
    .then(({ recordTrackJobCompleted }) => recordTrackJobCompleted(job))
    .catch((error) => {
      logger.warn("history", "Could not record completed download job", {
        jobId: job.id,
        reason: error?.message || String(error),
      });
    });
  return true;
}

export async function refreshCompletedPipelinePlaylist(job) {
  const playlistType = job.playlistId || job.playlistType;
  const { playlistManager } = await import("./playlists/playlistManager.js");
  await playlistManager.refreshPlaylist(playlistType);
  const { downloadWorker } = await import("./downloadJobs/downloadWorker.js");
  downloadWorker.wake(0);
  await downloadWorker.checkPlaylistComplete(playlistType);
}

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
    .catch(() => {});
  return true;
}

export async function finalizePipelineJobSuccess({
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
    return finalizeQualityUpgradeSuccess(job, committedFinalPath, quality);
  }
  downloadTracker.setDone(job.id, committedFinalPath, album);
  if (quality) downloadTracker.updateQuality(job.id, quality);

  if (onSuccess) await onSuccess();

  import("./aurralHistoryService.js")
    .then(({ recordTrackJobCompleted }) => recordTrackJobCompleted(job))
    .catch(() => {});

  const playlistType = job.playlistId || job.playlistType;
  const { playlistManager } = await import("./weeklyFlow/weeklyFlowPlaylistManager.js");
  await playlistManager.refreshPlaylist(playlistType);
  playlistManager.scheduleScanLibrary();
  const { weeklyFlowWorker } = await import("./weeklyFlow/weeklyFlowWorker.js");
  weeklyFlowWorker.wake(0);
  await weeklyFlowWorker.checkPlaylistComplete(playlistType);
  return null;
}

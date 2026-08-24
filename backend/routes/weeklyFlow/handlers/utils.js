import { downloadTracker } from "../../../services/weeklyFlow/weeklyFlowDownloadTracker.js";
import { weeklyFlowWorker } from "../../../services/weeklyFlow/weeklyFlowWorker.js";
import {
  DEFAULT_SIZE,
  flowPlaylistConfig,
} from "../../../services/weeklyFlow/weeklyFlowPlaylistConfig.js";
import { weeklyFlowOperationQueue } from "../../../services/weeklyFlow/weeklyFlowOperationQueue.js";
import {
  createWeeklyFlowOperationToken,
  markLatestWeeklyFlowOperationToken,
} from "../../../services/weeklyFlow/weeklyFlowOperations.js";
import {
  restartWorkerIfPending,
  withPlaylistMutation,
} from "../../../services/weeklyFlow/weeklyFlowMutationGuards.js";
import {
  getUnavailableFlowSourceError,
  normalizeFlowMixForValidation,
} from "../../../services/weeklyFlow/weeklyFlowValidation.js";
import { logger } from "../../../services/logger.js";

export const EXISTING_FILE_MODE_OPTIONS = ["download", "reuse"];
export const AUDIO_CONTENT_TYPES = {
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
};
export const DEFAULT_LIMIT = DEFAULT_SIZE;

const getFlowEntryName = (value) => {
  if (typeof value === "string" || typeof value === "number") {
    const text = String(value).trim();
    return text || null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const candidates = [
    value.name,
    value.artistName,
    value.artist,
    value.tag,
    value.label,
    value.value,
  ];
  for (const candidate of candidates) {
    const text = String(candidate || "").trim();
    if (text) return text;
  }
  return null;
};

export const normalizeFlowStringArray = (value) => {
  if (Array.isArray(value)) {
    return [
      ...new Set(
        value.map((entry) => getFlowEntryName(entry)).filter(Boolean),
      ),
    ];
  }
  if (value && typeof value === "object") {
    return [
      ...new Set(
        Object.keys(value)
          .map((entry) => String(entry || "").trim())
          .filter(Boolean),
      ),
    ];
  }
  const single = getFlowEntryName(value);
  return single ? [single] : [];
};

export const validateFlowPayload = ({
  name,
  mix,
  size,
  tags,
  relatedArtists,
  scheduleDays,
  recordHistory,
  yearFrom,
  yearTo,
} = {}) => {
  if (!name || !String(name).trim()) {
    return "name is required";
  }
  const parsedSize = Number(size);
  if (!Number.isFinite(parsedSize) || parsedSize <= 0) {
    return "size must be a positive number";
  }
  const normalizedMix = normalizeFlowMixForValidation(mix);
  const totalWeight = Object.values(normalizedMix).reduce((sum, value) => sum + value, 0);
  if (totalWeight <= 0) {
    return "at least one source must be enabled";
  }
  const unavailableError = getUnavailableFlowSourceError(normalizedMix);
  if (unavailableError) return unavailableError;
  const normalizedTags = normalizeFlowStringArray(tags);
  const normalizedRelated = normalizeFlowStringArray(relatedArtists);
  if (normalizedMix.focus > 0 && normalizedTags.length === 0 && normalizedRelated.length === 0) {
    return "Focus needs at least one genre tag or related artist";
  }
  if (!Array.isArray(scheduleDays) || scheduleDays.length === 0) {
    return "scheduleDays must include at least one day";
  }
  if (recordHistory !== undefined && typeof recordHistory !== "boolean") {
    return "recordHistory must be a boolean";
  }
  const hasYearFrom = yearFrom != null && String(yearFrom).trim() !== "";
  const hasYearTo = yearTo != null && String(yearTo).trim() !== "";
  if (hasYearFrom) {
    const parsed = Number(yearFrom);
    if (!Number.isFinite(parsed) || Math.trunc(parsed) < 1000 || Math.trunc(parsed) > 9999) {
      return "yearFrom must be a 4-digit year";
    }
  }
  if (hasYearTo) {
    const parsed = Number(yearTo);
    if (!Number.isFinite(parsed) || Math.trunc(parsed) < 1000 || Math.trunc(parsed) > 9999) {
      return "yearTo must be a 4-digit year";
    }
  }
  return null;
};

export const markFlowMutationToken = (flowId) => {
  const token = createWeeklyFlowOperationToken();
  const tokenScope = `flow:${flowId}:mutation`;
  markLatestWeeklyFlowOperationToken(tokenScope, token);
  return { token, tokenScope };
};

export const pauseSharedPlaylistRetryCycle = async (playlistId) => {
  weeklyFlowWorker.setRetryCyclePaused(playlistId, true);
  let cancelledJobs = 0;
  await withPlaylistMutation(playlistId, async () => {
    cancelledJobs = downloadTracker.failActiveJobsForPlaylist(
      playlistId,
      "Retry cycle paused",
    );
  });
  if (weeklyFlowWorker.running) {
    weeklyFlowWorker.wake();
  } else {
    await restartWorkerIfPending();
  }
  return cancelledJobs;
};

export const getAccessibleFlow = (user, flowId) =>
  flowPlaylistConfig.getFlowForUser(user, flowId);

export const getAccessibleSharedPlaylist = (user, playlistId) =>
  flowPlaylistConfig.getSharedPlaylistForUser(user, playlistId);

export const canAccessPlaylistType = (user, playlistType) => {
  const key = String(playlistType || "").trim();
  if (!key) return false;
  const flow = flowPlaylistConfig.getFlow(key);
  if (flow) {
    return flowPlaylistConfig.canUserAccessFlow(user, flow);
  }
  const sharedPlaylist = flowPlaylistConfig.getSharedPlaylist(key);
  if (sharedPlaylist) {
    return flowPlaylistConfig.canUserAccessSharedPlaylist(user, sharedPlaylist);
  }
  return false;
};

export const filterJobsForUser = (user, jobs) =>
  (Array.isArray(jobs) ? jobs : []).filter((job) =>
    canAccessPlaylistType(user, job?.playlistId || job?.playlistType),
  );

export const queueFlowSideEffect = (kind, labelPrefix, flowId) => {
  const { token, tokenScope } = markFlowMutationToken(flowId);
  weeklyFlowOperationQueue
    .enqueuePayload({
      kind,
      label: `${labelPrefix}:${flowId}`,
      flowId,
      tokenScope,
      token,
    })
    .catch((error) => {
      logger.error("weeklyFlow", `Failed to ${labelPrefix} flow ${flowId}:`, { message: error.message });
    });
};

export const enqueueResearchTrack = async (req, res, playlistId, jobId, labelPrefix) => {
  if (!canAccessPlaylistType(req.user, playlistId)) {
    return res.status(404).json({ error: "Playlist not found" });
  }

  const job = downloadTracker.getJob(jobId);
  if (!job || job.playlistType !== playlistId) {
    return res.status(404).json({ error: "Track not found" });
  }

  if (job.status === "pending" || job.status === "downloading") {
    return res.status(409).json({
      error: "Track is already being processed",
    });
  }

  const result = await weeklyFlowOperationQueue.enqueuePayload({
    kind: "shared-playlist-research-track",
    label: `${labelPrefix}:${playlistId}:track:${jobId}:research`,
    playlistId,
    jobId,
  });

  return res.json({
    success: true,
    jobId,
    playlistId,
    queued: true,
    operationId: result.operationId,
  });
};

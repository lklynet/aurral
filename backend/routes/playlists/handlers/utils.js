import { downloadTracker } from "../../../services/downloadJobs/downloadTracker.js";
import { downloadWorker } from "../../../services/downloadJobs/downloadWorker.js";
import {
  DEFAULT_SIZE,
  flowPlaylistConfig,
} from "../../../services/playlists/flowPlaylistConfig.js";
import { playlistOperationQueue } from "../../../services/playlists/playlistOperationQueue.js";
import {
  createPlaylistOperationToken,
  getLatestPlaylistOperationToken,
  markLatestPlaylistOperationToken,
  restorePlaylistOperationToken,
} from "../../../services/playlists/playlistOperations.js";
import {
  restartWorkerIfPending,
  withPlaylistMutation,
} from "../../../services/downloadJobs/mutationGuards.js";
import { normalizeFlowMixForValidation } from "../../../services/flows/flowValidation.js";
import { logger } from "../../../services/logger.js";
import { isDownloadJobCancelled } from "../../../services/downloadJobs/downloadCancellation.js";

export const EXISTING_FILE_MODE_OPTIONS = ["download", "reuse"];
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
  showInLibrary,
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
  if (showInLibrary !== undefined && typeof showInLibrary !== "boolean") {
    return "showInLibrary must be a boolean";
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
  const tokenScope = `flow:${flowId}:mutation`;
  const previousToken = getLatestPlaylistOperationToken(tokenScope);
  const token = createPlaylistOperationToken();
  markLatestPlaylistOperationToken(tokenScope, token);
  return { token, tokenScope, previousToken };
};

export const isFlowMutationTokenCurrent = (mutation) =>
  Boolean(mutation?.token) &&
  getLatestPlaylistOperationToken(mutation.tokenScope) === mutation.token;

export const restoreFlowMutationToken = (mutation) =>
  restorePlaylistOperationToken({
    scope: mutation?.tokenScope,
    token: mutation?.token,
    previousToken: mutation?.previousToken,
  });

export const pauseStaticPlaylistRetryCycle = async (playlistId) => {
  await downloadWorker.setRetryCyclePaused(playlistId, true);
  let cancelledJobs = 0;
  await withPlaylistMutation(playlistId, async () => {
    cancelledJobs = downloadTracker.failActiveJobsForPlaylist(
      playlistId,
      "Retry cycle paused",
    );
  });
  if (downloadWorker.running) {
    downloadWorker.wake();
  } else {
    await restartWorkerIfPending();
  }
  return cancelledJobs;
};

export const getAccessibleFlow = (user, flowId) =>
  flowPlaylistConfig.getFlowForUser(user, flowId);

export const getAccessibleStaticPlaylist = (user, playlistId) =>
  flowPlaylistConfig.getStaticPlaylistForUser(user, playlistId);

export const canAccessPlaylistType = (user, playlistType) => {
  const key = String(playlistType || "").trim();
  if (!key) return false;
  const flow = flowPlaylistConfig.getFlow(key);
  if (flow) {
    return flowPlaylistConfig.canUserAccessFlow(user, flow);
  }
  const staticPlaylist = flowPlaylistConfig.getStaticPlaylist(key);
  if (staticPlaylist) {
    return flowPlaylistConfig.canUserAccessStaticPlaylist(user, staticPlaylist);
  }
  return false;
};

export const LIBRARY_JOB_TYPE = "library";

export const canAccessJobType = (user, playlistType) =>
  playlistType === LIBRARY_JOB_TYPE || canAccessPlaylistType(user, playlistType);

export const filterJobsForUser = (user, jobs) =>
  (Array.isArray(jobs) ? jobs : []).filter((job) =>
    canAccessJobType(user, job?.playlistId || job?.playlistType),
  );

export const queueFlowSideEffect = (kind, labelPrefix, flowId) => {
  const mutation = markFlowMutationToken(flowId);
  const { token, tokenScope } = mutation;
  playlistOperationQueue
    .enqueuePayload({
      kind,
      label: `${labelPrefix}:${flowId}`,
      flowId,
      tokenScope,
      token,
    })
    .catch((error) => {
      restoreFlowMutationToken(mutation);
      logger.error("flows", `Failed to ${labelPrefix} flow ${flowId}:`, { message: error.message });
    });
};

export const enqueueResearchTrack = async (req, res, playlistId, jobId, labelPrefix) => {
  if (!canAccessJobType(req.user, playlistId)) {
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
  if (job.status === "cancel_requested") {
    return res.status(409).json({ error: "Track cancellation is still in progress" });
  }
  if (job.requestGroupId && isDownloadJobCancelled(job.id)) {
    return res.status(409).json({ error: "Cancelled album tracks cannot be searched again. Request the album again." });
  }
  if (downloadTracker.findActiveUpgradeJob(job)) {
    return res.status(409).json({
      error: "A search for this track is already running",
    });
  }

  const result = await playlistOperationQueue.enqueuePayload({
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

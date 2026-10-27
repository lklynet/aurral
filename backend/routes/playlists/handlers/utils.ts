import { downloadTracker } from "../../../services/downloadJobs/downloadTracker.ts";
import { downloadWorker } from "../../../services/downloadJobs/downloadWorker.ts";
import {
  DEFAULT_SIZE,
  flowPlaylistConfig,
} from "../../../services/playlists/flowPlaylistConfig.ts";
import { playlistOperationQueue } from "../../../services/playlists/playlistOperationQueue.ts";
import {
  createPlaylistOperationToken,
  getLatestPlaylistOperationToken,
  markLatestPlaylistOperationToken,
  restorePlaylistOperationToken,
} from "../../../services/playlists/playlistOperations.ts";
import {
  restartWorkerIfPending,
  withPlaylistMutation,
} from "../../../services/downloadJobs/mutationGuards.ts";
import { normalizeFlowMixForValidation } from "../../../services/flows/flowValidation.ts";
import { logger } from "../../../services/logger.ts";
import { isDownloadJobCancelled } from "../../../services/downloadJobs/downloadCancellation.ts";
import { hasPermission } from "../../../middleware/auth.ts";
import { requirePermission } from "../../../middleware/guards.ts";
import { createMiddleware } from "hono/factory";
import * as v from "valibot";
import type { Context } from "hono";
import type { StoredFlow } from "../../../services/playlists/flowPlaylistConfig.ts";
import type { DownloadJob } from "../../../services/downloadJobs/downloadTracker.ts";
import type { AppEnv, RequestUser } from "../../../middleware/requestUser.ts";

export const requireFlowAccess = requirePermission("accessFlow");

export const requireFlowAccessIfSignedIn = createMiddleware<AppEnv>(async (c, next) => {
  const user = c.get("user");
  if (user && !hasPermission(user, "accessFlow")) {
    return c.json({ error: "Forbidden", message: "Permission required: accessFlow" }, 403);
  }
  await next();
});

export const EXISTING_FILE_MODE_OPTIONS = ["download", "reuse"];
export const DEFAULT_LIMIT = DEFAULT_SIZE;

type FlowEntryObject = {
  name?: unknown;
  artistName?: unknown;
  artist?: unknown;
  tag?: unknown;
  label?: unknown;
  value?: unknown;
};

type FlowEntry = FlowEntryObject | string | number | boolean | null | undefined;

const getFlowEntryName = (value: FlowEntry) => {
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

export const normalizeFlowStringArray = (value: unknown) => {
  if (Array.isArray(value)) {
    return [...new Set(value.map((entry) => getFlowEntryName(entry)).filter(Boolean))];
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
  const single = getFlowEntryName(value as FlowEntry);
  return single ? [single] : [];
};

type FlowPayload = Pick<
  StoredFlow,
  | "name"
  | "mix"
  | "size"
  | "tags"
  | "relatedArtists"
  | "scheduleDays"
  | "recordHistory"
  | "showInLibrary"
  | "yearFrom"
  | "yearTo"
>;

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
}: FlowPayload = {}) => {
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

export const markFlowMutationToken = (flowId: string) => {
  const tokenScope = `flow:${flowId}:mutation`;
  const previousToken = getLatestPlaylistOperationToken(tokenScope);
  const token = createPlaylistOperationToken();
  markLatestPlaylistOperationToken(tokenScope, token);
  return { token, tokenScope, previousToken };
};

type FlowMutation = ReturnType<typeof markFlowMutationToken>;

export const isFlowMutationTokenCurrent = (mutation: FlowMutation) =>
  Boolean(mutation?.token) &&
  getLatestPlaylistOperationToken(mutation.tokenScope) === mutation.token;

export const restoreFlowMutationToken = (mutation: FlowMutation) =>
  restorePlaylistOperationToken({
    scope: mutation?.tokenScope,
    token: mutation?.token,
    previousToken: mutation?.previousToken,
  });

export const pauseStaticPlaylistRetryCycle = async (playlistId: string) => {
  await downloadWorker.setRetryCyclePaused(playlistId, true);
  let cancelledJobs = 0;
  await withPlaylistMutation(playlistId, async () => {
    cancelledJobs = downloadTracker.failActiveJobsForPlaylist(playlistId, "Retry cycle paused");
  });
  if (downloadWorker.running) {
    downloadWorker.wake();
  } else {
    await restartWorkerIfPending();
  }
  return cancelledJobs;
};

export const getAccessibleFlow = (user: RequestUser | undefined, flowId: string) =>
  flowPlaylistConfig.getFlowForUser(user, flowId);

export const getAccessibleStaticPlaylist = (user: RequestUser | undefined, playlistId: string) =>
  flowPlaylistConfig.getStaticPlaylistForUser(user, playlistId);

export const canAccessPlaylistType = (
  user: RequestUser | undefined,
  playlistType: string | null | undefined,
) => {
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

export const canAccessJobType = (
  user: RequestUser | undefined,
  playlistType: string | null | undefined,
) => playlistType === LIBRARY_JOB_TYPE || canAccessPlaylistType(user, playlistType);

export const filterJobsForUser = <T extends Pick<DownloadJob, "playlistId" | "playlistType">>(
  user: RequestUser | undefined,
  jobs: T[] | null | undefined,
) =>
  (Array.isArray(jobs) ? jobs : []).filter((job) =>
    canAccessJobType(user, job?.playlistId || job?.playlistType),
  );

export const queueFlowSideEffect = (kind: string, labelPrefix: string, flowId: string) => {
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

export function canAccessJobThroughPlaylist(
  user: RequestUser | undefined,
  job: DownloadJob,
  playlistId: unknown,
) {
  const safePlaylistId = String(playlistId || "").trim();
  if (!safePlaylistId) return filterJobsForUser(user, [job]).length > 0;
  if (!canAccessJobType(user, safePlaylistId)) return false;
  if (job.playlistType === safePlaylistId || job.playlistId === safePlaylistId) return true;
  const staticPlaylist = flowPlaylistConfig.getStaticPlaylist(safePlaylistId);
  return (
    staticPlaylist?.tracks?.some(
      (track) => String(track?.canonicalJobId || "") === String(job.id || ""),
    ) === true
  );
}

export const enqueueResearchTrack = async <E extends AppEnv>(
  c: Context<E>,
  user: RequestUser,
  playlistId: string,
  jobId: string,
  labelPrefix: string,
) => {
  if (!canAccessJobType(user, playlistId)) {
    return c.json({ error: "Playlist not found" }, 404);
  }

  const job = downloadTracker.getJob(jobId);
  if (!job || job.playlistType !== playlistId) {
    return c.json({ error: "Track not found" }, 404);
  }

  if (job.status === "pending" || job.status === "downloading") {
    return c.json({ error: "Track is already being processed" }, 409);
  }
  if (job.status === "cancel_requested") {
    return c.json({ error: "Track cancellation is still in progress" }, 409);
  }
  if (job.requestGroupId && isDownloadJobCancelled(job.id)) {
    return c.json(
      { error: "Cancelled album tracks cannot be searched again. Request the album again." },
      409,
    );
  }
  if (downloadTracker.findActiveUpgradeJob(job)) {
    return c.json({ error: "A search for this track is already running" }, 409);
  }

  const result = await playlistOperationQueue.enqueuePayload({
    kind: "shared-playlist-research-track",
    label: `${labelPrefix}:${playlistId}:track:${jobId}:research`,
    playlistId,
    jobId,
  });

  return c.json(
    { success: true, jobId, playlistId, queued: true, operationId: result.operationId },
    200,
  );
};

export const importSettings = {
  name: v.string(),
  syncIntervalHours: v.nullish(v.union([v.number(), v.string()])),
  syncEnabled: v.nullish(v.boolean()),
  keepRemovedTracks: v.nullish(v.boolean()),
};

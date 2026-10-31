import { downloadTracker } from "../../../services/downloadJobs/downloadTracker.ts";
import { DEFAULT_FLOW_SIZE } from "../../../../lib/flows.ts";
import { downloadWorker } from "../../../services/downloadJobs/downloadWorker.ts";
import { flowPlaylistConfig } from "../../../services/playlists/flowPlaylistConfig.ts";
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
import { splitFlowTotal } from "../../../../lib/flows.ts";
import { logger } from "../../../services/logger.ts";
import { isDownloadJobCancelled } from "../../../services/downloadJobs/downloadCancellation.ts";
import { hasPermission } from "../../../middleware/auth.ts";
import { requirePermission } from "../../../middleware/guards.ts";
import { createMiddleware } from "hono/factory";
import * as v from "valibot";
import type { Context } from "hono";
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
export const DEFAULT_LIMIT = DEFAULT_FLOW_SIZE;

const fourDigitYear = (label: string) =>
  v.optional(
    v.pipe(
      v.unknown(),
      v.transform((value) =>
        value == null || String(value).trim() === "" ? null : Math.trunc(Number(value)),
      ),
      v.nullable(
        v.pipe(
          v.number(`${label} must be a 4-digit year`),
          v.minValue(1000, `${label} must be a 4-digit year`),
          v.maxValue(9999, `${label} must be a 4-digit year`),
        ),
      ),
    ),
  );

const hasText = (values: unknown) =>
  Array.isArray(values) && values.some((value) => String(value ?? "").trim() !== "");

const flowRules = v.pipe(
  v.looseObject({
    name: v.pipe(v.string("name is required"), v.trim(), v.nonEmpty("name is required")),
    size: v.pipe(
      v.union([v.number(), v.string()], "size must be a positive number"),
      v.transform(Number),
      v.number("size must be a positive number"),
      v.finite("size must be a positive number"),
      v.gtValue(0, "size must be a positive number"),
    ),
    mix: v.nullish(v.record(v.string(), v.unknown())),
    scheduleDays: v.pipe(
      v.array(v.unknown(), "scheduleDays must include at least one day"),
      v.nonEmpty("scheduleDays must include at least one day"),
    ),
    yearFrom: fourDigitYear("yearFrom"),
    yearTo: fourDigitYear("yearTo"),
  }),
  v.check(
    ({ mix, size }) => splitFlowTotal(mix, Math.round(size)) != null,
    "at least one source must be enabled",
  ),
  v.check(
    (flow) =>
      !splitFlowTotal(flow.mix, Math.round(flow.size))?.focus ||
      flow.recentListening === true ||
      hasText(flow.tags) ||
      hasText(flow.relatedArtists),
    "Focus needs a tag, a similar artist, or recent listening",
  ),
);

export const flowPayloadError = (payload: unknown) => {
  const result = v.safeParse(flowRules, payload);
  return result.success ? null : result.issues[0].message;
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

import { Hono } from "hono";
import * as v from "valibot";
import path from "path";
import { downloadTracker } from "../../../services/downloadJobs/downloadTracker.ts";
import { downloadWorker } from "../../../services/downloadJobs/downloadWorker.ts";
import {
  flowPlaylistConfig,
  orderJobsByPlaylistTracks,
} from "../../../services/playlists/flowPlaylistConfig.ts";
import { getPlaylistStatusSnapshot } from "../../../services/playlists/playlistStatusSnapshot.ts";
import { indexUnmonitoredJobs } from "../../../services/aurralUnmonitoredJobs.ts";
import { noCache } from "../../../middleware/cacheHeaders.ts";
import { requireAdmin, requireAuth } from "../../../middleware/guards.ts";
import { hasPermission } from "../../../middleware/auth.ts";
import {
  ACTIVE_JOB_STATUSES,
  RETRYABLE_JOB_STATUSES,
  cancelTrackDownload,
  retryTrackDownload,
} from "../../../services/aurralAlbumJobs.ts";
import { getTrackJobRequesterId } from "../../../services/aurralHistoryService.ts";
import {
  LIBRARY_JOB_TYPE,
  canAccessJobThroughPlaylist,
  canAccessJobType,
  canAccessPlaylistType,
  filterJobsForUser,
  requireFlowAccess,
} from "./utils.ts";
import {
  approveBlockedJob,
  denyBlockedJob,
} from "../../../services/downloadJobs/blockedJobReview.ts";
import { invalidateRequestsCache } from "../../requests.ts";
import {
  decorateJobQuality,
  getQualityProfile,
  isAurralOwnedPath,
  queueQualityUpgrade,
  runQualityUpgradeCheck,
} from "../../../services/qualityProfileService.ts";
import { getLibraryTrackOwnershipBatch } from "../../../services/libraryQueryService.ts";
import { logger, safeLogDiagnostic } from "../../../services/logger.ts";
import {
  isDownloadOwnerProcess,
  requestDownloadOwner,
} from "../../../services/downloadJobs/downloadOwnerClient.ts";
import {
  createManualMissingSearch,
  consumeManualMissingSelection,
  getManualMissingSelection,
  getManualDownloadSources,
} from "../../../services/manualMissingSearchService.ts";
import {
  buildCustomArtworkUrl,
  getCustomArtworkMap,
} from "../../../services/customArtworkService.ts";
import { asAppError } from "../../../../lib/errors.ts";
import { validate } from "../../../middleware/validate.ts";
import { isErrorStatus } from "../../shared/errorStatus.ts";
import type { Context } from "hono";
import type { AppEnv, RequestUser } from "../../../middleware/requestUser.ts";
import type { DownloadJob } from "../../../services/downloadJobs/downloadTracker.ts";

const getAccessiblePlaylistIds = (user: RequestUser | undefined) => [
  ...new Set(
    [
      ...flowPlaylistConfig.getFlowsForUser(user),
      ...flowPlaylistConfig.getStaticPlaylistsForUser(user),
    ].map((playlist) => playlist.id),
  ),
];

const BLOCKED_JOB_REVIEW_TIMEOUT_MS = 16 * 60 * 1000;
const reviewBlockedJobLocally = { approveBlockedJob, denyBlockedJob };

const getActorId = (user: RequestUser | undefined) =>
  String(user?.id || user?.username || "").trim();

function getManualSearchMode(value: unknown) {
  return String(value || "").trim() === "replacement" ? "replacement" : "missing";
}

type ManualSearchMode = ReturnType<typeof getManualSearchMode>;

type BlockedJobOutcome = Awaited<
  ReturnType<(typeof reviewBlockedJobLocally)[keyof typeof reviewBlockedJobLocally]>
>;

function getAccessibleManualSearchJob(
  user: RequestUser | undefined,
  jobId: string,
  { mode = "missing", playlistId = null }: { mode?: ManualSearchMode; playlistId?: unknown } = {},
) {
  const job = downloadTracker.getJob(jobId);
  if (!job || !canAccessJobThroughPlaylist(user, job, playlistId)) return null;
  if (mode === "replacement") {
    if (
      job.status !== "done" ||
      job.upgradeForJobId ||
      job.managedBy !== "aurral" ||
      !isAurralOwnedPath(job.finalPath) ||
      downloadTracker.findActiveUpgradeJob(job)
    ) {
      return null;
    }
    return job;
  }
  if (job.status !== "failed" || job.upgradeForJobId) return null;
  return job;
}

function toPublicJob(job: DownloadJob, profile: ReturnType<typeof getQualityProfile>) {
  const {
    stagingPath: _stagingPath,
    heldForReview: _heldForReview,
    finalPath,
    externalPath: _externalPath,
    ...publicJob
  } = decorateJobQuality(job, profile);
  const streamFormat = finalPath ? path.extname(finalPath).slice(1).toLowerCase() : "";
  return { ...publicJob, streamFormat: streamFormat || null };
}

const reviewBlockedJob = async <E extends AppEnv>(
  c: Context<E>,
  method: "approveBlockedJob" | "denyBlockedJob",
  jobId: string,
) => {
  try {
    const outcome = isDownloadOwnerProcess()
      ? await reviewBlockedJobLocally[method](jobId)
      : await requestDownloadOwner<BlockedJobOutcome>(method, [jobId], {
          timeoutMs: BLOCKED_JOB_REVIEW_TIMEOUT_MS,
        });
    if (outcome.status !== 200) {
      return c.json({ error: outcome.error }, isErrorStatus(outcome.status) ? outcome.status : 500);
    }
    invalidateRequestsCache();
    return c.json(
      { success: true, ...("path" in outcome && outcome.path ? { path: outcome.path } : {}) },
      200,
    );
  } catch (error) {
    return c.json(
      {
        error: method === "approveBlockedJob" ? "Import failed" : "Deny failed",
        message: asAppError(error)?.message,
      },
      500,
    );
  }
};

const getControllableJob = <E extends AppEnv>(c: Context<E>, user: RequestUser, jobId: string) => {
  const job = downloadTracker.getJob(jobId);
  if (!job) return { failure: c.json({ error: "Track not found" }, 404) };
  if (hasPermission(user, "accessFlow")) {
    if (!canAccessJobType(user, job.playlistId || job.playlistType)) {
      return { failure: c.json({ error: "Track not found" }, 404) };
    }
  } else {
    const ownsLibraryJob =
      job.playlistType === LIBRARY_JOB_TYPE &&
      user.id != null &&
      String(getTrackJobRequesterId(job.id)) === String(user.id);
    if (!ownsLibraryJob) return { failure: c.json({ error: "Forbidden" }, 403) };
  }
  return { job };
};

const queryValue = v.optional(v.union([v.string(), v.array(v.string())]));

const manualSearchQuery = v.object({
  mode: v.optional(v.string()),
  playlistId: v.optional(v.string()),
});

export default new Hono<AppEnv>()
  .basePath("/playlists")
  .get("/status", requireFlowAccess, noCache, (c) =>
    c.json(getPlaylistStatusSnapshot({ user: c.var.user }), 200),
  )
  .get(
    "/jobs/:playlistId",
    requireFlowAccess,
    noCache,
    validate("query", v.object({ limit: queryValue })),
    async (c) => {
      const playlistId = c.req.param("playlistId");
      const user = c.var.user;
      if (!canAccessPlaylistType(user, playlistId)) {
        return c.json({ error: "Playlist not found" }, 404);
      }
      const rawLimit = String(c.req.valid("query").limit ?? "").trim();
      const parsedLimit = Number(rawLimit);
      const limit =
        rawLimit && Number.isFinite(parsedLimit) && parsedLimit > 0
          ? Math.floor(parsedLimit)
          : null;
      const staticPlaylist = flowPlaylistConfig.getStaticPlaylist(playlistId);
      const staticPlaylistTracks = staticPlaylist?.tracks;
      let jobs = downloadTracker.getByPlaylistType(
        playlistId,
        staticPlaylistTracks?.length ? null : limit,
      );
      if (staticPlaylistTracks?.length) {
        const referencedJobIds = new Set<string>(
          staticPlaylistTracks.map((track) => String(track?.canonicalJobId || "")).filter(Boolean),
        );
        const referencedJobs = [...referencedJobIds]
          .map((jobId) => downloadTracker.getJob(jobId))
          .filter((job): job is DownloadJob => Boolean(job));
        jobs = [...referencedJobs, ...jobs].filter(
          (job, index, values) =>
            values.findIndex((candidate) => candidate.id === job.id) === index,
        );
        jobs = orderJobsByPlaylistTracks(jobs, staticPlaylistTracks);
        if (limit != null) jobs = jobs.slice(0, limit);
        jobs = jobs.map((job) =>
          referencedJobIds.has(job.id) && job.playlistType !== playlistId
            ? { ...job, playlistId: playlistId, playlistType: playlistId }
            : job,
        );
      }
      const profile = getQualityProfile();
      const accessibleJobs = filterJobsForUser(user, jobs);
      const libraryOwnership = getLibraryTrackOwnershipBatch(accessibleJobs);
      const customArtwork = getCustomArtworkMap(
        "playlist-track",
        accessibleJobs.map((job) => job.id),
      );
      return c.json(
        accessibleJobs.map((job, index) => ({
          ...toPublicJob(job, profile),
          libraryOwned: libraryOwnership[index] === true,
          ...(customArtwork.has(String(job.id))
            ? {
                artworkUrl: buildCustomArtworkUrl(
                  "playlist-track",
                  job.id,
                  customArtwork.get(String(job.id)),
                  { playlistId },
                ),
                customArtworkUrl: buildCustomArtworkUrl(
                  "playlist-track",
                  job.id,
                  customArtwork.get(String(job.id)),
                  { playlistId },
                ),
              }
            : {}),
        })),
        200,
      );
    },
  )
  .get(
    "/jobs",
    requireFlowAccess,
    noCache,
    validate("query", v.object({ status: queryValue })),
    (c) => {
      const { status } = c.req.valid("query");
      if (status !== undefined && typeof status !== "string") {
        return c.json({ error: "status must be a single value" }, 400);
      }
      const jobs = filterJobsForUser(
        c.var.user,
        status ? downloadTracker.getByStatus(status) : downloadTracker.getAll(),
      );
      const profile = getQualityProfile();
      const isUnmonitored = indexUnmonitoredJobs();
      const customArtwork = getCustomArtworkMap(
        "playlist-track",
        jobs.map((job) => job.id),
      );
      return c.json(
        jobs.map((job) => ({
          ...toPublicJob(job, profile),
          monitored: !isUnmonitored(job),
          ...(customArtwork.has(String(job.id))
            ? {
                artworkUrl: buildCustomArtworkUrl(
                  "playlist-track",
                  job.id,
                  customArtwork.get(String(job.id)),
                  { playlistId: job.playlistType || job.playlistId },
                ),
                customArtworkUrl: buildCustomArtworkUrl(
                  "playlist-track",
                  job.id,
                  customArtwork.get(String(job.id)),
                  { playlistId: job.playlistType || job.playlistId },
                ),
              }
            : {}),
        })),
        200,
      );
    },
  )
  .get("/jobs/:jobId/files", requireFlowAccess, requireAdmin, noCache, (c) => {
    const job = downloadTracker.getJob(c.req.param("jobId"));
    if (!job) return c.json({ error: "Track not found" }, 404);
    return c.json({ paths: job.finalPath ? [job.finalPath] : [] }, 200);
  })
  .get(
    "/jobs/:jobId/manual-search/sources",
    requireFlowAccess,
    noCache,
    validate("query", manualSearchQuery),
    (c) => {
      const query = c.req.valid("query");
      const job = getAccessibleManualSearchJob(c.var.user, c.req.param("jobId"), {
        mode: getManualSearchMode(query.mode),
        playlistId: query.playlistId,
      });
      if (!job) return c.json({ error: "Track is not available for manual search" }, 404);
      return c.json({ sources: getManualDownloadSources() }, 200);
    },
  )
  .post(
    "/jobs/:jobId/manual-search",
    requireFlowAccess,
    validate(
      "json",
      v.object({
        sourceId: v.string(),
        mode: v.optional(v.string()),
        playlistId: v.nullish(v.string()),
      }),
    ),
    async (c) => {
      const body = c.req.valid("json");
      const mode = getManualSearchMode(body.mode);
      const job = getAccessibleManualSearchJob(c.var.user, c.req.param("jobId"), {
        mode,
        playlistId: body.playlistId,
      });
      if (!job) return c.json({ error: "Track is not available for manual search" }, 404);
      try {
        const result = await createManualMissingSearch({
          job,
          sourceId: body.sourceId,
          actorId: getActorId(c.var.user),
          mode,
          playlistId: body.playlistId,
        });
        return c.json(result, 200);
      } catch (error) {
        logger.warn("manual-search", "Manual track search failed", {
          jobId: job.id,
          sourceId: body.sourceId,
          reason: safeLogDiagnostic(error),
        });
        return c.json(
          {
            error: "Manual search failed",
            message:
              safeLogDiagnostic(error) || "The selected download client could not be searched",
          },
          502,
        );
      }
    },
  )
  .post(
    "/jobs/:jobId/manual-search/select",
    requireFlowAccess,
    validate("json", v.object({ sessionId: v.string(), resultId: v.string() })),
    async (c) => {
      const jobId = c.req.param("jobId");
      const { sessionId, resultId } = c.req.valid("json");
      try {
        const selection = getManualMissingSelection({
          sessionId,
          resultId,
          jobId,
          actorId: getActorId(c.var.user),
        });
        const job = getAccessibleManualSearchJob(c.var.user, jobId, {
          mode: selection.mode,
          playlistId: selection.playlistId,
        });
        if (!job) {
          return c.json({ error: "Track is no longer available for manual search" }, 409);
        }
        const replacement = selection.mode === "replacement";
        const queued = isDownloadOwnerProcess()
          ? replacement
            ? downloadTracker.enqueueManualReplacementSelection(job.id, selection)
            : downloadTracker.enqueueManualSelection(job.id, selection)
          : await requestDownloadOwner(
              replacement ? "enqueueManualReplacementSelection" : "enqueueManualMissingSelection",
              [job.id, selection],
              { timeoutMs: 30_000 },
            );
        if (!queued) {
          return c.json({ error: "Track is no longer available for manual search" }, 409);
        }
        consumeManualMissingSelection(sessionId);
        invalidateRequestsCache();
        return c.json({ success: true, jobId: job.id }, 200);
      } catch (error) {
        return c.json(
          {
            error: "Could not queue selected result",
            message: safeLogDiagnostic(error) || "The selected result could not be queued",
          },
          409,
        );
      }
    },
  )
  .post("/research-missing", requireFlowAccess, async (c) => {
    try {
      let requeued = 0;
      for (const playlistId of [LIBRARY_JOB_TYPE, ...getAccessiblePlaylistIds(c.var.user)]) {
        requeued += await downloadWorker.researchMissingTracks(playlistId);
      }
      return c.json({ success: true, requeued }, 200);
    } catch (error) {
      return c.json(
        { error: "Failed to re-search missing tracks", message: asAppError(error)?.message },
        500,
      );
    }
  })
  .post("/quality-upgrades", requireFlowAccess, async (c) => {
    const playlistIds = getAccessiblePlaylistIds(c.var.user);
    const checkedIds = [LIBRARY_JOB_TYPE, ...playlistIds];
    const queued = isDownloadOwnerProcess()
      ? await runQualityUpgradeCheck({ force: true, playlistIds: checkedIds, limit: 500 })
      : await requestDownloadOwner<number>("runQualityUpgradeChecks", [checkedIds, 500], {
          timeoutMs: 30 * 60 * 1000,
        });
    if (queued > 0) invalidateRequestsCache();
    return c.json({ success: true, queued, playlistCount: playlistIds.length }, 200);
  })
  .post("/quality-upgrades/:playlistId/:jobId", requireFlowAccess, async (c) => {
    const playlistId = c.req.param("playlistId");
    const jobId = c.req.param("jobId");
    if (!canAccessJobType(c.var.user, playlistId)) {
      return c.json({ error: "Playlist not found" }, 404);
    }
    const job = downloadTracker.getJob(jobId);
    if (!job || job.playlistType !== playlistId) {
      return c.json({ error: "Track not found" }, 404);
    }
    const result = isDownloadOwnerProcess()
      ? await queueQualityUpgrade(job)
      : await requestDownloadOwner("queueQualityUpgradeForJob", [job.id], {
          timeoutMs: 10 * 60 * 1000,
        });
    if (result === "already-queued") {
      return c.json({ success: true, queued: 0, alreadyQueued: true, jobId }, 200);
    }
    if (result === "kept") {
      return c.json(
        { error: "This file is kept. Allow upgrades for it first.", code: "kept_file" },
        409,
      );
    }
    if (result !== "queued") {
      return c.json({ error: "Track is not eligible for an upgrade" }, 409);
    }
    invalidateRequestsCache();
    return c.json({ success: true, queued: 1, jobId }, 200);
  })
  .post("/jobs/:jobId/approve", requireFlowAccess, (c) =>
    reviewBlockedJob(c, "approveBlockedJob", c.req.param("jobId")),
  )
  .post("/jobs/:jobId/deny", requireFlowAccess, (c) =>
    reviewBlockedJob(c, "denyBlockedJob", c.req.param("jobId")),
  )
  .post("/jobs/:jobId/cancel", requireAuth, async (c) => {
    const access = getControllableJob(c, c.var.user, c.req.param("jobId"));
    if (access.failure) return access.failure;
    const { job } = access;
    if (!ACTIVE_JOB_STATUSES.has(job.status)) {
      return c.json({ error: "Track download is already finished", status: job.status }, 409);
    }
    try {
      const result = isDownloadOwnerProcess()
        ? await cancelTrackDownload(job.id)
        : await requestDownloadOwner<Awaited<ReturnType<typeof cancelTrackDownload>>>(
            "cancelTrackDownload",
            [job.id],
          );
      if (result.statusCode !== undefined) {
        const { statusCode, ...body } = result;
        return c.json(body, isErrorStatus(statusCode) ? statusCode : 500);
      }
      invalidateRequestsCache();
      return c.json(result, 200);
    } catch (error) {
      return c.json(
        { error: "Failed to cancel track download", message: asAppError(error)?.message },
        500,
      );
    }
  })
  .post("/jobs/:jobId/retry", requireAuth, async (c) => {
    const access = getControllableJob(c, c.var.user, c.req.param("jobId"));
    if (access.failure) return access.failure;
    const { job } = access;
    if (!RETRYABLE_JOB_STATUSES.has(job.status)) {
      return c.json({ error: "Track download cannot be retried", status: job.status }, 409);
    }
    try {
      const result = isDownloadOwnerProcess()
        ? await retryTrackDownload(job.id)
        : await requestDownloadOwner<Awaited<ReturnType<typeof retryTrackDownload>>>(
            "retryTrackDownload",
            [job.id],
          );
      if (result.statusCode !== undefined) {
        const { statusCode, ...body } = result;
        return c.json(body, isErrorStatus(statusCode) ? statusCode : 500);
      }
      invalidateRequestsCache();
      return c.json(result, 200);
    } catch (error) {
      return c.json(
        { error: "Failed to retry track download", message: asAppError(error)?.message },
        500,
      );
    }
  });

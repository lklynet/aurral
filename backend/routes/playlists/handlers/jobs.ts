import { Hono } from "hono";
import { staticPlaylistJobs } from "../../../services/playlists/playlistJobs.ts";
import * as v from "valibot";
import path from "path";
import {
  downloadTracker,
  jobStatusSchema,
} from "../../../services/downloadJobs/downloadTracker.ts";
import { downloadWorker } from "../../../services/downloadJobs/downloadWorker.ts";
import { flowPlaylistConfig } from "../../../services/playlists/flowPlaylistConfig.ts";
import { orderJobsByPlaylistTracks } from "../../../services/playlists/playlistTracks.ts";
import {
  getPlaylistStatusSnapshot,
  getPlaylistsContainingTrack,
} from "../../../services/playlists/playlistStatusSnapshot.ts";
import { indexUnmonitoredJobs } from "../../../services/unmonitoredJobs.ts";
import { noCache } from "../../../middleware/cacheHeaders.ts";
import { requireAdmin, requireAuth } from "../../../middleware/guards.ts";
import { hasPermission } from "../../../services/auth.ts";
import {
  ACTIVE_JOB_STATUSES,
  RETRYABLE_JOB_STATUSES,
  cancelTrackDownload,
  cancelTrackDownloads,
  retryTrackDownload,
} from "../../../services/albumJobs.ts";
import { getTrackJobRequesterId } from "../../../services/aurralHistoryService.ts";
import {
  LIBRARY_JOB_TYPE,
  canAccessJobThroughPlaylist,
  canAccessJobType,
  canAccessPlaylistType,
  filterJobsForUser,
  requirePlaylistAccess,
} from "./utils.ts";
import {
  approveBlockedJob,
  denyBlockedJob,
} from "../../../services/downloadJobs/blockedJobReview.ts";
import { invalidateRequestsCache } from "../../requests.ts";
import { getLibraryMediaFile } from "../../../services/libraryMediaStore.ts";
import {
  queueQualityUpgrade,
  runQualityUpgradeCheck,
} from "../../../services/qualityProfileService.ts";
import {
  decorateJobQuality,
  getQualityProfile,
  isAurralOwnedPath,
} from "../../../services/qualityProfile.ts";
import { readOnlyFolderPaths } from "../../../services/libraryFolders.ts";
import { getLibraryTrackOwnershipBatch } from "../../../services/libraryQueryService.ts";
import { playlistTrackFavoriteIds } from "../../../services/subsonicLibraryService.ts";
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
import { releaseGroupCoverImageUrl } from "../../../services/releaseGroupCoverService.ts";
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

function getAccessibleManualSearchJob(
  user: RequestUser | undefined,
  jobId: string,
  { mode = "missing", playlistId = null }: { mode?: ManualSearchMode; playlistId?: unknown } = {},
) {
  const job = downloadTracker.getJob(jobId);
  if (!job) return null;
  if (mode === "replacement") {
    if (
      job.status !== "done" ||
      job.upgradeForJobId ||
      !isAurralOwnedPath(job.finalPath) ||
      downloadTracker.findActiveUpgradeJob(job)
    ) {
      return null;
    }
    const replacesLibraryFile =
      hasPermission(user, "addAlbum") &&
      getLibraryMediaFile({ source: "aurral", path: job.finalPath! })?.available === 1;
    return replacesLibraryFile || canAccessJobThroughPlaylist(user, job, playlistId) ? job : null;
  }
  if (!canAccessJobThroughPlaylist(user, job, playlistId)) return null;
  if (job.status !== "failed" || job.upgradeForJobId) return null;
  return job;
}

function toPublicJob(
  job: DownloadJob,
  profile: ReturnType<typeof getQualityProfile>,
  readOnlyRoots: string[],
) {
  const {
    stagingPath: _stagingPath,
    heldForReview: _heldForReview,
    finalPath,
    externalPath: _externalPath,
    ...publicJob
  } = decorateJobQuality(job, profile, readOnlyRoots);
  const streamFormat = finalPath ? path.extname(finalPath).slice(1).toLowerCase() : "";
  return { ...publicJob, streamFormat: streamFormat || null };
}

function trackArtwork(
  job: DownloadJob,
  customArtwork: ReturnType<typeof getCustomArtworkMap>,
  playlistId: string | null,
) {
  const defaultArtworkUrl = job.albumMbid ? releaseGroupCoverImageUrl(job.albumMbid) : null;
  const custom = customArtwork.get(String(job.id));
  if (!custom) return { artworkUrl: defaultArtworkUrl };
  const customArtworkUrl = buildCustomArtworkUrl("playlist-track", job.id, custom, { playlistId });
  return { artworkUrl: customArtworkUrl, customArtworkUrl, defaultArtworkUrl };
}

const reviewBlockedJob = async <E extends AppEnv>(
  c: Context<E>,
  method: "approveBlockedJob" | "denyBlockedJob",
  jobId: string,
) => {
  try {
    const outcome = isDownloadOwnerProcess()
      ? await reviewBlockedJobLocally[method](jobId)
      : await requestDownloadOwner(method, [jobId], {
          timeoutMs: BLOCKED_JOB_REVIEW_TIMEOUT_MS,
        });
    if (outcome.status !== 200) {
      return c.json({ error: outcome.error }, isErrorStatus(outcome.status) ? outcome.status : 500);
    }
    invalidateRequestsCache();
    return c.json(
      { success: true, ...("path" in outcome && Boolean(outcome.path) && { path: outcome.path }) },
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

const canControlJob = (user: RequestUser, job: DownloadJob) =>
  hasPermission(user, "accessPlaylists")
    ? canAccessJobType(user, job.playlistId || job.playlistType)
    : job.playlistType === LIBRARY_JOB_TYPE &&
      user.id != null &&
      String(getTrackJobRequesterId(job.id)) === String(user.id);

const getControllableJob = <E extends AppEnv>(c: Context<E>, user: RequestUser, jobId: string) => {
  const job = downloadTracker.getJob(jobId);
  if (!job) return { failure: c.json({ error: "Track not found" }, 404) };
  if (!canControlJob(user, job)) {
    return hasPermission(user, "accessPlaylists")
      ? { failure: c.json({ error: "Track not found" }, 404) }
      : { failure: c.json({ error: "Forbidden" }, 403) };
  }
  return { job };
};

const queryValue = v.optional(v.union([v.string(), v.array(v.string())]));

const manualSearchQuery = v.object({
  mode: v.optional(v.string()),
  playlistId: v.optional(v.string()),
});

const containingQuery = v.object({
  artistName: v.string(),
  trackName: v.string(),
  albumName: v.optional(v.string()),
  artistMbid: v.optional(v.string()),
  albumMbid: v.optional(v.string()),
  trackMbid: v.optional(v.string()),
  releaseYear: v.optional(v.string()),
});

export default new Hono<AppEnv>()
  .basePath("/playlists")
  .get("/status", requirePlaylistAccess, noCache, (c) => {
    return c.json(getPlaylistStatusSnapshot({ user: c.var.user }), 200);
  })
  .get("/containing", requirePlaylistAccess, noCache, validate("query", containingQuery), (c) =>
    c.json({ playlists: getPlaylistsContainingTrack(c.var.user, c.req.valid("query")) }, 200),
  )
  .get(
    "/jobs/:playlistId",
    requirePlaylistAccess,
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
      const jobs = staticPlaylist
        ? orderJobsByPlaylistTracks(staticPlaylistJobs(staticPlaylist), staticPlaylist.tracks)
            .slice(0, limit ?? undefined)
            .map((job) => ({ ...job, playlistId, playlistType: playlistId }))
        : downloadTracker.getByPlaylistType(playlistId, limit);
      const profile = getQualityProfile();
      const readOnlyRoots = readOnlyFolderPaths();
      const accessibleJobs = filterJobsForUser(user, jobs);
      const libraryOwnership = getLibraryTrackOwnershipBatch(accessibleJobs);
      const favoriteIds = playlistTrackFavoriteIds(playlistId, accessibleJobs);
      const customArtwork = getCustomArtworkMap(
        "playlist-track",
        accessibleJobs.map((job) => job.id),
      );
      return c.json(
        accessibleJobs.map((job, index) => ({
          ...toPublicJob(job, profile, readOnlyRoots),
          libraryOwned: libraryOwnership[index] === true,
          favoriteId: favoriteIds[index],
          ...trackArtwork(job, customArtwork, playlistId),
        })),
        200,
      );
    },
  )
  .get(
    "/jobs",
    requirePlaylistAccess,
    noCache,
    validate("query", v.object({ status: queryValue })),
    (c) => {
      const { status } = c.req.valid("query");
      if (status !== undefined && typeof status !== "string") {
        return c.json({ error: "status must be a single value" }, 400);
      }
      const jobs = filterJobsForUser(
        c.var.user,
        !status
          ? downloadTracker.getAll()
          : v.is(jobStatusSchema, status)
            ? downloadTracker.getByStatus(status)
            : [],
      );
      const profile = getQualityProfile();
      const readOnlyRoots = readOnlyFolderPaths();
      const isUnmonitored = indexUnmonitoredJobs();
      const customArtwork = getCustomArtworkMap(
        "playlist-track",
        jobs.map((job) => job.id),
      );
      return c.json(
        jobs.map((job) => ({
          ...toPublicJob(job, profile, readOnlyRoots),
          monitored: !isUnmonitored(job),
          ...trackArtwork(job, customArtwork, job.playlistType || job.playlistId),
        })),
        200,
      );
    },
  )
  .get("/jobs/:jobId/files", requirePlaylistAccess, requireAdmin, noCache, (c) => {
    const job = downloadTracker.getJob(c.req.param("jobId"));
    if (!job) return c.json({ error: "Track not found" }, 404);
    return c.json({ paths: job.finalPath ? [job.finalPath] : [] }, 200);
  })
  .get(
    "/jobs/:jobId/manual-search/sources",
    requirePlaylistAccess,
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
    requirePlaylistAccess,
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
    requirePlaylistAccess,
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
  .post("/research-missing", requirePlaylistAccess, async (c) => {
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
  .post("/quality-upgrades", requirePlaylistAccess, async (c) => {
    const playlistIds = getAccessiblePlaylistIds(c.var.user);
    const checkedIds = [LIBRARY_JOB_TYPE, ...playlistIds];
    const queued = isDownloadOwnerProcess()
      ? await runQualityUpgradeCheck({ force: true, playlistIds: checkedIds, limit: 500 })
      : await requestDownloadOwner("runQualityUpgradeChecks", [checkedIds, 500], {
          timeoutMs: 30 * 60 * 1000,
        });
    if (queued > 0) invalidateRequestsCache();
    return c.json({ success: true, queued, playlistCount: playlistIds.length }, 200);
  })
  .post("/quality-upgrades/:playlistId/:jobId", requirePlaylistAccess, async (c) => {
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
    if (result === "unmonitored") {
      return c.json(
        { error: "This track is not monitored. Monitor it first.", code: "unmonitored_track" },
        409,
      );
    }
    if (result !== "queued") {
      return c.json({ error: "Track is not eligible for an upgrade" }, 409);
    }
    invalidateRequestsCache();
    return c.json({ success: true, queued: 1, jobId }, 200);
  })
  .post("/jobs/:jobId/approve", requirePlaylistAccess, (c) =>
    reviewBlockedJob(c, "approveBlockedJob", c.req.param("jobId")),
  )
  .post("/jobs/:jobId/deny", requirePlaylistAccess, (c) =>
    reviewBlockedJob(c, "denyBlockedJob", c.req.param("jobId")),
  )
  .post("/jobs/cancel", requireAuth, async (c) => {
    const user = c.var.user;
    const jobIds = downloadTracker
      .getAll()
      .filter((job) => ACTIVE_JOB_STATUSES.has(job.status) && canControlJob(user, job))
      .map((job) => job.id);
    try {
      const result = isDownloadOwnerProcess()
        ? await cancelTrackDownloads(jobIds)
        : await requestDownloadOwner("cancelTrackDownloads", [jobIds], {
            timeoutMs: 2 * 60 * 1000,
          });
      invalidateRequestsCache();
      return c.json(result, 200);
    } catch (error) {
      return c.json(
        { error: "Failed to cancel downloads", message: asAppError(error)?.message },
        500,
      );
    }
  })
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
        : await requestDownloadOwner("cancelTrackDownload", [job.id]);
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
        : await requestDownloadOwner("retryTrackDownload", [job.id]);
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

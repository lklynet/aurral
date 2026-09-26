import { downloadTracker } from "../../../services/weeklyFlow/weeklyFlowDownloadTracker.js";
import { weeklyFlowWorker } from "../../../services/weeklyFlow/weeklyFlowWorker.js";
import { startSlskdOrchestratorWorker } from "../../../services/slskdOrchestratorWorker.js";
import { playlistManager } from "../../../services/weeklyFlow/weeklyFlowPlaylistManager.js";
import {
  flowPlaylistConfig,
  orderJobsBySharedPlaylistTracks,
} from "../../../services/weeklyFlow/weeklyFlowPlaylistConfig.js";
import { weeklyFlowOperationQueue } from "../../../services/weeklyFlow/weeklyFlowOperationQueue.js";
import { getWeeklyFlowStatusSnapshot } from "../../../services/weeklyFlow/weeklyFlowStatusSnapshot.js";
import { noCache } from "../../../middleware/cache.js";
import { requireAdmin } from "../../../middleware/requirePermission.js";
import {
  EXISTING_FILE_MODE_OPTIONS,
  canAccessPlaylistType,
  filterJobsForUser,
  pauseSharedPlaylistRetryCycle,
  getAccessibleSharedPlaylist,
} from "./utils.js";
import {
  buildAurralTrackDestination,
  resolvePlaylistRoot,
} from "../../../services/playlistPaths.js";
import {
  commitImportToPlaylistLibrary,
  joinUnderRoot,
  sanitizePathPart,
} from "../../../services/playlistDownloadUtils.js";
import { finalizePipelineJobSuccess } from "../../../services/pipelineHelpers.js";
import {
  withPipelineCommitLock,
} from "../../../services/weeklyFlow/weeklyFlowDownloadCancellation.js";
import path from "path";
import fs from "fs/promises";
import { invalidateRequestsCache } from "../../requests.js";
import {
  decorateJobQuality,
  classifyQualityJob,
  getQualityProfile,
  queueQualityUpgrade,
  runQualityUpgradeCheck,
} from "../../../services/qualityProfileService.js";
import { getCanonicalTrackOwnershipBatch } from "../../../services/libraryQueryService.js";
import { logger, safeLogDiagnostic } from "../../../services/logger.js";
import { clearAllDownloadJobs } from "../../../services/weeklyFlow/weeklyFlowDownloadCancellationService.js";
import {
  isFlowOwnerProcess,
  requestFlowOwner,
} from "../../../services/weeklyFlow/weeklyFlowOwnerClient.js";
import {
  createManualMissingSearch,
  getManualDownloadSources,
  takeManualMissingSelection,
} from "../../../services/manualMissingSearchService.js";

const getAccessiblePlaylistIds = (user) => [
  ...new Set([
    ...flowPlaylistConfig.getFlowsForUser(user),
    ...flowPlaylistConfig.getSharedPlaylistsForUser(user),
  ].map((playlist) => playlist.id)),
];

const getActorId = (user) => String(user?.id || user?.username || "").trim();

function getAccessibleMissingJob(user, jobId) {
  const job = downloadTracker.getJob(jobId);
  if (!job || filterJobsForUser(user, [job]).length === 0) return null;
  if (job.status !== "failed" || job.upgradeForJobId) return null;
  return job;
}

async function runQualityChecksLocally(playlistIds) {
  let queued = 0;
  for (const playlistId of playlistIds) {
    queued += await runQualityUpgradeCheck({ force: true, playlistId, limit: 500 });
  }
  return queued;
}

export function registerJobs(router) {
  router.get("/status", noCache, (req, res) => {
    res.json(getWeeklyFlowStatusSnapshot({ user: req.user }));
  });

  router.get("/jobs/:flowId", noCache, async (req, res) => {
    const { flowId } = req.params;
    if (!canAccessPlaylistType(req.user, flowId)) {
      return res.status(404).json({ error: "Playlist not found" });
    }
    const rawLimit =
      req.query.limit == null ? "" : String(req.query.limit).trim();
    const parsedLimit = Number(rawLimit);
    const limit =
      rawLimit && Number.isFinite(parsedLimit) && parsedLimit > 0
        ? Math.floor(parsedLimit)
        : null;
    const sharedPlaylist = flowPlaylistConfig.getSharedPlaylist(flowId);
    const sharedTracks = sharedPlaylist?.tracks;
    let jobs = downloadTracker.getByPlaylistType(
      flowId,
      sharedTracks?.length ? null : limit,
    );
    if (sharedTracks?.length) {
      const referencedJobIds = new Set(
        sharedTracks.map((track) => String(track?.canonicalJobId || "")).filter(Boolean),
      );
      const referencedJobs = [...referencedJobIds]
        .map((jobId) => downloadTracker.getJob(jobId))
        .filter(Boolean);
      jobs = [...referencedJobs, ...jobs].filter(
        (job, index, values) => values.findIndex((candidate) => candidate.id === job.id) === index,
      );
      jobs = orderJobsBySharedPlaylistTracks(jobs, sharedTracks);
      if (limit != null) jobs = jobs.slice(0, limit);
      jobs = jobs.map((job) =>
        referencedJobIds.has(job.id) && job.playlistType !== flowId
          ? { ...job, playlistId: flowId, playlistType: flowId }
          : job,
      );
    }
    const profile = getQualityProfile();
    const accessibleJobs = filterJobsForUser(req.user, jobs).map((job) =>
      decorateJobQuality(job, profile),
    );
    const libraryOwnership = getCanonicalTrackOwnershipBatch(accessibleJobs);
    res.json(
      accessibleJobs.map((job, index) => ({
        ...job,
        libraryOwned: libraryOwnership[index] === true,
      })),
    );
  });

  router.get("/jobs", noCache, (req, res) => {
    const { status } = req.query;
    const jobs = filterJobsForUser(
      req.user,
      status ? downloadTracker.getByStatus(status) : downloadTracker.getAll(),
    );
    const profile = getQualityProfile();
    res.json(jobs.map((job) => decorateJobQuality(job, profile)));
  });

  router.get("/jobs/:jobId/manual-search/sources", noCache, (req, res) => {
    const job = getAccessibleMissingJob(req.user, req.params.jobId);
    if (!job) return res.status(404).json({ error: "Missing track not found" });
    return res.json({ sources: getManualDownloadSources() });
  });

  router.post("/jobs/:jobId/manual-search", async (req, res) => {
    const job = getAccessibleMissingJob(req.user, req.params.jobId);
    if (!job) return res.status(404).json({ error: "Missing track not found" });
    try {
      const result = await createManualMissingSearch({
        job,
        sourceId: req.body?.sourceId,
        actorId: getActorId(req.user),
      });
      return res.json(result);
    } catch (error) {
      logger.warn("manual-search", "Manual missing-track search failed", {
        jobId: job.id,
        sourceId: String(req.body?.sourceId || ""),
        reason: safeLogDiagnostic(error),
      });
      return res.status(502).json({
        error: "Manual search failed",
        message: safeLogDiagnostic(error) || "The selected download client could not be searched",
      });
    }
  });

  router.post("/jobs/:jobId/manual-search/select", async (req, res) => {
    const job = getAccessibleMissingJob(req.user, req.params.jobId);
    if (!job) return res.status(404).json({ error: "Missing track not found" });
    try {
      const selection = takeManualMissingSelection({
        sessionId: req.body?.sessionId,
        resultId: req.body?.resultId,
        jobId: job.id,
        actorId: getActorId(req.user),
      });
      const queued = isFlowOwnerProcess()
        ? downloadTracker.enqueueManualSelection(job.id, selection)
        : await requestFlowOwner("enqueueManualMissingSelection", [job.id, selection], {
          timeoutMs: 30_000,
        });
      if (!queued) {
        return res.status(409).json({
          error: "Track is no longer available for manual search",
        });
      }
      invalidateRequestsCache();
      return res.json({ success: true, jobId: job.id });
    } catch (error) {
      return res.status(409).json({
        error: "Could not queue selected result",
        message: safeLogDiagnostic(error) || "The selected result could not be queued",
      });
    }
  });

  router.post("/research-missing", async (req, res) => {
    try {
      let requeued = 0;
      for (const playlistId of getAccessiblePlaylistIds(req.user)) {
        requeued += await weeklyFlowWorker.researchMissingTracks(playlistId);
      }
      return res.json({ success: true, requeued });
    } catch (error) {
      return res.status(500).json({
        error: "Failed to re-search missing tracks",
        message: error.message,
      });
    }
  });

  router.post("/quality-upgrades", async (req, res) => {
    const playlistIds = getAccessiblePlaylistIds(req.user);
    const queued = isFlowOwnerProcess()
      ? await runQualityChecksLocally(playlistIds)
      : await requestFlowOwner("runQualityUpgradeChecks", [playlistIds, 500], {
        timeoutMs: 30 * 60 * 1000,
      });
    if (queued > 0) invalidateRequestsCache();
    return res.json({
      success: true,
      queued,
      playlistCount: playlistIds.length,
    });
  });

  router.post("/quality-upgrades/:playlistId/:jobId", async (req, res) => {
    const { playlistId, jobId } = req.params;
    if (!canAccessPlaylistType(req.user, playlistId)) {
      return res.status(404).json({ error: "Playlist not found" });
    }
    const job = downloadTracker.getJob(jobId);
    if (!job || job.playlistType !== playlistId) {
      return res.status(404).json({ error: "Track not found" });
    }
    const result = isFlowOwnerProcess()
      ? await queueQualityUpgrade(job)
      : await requestFlowOwner("queueQualityUpgradeForJob", [job.id], {
        timeoutMs: 10 * 60 * 1000,
      });
    if (result === "already-queued") {
      return res.json({ success: true, queued: 0, alreadyQueued: true, jobId });
    }
    if (result !== "queued") {
      return res.status(409).json({ error: "Track is not eligible for an upgrade" });
    }
    invalidateRequestsCache();
    return res.json({ success: true, queued: 1, jobId });
  });

  router.post("/quality-upgrades/:playlistId", async (req, res) => {
    const { playlistId } = req.params;
    if (!canAccessPlaylistType(req.user, playlistId)) {
      return res.status(404).json({ error: "Playlist not found" });
    }
    const queued = isFlowOwnerProcess()
      ? await runQualityChecksLocally([playlistId])
      : await requestFlowOwner("runQualityUpgradeChecks", [[playlistId], 500], {
        timeoutMs: 30 * 60 * 1000,
      });
    if (queued > 0) invalidateRequestsCache();
    return res.json({ success: true, queued });
  });

  router.put("/playlists/:playlistId/retry-cycle", async (req, res) => {
    try {
      const { playlistId } = req.params;
      const { paused } = req.body || {};
      if (typeof paused !== "boolean") {
        return res.status(400).json({
          error: "paused must be a boolean",
        });
      }
      const shared = getAccessibleSharedPlaylist(req.user, playlistId);
      if (!shared) {
        return res.status(404).json({
          error: "Static playlist not found",
        });
      }
      if (paused) {
        await pauseSharedPlaylistRetryCycle(playlistId);
      } else {
        await weeklyFlowWorker.setRetryCyclePaused(playlistId, false);
        await weeklyFlowWorker.retryIncompletePlaylist(playlistId);
      }
      return res.json({
        success: true,
        playlistId,
        paused,
      });
    } catch (error) {
      return res.status(500).json({
        error: "Failed to update retry cycle",
        message: error.message,
      });
    }
  });

  router.get("/worker/settings", requireAdmin, (req, res) => {
    res.json(weeklyFlowWorker.getWorkerSettings());
  });

  router.put("/worker/settings", requireAdmin, async (req, res) => {
    const { concurrency, existingFileMode } = req.body || {};
    if (concurrency !== undefined) {
      const parsed = Number(concurrency);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 3) {
        return res.status(400).json({
          error: "concurrency must be an integer between 1 and 3",
        });
      }
    }
    if (existingFileMode !== undefined) {
      const normalized = String(existingFileMode || "").trim().toLowerCase();
      if (!EXISTING_FILE_MODE_OPTIONS.includes(normalized)) {
        return res.status(400).json({
          error: "existingFileMode must be one of: download, reuse",
        });
      }
    }
    const settings = await weeklyFlowWorker.updateWorkerSettings({
      concurrency,
      existingFileMode,
    });
    return res.json({ success: true, settings });
  });

  router.post("/worker/start", requireAdmin, async (req, res) => {
    try {
      startSlskdOrchestratorWorker();
      await weeklyFlowWorker.start();
      res.json({ success: true, message: "Worker started" });
    } catch (error) {
      res.status(500).json({
        error: "Failed to start worker",
        message: error.message,
      });
    }
  });

  router.post("/worker/stop", requireAdmin, async (req, res) => {
    try {
      await weeklyFlowWorker.stopAndDrain();
      res.json({ success: true, message: "Worker stopped" });
    } catch (error) {
      res.status(500).json({
        error: "Failed to stop worker",
        message: error.message,
      });
    }
  });

  router.delete("/jobs/completed", requireAdmin, (req, res) => {
    const count = downloadTracker.clearCompleted();
    res.json({ success: true, cleared: count });
  });

  router.post("/jobs/:jobId/approve", async (req, res) => {
    const job = downloadTracker.getJob(req.params.jobId);
    if (!job || job.status !== "blocked") {
      return res.status(404).json({ error: "Blocked job not found" });
    }
    const sourcePath = String(job.stagingPath || "").trim();
    if (!sourcePath) {
      return res.status(400).json({ error: "Staging file path missing" });
    }
    try {
      await fs.access(sourcePath);
    } catch {
      return res.status(404).json({ error: "Staging file no longer exists" });
    }
    const playlistRoot = resolvePlaylistRoot();
    const ext = path.extname(sourcePath).toLowerCase();
    const albumDir = sanitizePathPart(job.albumName, "Unknown Album");
    const artistDir = sanitizePathPart(job.artistName, "Unknown Artist");
    const playlistId = job.playlistId || job.playlistType;
    const destination = buildAurralTrackDestination(playlistId, artistDir, albumDir, {
      ephemeral: Boolean(flowPlaylistConfig.getFlow(playlistId)),
    });
    const finalDir = joinUnderRoot(playlistRoot, destination);
    const finalName = `${sanitizePathPart(job.trackName, "Unknown Track")}${ext || ".mp3"}`;
    const finalPath = path.join(finalDir, finalName);
    try {
      const committed = await withPipelineCommitLock(
        {
          jobId: job.id,
          playlistId,
          playlistGeneration: job.playlistGeneration,
        },
        async () => {
          const committedPath = await commitImportToPlaylistLibrary(sourcePath, finalPath);
          await finalizePipelineJobSuccess({
            downloadTracker,
            job,
            committedFinalPath: committedPath,
            album: job.albumName,
          });
          return committedPath;
        },
      );
      if (committed.cancelled) {
        return res.status(409).json({ error: "Download job was removed" });
      }
      await classifyQualityJob(downloadTracker.getJob(job.id));
      invalidateRequestsCache();
      res.json({ success: true, path: committed.result });
    } catch (error) {
      res.status(500).json({ error: "Import failed", message: error.message });
    }
  });

  router.post("/jobs/:jobId/deny", async (req, res) => {
    const job = downloadTracker.getJob(req.params.jobId);
    if (!job || job.status !== "blocked") {
      return res.status(404).json({ error: "Blocked job not found" });
    }
    const sourcePath = String(job.stagingPath || "").trim();
    if (sourcePath) {
      await fs.rm(sourcePath, { force: true }).catch(() => {});
    }
    const deniedSourceKey = ["usenet", "ytdlp", "deemix"].includes(job.downloadSource)
      ? String(job.releaseGuid || "").trim()
      : `${String(job.remoteUsername || "").trim()}\0${String(job.remoteFilename || "").trim()}`;
    if (job.downloadSource && deniedSourceKey) {
      downloadTracker.recordDeniedSource(job.id, job.downloadSource, deniedSourceKey);
    }
    downloadTracker.setPending(job.id, "Denied by user", { asRetryCycle: false });
    import("../../../services/aurralHistoryService.js")
      .then(({ recordTrackJobFailed }) =>
        recordTrackJobFailed(job, "Denied by user — will retry"),
      )
      .catch(() => {});
    invalidateRequestsCache();
    weeklyFlowWorker.wake();
    res.json({ success: true });
  });

  router.delete("/jobs/all", requireAdmin, async (req, res) => {
    try {
      const count = await clearAllDownloadJobs(downloadTracker);
      return res.json({ success: true, cleared: count });
    } catch (error) {
      logger.error("weekly-flow", "Could not safely clear download jobs", {
        reason: error?.message || String(error),
      });
      return res.status(500).json({
        error: "Some provider work could not be cancelled. Affected jobs were stopped in Aurral and marked failed. Retry clearing jobs after fixing the provider connection.",
      });
    }
  });

  router.post("/reset", requireAdmin, async (req, res) => {
    try {
      const { flowIds } = req.body;
      const types =
        flowIds || flowPlaylistConfig.getFlows().map((flow) => flow.id);

      await weeklyFlowOperationQueue.enqueuePayload({
        kind: "reset-playlists",
        label: "reset:manual",
        playlistTypes: types,
      });

      res.json({
        success: true,
        message: `Weekly reset completed for: ${types.join(", ")}`,
      });
    } catch (error) {
      res.status(500).json({
        error: "Failed to perform weekly reset",
        message: error.message,
      });
    }
  });

  router.post("/playlist/:playlistType/create", requireAdmin, async (req, res) => {
    try {
      playlistManager.updateConfig(false);
      await playlistManager.ensureSmartPlaylists();
      res.json({
        success: true,
        message:
          "Playlists ensured. Navidrome creates API playlists after it indexes completed tracks.",
      });
    } catch (error) {
      res.status(500).json({
        error: "Failed to ensure playlists or trigger scan",
        message: error.message,
      });
    }
  });
}

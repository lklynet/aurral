import { downloadTracker } from "../../../services/downloadJobs/downloadTracker.js";
import { downloadWorker } from "../../../services/downloadJobs/downloadWorker.js";
import { startDownloadPipelineWorker } from "../../../services/downloadPipelineWorker.js";
import { playlistManager } from "../../../services/playlists/playlistManager.js";
import { flowPlaylistConfig } from "../../../services/playlists/flowPlaylistConfig.js";
import {
  getStaticPlaylistJobs,
  staticPlaylistReferencesJob,
} from "../../../services/playlists/staticPlaylistJobs.js";
import { playlistOperationQueue } from "../../../services/playlists/playlistOperationQueue.js";
import { getPlaylistStatusSnapshot } from "../../../services/playlists/playlistStatusSnapshot.js";
import { indexUnmonitoredJobs } from "../../../services/aurralUnmonitoredJobs.js";
import { noCache } from "../../../middleware/cache.js";
import { requireAdmin } from "../../../middleware/requirePermission.js";
import {
  EXISTING_FILE_MODE_OPTIONS,
  canAccessJobOwner,
  canAccessPlaylist,
  filterJobsForUser,
  getAccessibleJobIds,
} from "./utils.js";
import {
  approveBlockedJob,
  denyBlockedJob,
} from "../../../services/downloadJobs/blockedJobReview.js";
import path from "path";
import { invalidateRequestsCache } from "../../requests.js";
import {
  decorateJobQuality,
  getQualityProfile,
  isAurralOwnedPath,
  queueQualityUpgrade,
  runQualityUpgradeCheck,
} from "../../../services/qualityProfileService.js";
import { getLibraryTrackOwnershipBatch } from "../../../services/libraryQueryService.js";
import { logger, safeLogDiagnostic } from "../../../services/logger.js";
import { clearAllDownloadJobs } from "../../../services/downloadJobs/downloadCancellationService.js";
import {
  isDownloadOwnerProcess,
  requestDownloadOwner,
} from "../../../services/downloadJobs/downloadOwnerClient.js";
import {
  createManualMissingSearch,
  consumeManualMissingSelection,
  getManualMissingSelection,
  getManualDownloadSources,
} from "../../../services/manualMissingSearchService.js";

const getAccessiblePlaylistIds = (user) => [
  ...flowPlaylistConfig.getFlowsForUser(user),
  ...flowPlaylistConfig.getStaticPlaylistsForUser(user),
].map((playlist) => playlist.id);

const BLOCKED_JOB_REVIEW_TIMEOUT_MS = 16 * 60 * 1000;
const reviewBlockedJobLocally = { approveBlockedJob, denyBlockedJob };

const getActorId = (user) => String(user?.id || user?.username || "").trim();

function getManualSearchMode(value) {
  return String(value || "").trim() === "replacement" ? "replacement" : "missing";
}

function canAccessJobThroughPlaylist(user, job, playlistId) {
  const safePlaylistId = String(playlistId || "").trim();
  if (!safePlaylistId) return filterJobsForUser(user, [job]).length > 0;
  if (!canAccessJobOwner(user, safePlaylistId)) return false;
  if (job.ownerId === safePlaylistId) return true;
  return staticPlaylistReferencesJob(flowPlaylistConfig.getStaticPlaylist(safePlaylistId), job.id);
}

function getAccessibleManualSearchJob(user, jobId, { mode = "missing", playlistId = null } = {}) {
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

function toPublicJob({ stagingPath: _stagingPath, finalPath, externalPath: _externalPath, ...job }) {
  const streamFormat = finalPath ? path.extname(finalPath).slice(1).toLowerCase() : "";
  return { ...job, streamFormat: streamFormat || null };
}

function runQualityChecksLocally(jobIds) {
  return runQualityUpgradeCheck({ force: true, jobIds, limit: 500 });
}

export function registerJobs(router) {
  router.get("/status", noCache, (req, res) => {
    res.json(getPlaylistStatusSnapshot({ user: req.user }));
  });

  router.get("/jobs/:playlistId", noCache, async (req, res) => {
    const { playlistId } = req.params;
    if (!canAccessPlaylist(req.user, playlistId)) {
      return res.status(404).json({ error: "Playlist not found" });
    }
    const rawLimit =
      req.query.limit == null ? "" : String(req.query.limit).trim();
    const parsedLimit = Number(rawLimit);
    const limit =
      rawLimit && Number.isFinite(parsedLimit) && parsedLimit > 0
        ? Math.floor(parsedLimit)
        : null;
    const staticPlaylist = flowPlaylistConfig.getStaticPlaylist(playlistId);
    let jobs = staticPlaylist
      ? getStaticPlaylistJobs(staticPlaylist)
        .slice(0, limit ?? undefined)
        .map((job) => ({ ...job, playlistId }))
      : downloadTracker.getByOwner(playlistId, limit);
    const profile = getQualityProfile();
    const accessibleJobs = filterJobsForUser(req.user, jobs).map((job) =>
      decorateJobQuality(job, profile),
    );
    const libraryOwnership = getLibraryTrackOwnershipBatch(accessibleJobs);
    res.json(
      accessibleJobs.map((job, index) => ({
        ...toPublicJob(job),
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
    const isUnmonitored = indexUnmonitoredJobs();
    res.json(jobs.map((job) => ({
      ...toPublicJob(decorateJobQuality(job, profile)),
      monitored: !isUnmonitored(job),
    })));
  });

  router.get("/jobs/:jobId/files", requireAdmin, noCache, (req, res) => {
    const job = downloadTracker.getJob(req.params.jobId);
    if (!job) return res.status(404).json({ error: "Track not found" });
    res.json({ paths: [job.finalPath].filter(Boolean) });
  });

  router.get("/jobs/:jobId/manual-search/sources", noCache, (req, res) => {
    const mode = getManualSearchMode(req.query?.mode);
    const playlistId = req.query?.playlistId;
    const job = getAccessibleManualSearchJob(req.user, req.params.jobId, { mode, playlistId });
    if (!job) return res.status(404).json({ error: "Track is not available for manual search" });
    return res.json({ sources: getManualDownloadSources() });
  });

  router.post("/jobs/:jobId/manual-search", async (req, res) => {
    const mode = getManualSearchMode(req.body?.mode);
    const playlistId = req.body?.playlistId;
    const job = getAccessibleManualSearchJob(req.user, req.params.jobId, { mode, playlistId });
    if (!job) return res.status(404).json({ error: "Track is not available for manual search" });
    try {
      const result = await createManualMissingSearch({
        job,
        sourceId: req.body?.sourceId,
        actorId: getActorId(req.user),
        mode,
        playlistId,
      });
      return res.json(result);
    } catch (error) {
      logger.warn("manual-search", "Manual track search failed", {
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
    try {
      const selection = getManualMissingSelection({
        sessionId: req.body?.sessionId,
        resultId: req.body?.resultId,
        jobId: req.params.jobId,
        actorId: getActorId(req.user),
      });
      const job = getAccessibleManualSearchJob(req.user, req.params.jobId, {
        mode: selection.mode,
        playlistId: selection.playlistId,
      });
      if (!job) {
        return res.status(409).json({ error: "Track is no longer available for manual search" });
      }
      const replacement = selection.mode === "replacement";
      const queued = isDownloadOwnerProcess()
        ? replacement
          ? downloadTracker.enqueueManualReplacementSelection(job.id, selection)
          : downloadTracker.enqueueManualSelection(job.id, selection)
        : await requestDownloadOwner(
          replacement ? "enqueueManualReplacementSelection" : "enqueueManualMissingSelection",
          [job.id, selection], {
            timeoutMs: 30_000,
          },
        );
      if (!queued) {
        return res.status(409).json({
          error: "Track is no longer available for manual search",
        });
      }
      consumeManualMissingSelection(req.body?.sessionId);
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
      const requeued = await downloadWorker.researchMissingJobs(getAccessibleJobIds(req.user));
      return res.json({ success: true, requeued });
    } catch (error) {
      return res.status(500).json({
        error: "Failed to re-search missing tracks",
        message: error.message,
      });
    }
  });

  router.post("/quality-upgrades", async (req, res) => {
    const jobIds = getAccessibleJobIds(req.user);
    const queued = isDownloadOwnerProcess()
      ? await runQualityChecksLocally(jobIds)
      : await requestDownloadOwner("runQualityUpgradeChecks", [jobIds, 500], {
        timeoutMs: 30 * 60 * 1000,
      });
    if (queued > 0) invalidateRequestsCache();
    return res.json({
      success: true,
      queued,
      playlistCount: getAccessiblePlaylistIds(req.user).length,
    });
  });

  router.post("/quality-upgrades/:playlistId/:jobId", async (req, res) => {
    const { playlistId, jobId } = req.params;
    if (!canAccessJobOwner(req.user, playlistId)) {
      return res.status(404).json({ error: "Playlist not found" });
    }
    const job = downloadTracker.getJob(jobId);
    if (!job || !canAccessJobThroughPlaylist(req.user, job, playlistId)) {
      return res.status(404).json({ error: "Track not found" });
    }
    const result = isDownloadOwnerProcess()
      ? await queueQualityUpgrade(job)
      : await requestDownloadOwner("queueQualityUpgradeForJob", [job.id], {
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

  router.get("/worker/settings", requireAdmin, (req, res) => {
    res.json(downloadWorker.getWorkerSettings());
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
    const settings = await downloadWorker.updateWorkerSettings({
      concurrency,
      existingFileMode,
    });
    return res.json({ success: true, settings });
  });

  router.post("/worker/start", requireAdmin, async (req, res) => {
    try {
      startDownloadPipelineWorker();
      await downloadWorker.start();
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
      await downloadWorker.stopAndDrain();
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

  const reviewBlockedJob = async (method, req, res) => {
    try {
      const outcome = isDownloadOwnerProcess()
        ? await reviewBlockedJobLocally[method](req.params.jobId)
        : await requestDownloadOwner(method, [req.params.jobId], {
          timeoutMs: BLOCKED_JOB_REVIEW_TIMEOUT_MS,
        });
      if (outcome.status !== 200) {
        return res.status(outcome.status).json({ error: outcome.error });
      }
      invalidateRequestsCache();
      return res.json({ success: true, ...(outcome.path ? { path: outcome.path } : {}) });
    } catch (error) {
      return res.status(500).json({
        error: method === "approveBlockedJob" ? "Import failed" : "Deny failed",
        message: error.message,
      });
    }
  };

  router.post("/jobs/:jobId/approve", (req, res) =>
    reviewBlockedJob("approveBlockedJob", req, res));

  router.post("/jobs/:jobId/deny", (req, res) =>
    reviewBlockedJob("denyBlockedJob", req, res));

  router.delete("/jobs/all", requireAdmin, async (req, res) => {
    try {
      const count = await clearAllDownloadJobs(downloadTracker);
      return res.json({ success: true, cleared: count });
    } catch (error) {
      logger.error("downloads", "Could not safely clear download jobs", {
        reason: error?.message || String(error),
      });
      return res.status(500).json({
        error: "Some provider work could not be cancelled. Affected jobs were stopped in Aurral and marked failed. Retry clearing jobs after fixing the provider connection.",
      });
    }
  });

  router.post("/reset", requireAdmin, async (req, res) => {
    try {
      const flowIds = req.body?.flowIds || flowPlaylistConfig.getFlows().map((flow) => flow.id);

      await playlistOperationQueue.enqueuePayload({
        kind: "reset-flows",
        label: "reset:manual",
        flowIds,
      });

      res.json({
        success: true,
        message: `Reset queued for: ${flowIds.join(", ")}`,
      });
    } catch (error) {
      res.status(500).json({
        error: "Failed to reset flows",
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

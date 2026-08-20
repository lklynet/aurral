import fsp from "fs/promises";
import { downloadTracker } from "../../../services/weeklyFlow/weeklyFlowDownloadTracker.js";
import { playlistManager } from "../../../services/weeklyFlow/weeklyFlowPlaylistManager.js";
import {
  buildSharedTrackIdentity,
  flowPlaylistConfig,
} from "../../../services/weeklyFlow/weeklyFlowPlaylistConfig.js";
import { weeklyFlowOperationQueue } from "../../../services/weeklyFlow/weeklyFlowOperationQueue.js";
import {
  remapLegacyPath as remapLegacyWeeklyFlowPath,
} from "../../../services/playlistPaths.js";
import { weeklyFlowWorker } from "../../../services/weeklyFlow/weeklyFlowWorker.js";
import { schedulePlaylistMbidEnrichment } from "../../../services/playlistMbidEnrichmentService.js";
import {
  buildLidarrImportListItems,
} from "../../../services/lidarrImportListFeed.js";
import {
  getUnavailableFlowSourceError,
} from "../../../services/weeklyFlow/weeklyFlowValidation.js";
import {
  DEFAULT_LIMIT,
  validateFlowPayload,
  markFlowMutationToken,
  getAccessibleFlow,
  queueFlowSideEffect,
  enqueueResearchTrack,
} from "./utils.js";

export function registerFlows(router) {
  router.post("/start/:flowId", async (req, res) => {
    try {
      const { flowId } = req.params;
      const { limit } = req.body;
      const flow = getAccessibleFlow(req.user, flowId);
      if (!flow) {
        return res.status(404).json({ error: "Flow not found" });
      }

      const unavailableError = getUnavailableFlowSourceError(flow.mix);
      if (unavailableError) {
        return res.status(400).json({
          error: unavailableError,
          message: unavailableError,
        });
      }

      const { token, tokenScope } = markFlowMutationToken(flowId);
      const result = await weeklyFlowOperationQueue.enqueuePayload({
        kind: "manual-start-flow",
        label: `manual-start:${flowId}`,
        flowId,
        tokenScope,
        token,
        size:
          Number.isFinite(Number(limit)) && Number(limit) > 0
            ? Number(limit)
            : flow.size || DEFAULT_LIMIT,
      });

      return res.json({
        success: true,
        flowId,
        queued: true,
        operationId: result.operationId,
        tracksQueued: 0,
        jobIds: [],
        reserveTracks: 0,
      });
    } catch (error) {
      res.status(500).json({
        error: "Failed to start weekly flow",
        message: error.message,
      });
    }
  });

  router.post("/flows", async (req, res) => {
    try {
      const {
        name,
        mix,
        size,
        deepDive,
        recordHistory,
        yearFrom,
        yearTo,
        tags,
        relatedArtists,
        scheduleDays,
        scheduleTime,
      } = req.body || {};
      const validationError = validateFlowPayload(req.body || {});
      if (validationError) {
        return res.status(400).json({ error: validationError, message: validationError });
      }
      const flow = flowPlaylistConfig.createFlow({
        name,
        mix,
        size,
        deepDive,
        recordHistory,
        yearFrom,
        yearTo,
        tags,
        relatedArtists,
        scheduleDays,
        scheduleTime,
        ownerUserId: req.user.id,
      });
      await playlistManager.ensureSmartPlaylists();
      res.json({ success: true, flow });
    } catch (error) {
      if (error?.code === "FLOW_NAME_CONFLICT") {
        return res.status(400).json({
          error: "Flow name already exists",
          message: error.message,
        });
      }
      res.status(500).json({
        error: "Failed to create flow",
        message: error.message,
      });
    }
  });

  router.put("/flows/:flowId", async (req, res) => {
    try {
      const { flowId } = req.params;
      const existingFlow = getAccessibleFlow(req.user, flowId);
      if (!existingFlow) {
        return res.status(404).json({ error: "Flow not found" });
      }
      const {
        name,
        mix,
        size,
        deepDive,
        recordHistory,
        tags,
        relatedArtists,
        scheduleDays,
        scheduleTime,
      } = req.body || {};
      const validationError = validateFlowPayload({
        ...existingFlow,
        ...req.body,
      });
      if (validationError) {
        return res.status(400).json({ error: validationError, message: validationError });
      }
      const updates = {
        name,
        mix,
        size,
        deepDive,
        recordHistory,
        tags,
        relatedArtists,
        scheduleDays,
        scheduleTime,
      };
      if (Object.prototype.hasOwnProperty.call(req.body || {}, "yearFrom")) {
        updates.yearFrom = req.body.yearFrom;
      }
      if (Object.prototype.hasOwnProperty.call(req.body || {}, "yearTo")) {
        updates.yearTo = req.body.yearTo;
      }
      const updated = flowPlaylistConfig.updateFlow(flowId, updates);
      if (!updated) {
        return res.status(404).json({ error: "Flow not found" });
      }
      await playlistManager.ensureSmartPlaylists();
      res.json({ success: true, flow: updated });
    } catch (error) {
      if (error?.code === "FLOW_NAME_CONFLICT") {
        return res.status(400).json({
          error: "Flow name already exists",
          message: error.message,
        });
      }
      res.status(500).json({
        error: "Failed to update flow",
        message: error.message,
      });
    }
  });

  router.delete("/flows/:flowId", async (req, res) => {
    try {
      const { flowId } = req.params;
      if (!getAccessibleFlow(req.user, flowId)) {
        return res.status(404).json({ error: "Flow not found" });
      }
      const { token, tokenScope } = markFlowMutationToken(flowId);
      const deleted = await weeklyFlowOperationQueue.enqueuePayload({
        kind: "delete-flow",
        label: `delete:${flowId}`,
        flowId,
        tokenScope,
        token,
      });
      return res.json({
        success: true,
        flowId,
        queued: true,
        operationId: deleted.operationId,
      });
    } catch (error) {
      res.status(500).json({
        error: "Failed to delete flow",
        message: error.message,
      });
    }
  });

  router.put("/flows/:flowId/enabled", async (req, res) => {
    try {
      const { flowId } = req.params;
      const { enabled } = req.body;

      if (typeof enabled !== "boolean") {
        return res.status(400).json({ error: "enabled must be a boolean" });
      }

      const flow = getAccessibleFlow(req.user, flowId);
      if (!flow) {
        return res.status(404).json({ error: "Flow not found" });
      }

      if (enabled) {
        const unavailableError = getUnavailableFlowSourceError(flow.mix);
        if (unavailableError) {
          return res.status(400).json({
            error: unavailableError,
            message: unavailableError,
          });
        }
        flowPlaylistConfig.setEnabled(flowId, true);
        flowPlaylistConfig.scheduleNextRun(flowId);

        await playlistManager.ensureSmartPlaylists();

        res.json({
          success: true,
          flowId,
          enabled: true,
          tracksQueued: 0,
          message: "Flow enabled. Tracks will start queueing shortly.",
        });

        queueFlowSideEffect("enable-flow-refresh", "enable", flowId);
      } else {
        flowPlaylistConfig.setEnabled(flowId, false);
        await playlistManager.ensureSmartPlaylists();

        res.json({
          success: true,
          flowId,
          enabled: false,
        });
        queueFlowSideEffect("disable-flow-cleanup", "disable", flowId);
      }
    } catch (error) {
      res.status(500).json({
        error: "Failed to update flow",
        message: error.message,
      });
    }
  });

  router.post("/flows/:flowId/static-playlist", async (req, res) => {
    let playlist = null;
    try {
      const { flowId } = req.params;
      const flow = getAccessibleFlow(req.user, flowId);
      if (!flow) {
        return res.status(404).json({ error: "Flow not found" });
      }

      const requestedName = String(req.body?.name || "").trim();
      const flowJobs = downloadTracker.getByPlaylistType(flowId);
      const completedJobs = flowJobs.filter(
        (job) => job?.status === "done" && typeof job?.finalPath === "string",
      );
      if (completedJobs.length === 0) {
        return res.status(400).json({
          error: "No completed tracks available",
          message: "Generate at least one completed flow track before saving it",
        });
      }

      const uniqueCompletedJobsByIdentity = new Map();
      for (const job of completedJobs) {
        const identity = buildSharedTrackIdentity(job);
        if (uniqueCompletedJobsByIdentity.has(identity)) continue;
        uniqueCompletedJobsByIdentity.set(identity, job);
      }
      const uniqueCompletedJobs = [...uniqueCompletedJobsByIdentity.values()];
      const tracks = uniqueCompletedJobs.map((job) => ({
        artistName: job.artistName,
        trackName: job.trackName,
        albumName: job.albumName || null,
        artistMbid: job.artistMbid || null,
        albumMbid: job.albumMbid || null,
        trackMbid: job.trackMbid || null,
        releaseYear: job.releaseYear || null,
        durationMs: job.durationMs || null,
        artistAliases: job.artistAliases || [],
        reason: job.reason || null,
      }));
      playlist = flowPlaylistConfig.createSharedPlaylist({
        name: requestedName || `${flow.name} Static`,
        sourceName: flow.name,
        sourceFlowId: flowId,
        tracks,
        ownerUserId: flow.ownerUserId ?? req.user.id,
      });

      for (const job of uniqueCompletedJobs) {
        const safeSourcePath = remapLegacyWeeklyFlowPath(
          job.finalPath,
          weeklyFlowWorker.weeklyFlowRoot,
        );
        const stat = await fsp.stat(safeSourcePath);
        if (!stat.isFile()) {
          throw new Error(`Track file is missing: ${job.finalPath}`);
        }

        const jobId = downloadTracker.addJob(
          {
            artistName: job.artistName,
            trackName: job.trackName,
            albumName: job.albumName || null,
            artistMbid: job.artistMbid || null,
            albumMbid: job.albumMbid || null,
            trackMbid: job.trackMbid || null,
            releaseYear: job.releaseYear || null,
            durationMs: job.durationMs || null,
            artistAliases: job.artistAliases || [],
            reason: job.reason || null,
          },
          playlist.id,
        );
        if (jobId) {
          downloadTracker.setDone(jobId, safeSourcePath, job.albumName || null);
        }
      }

      playlistManager.updateConfig(false);
      await playlistManager.ensureSmartPlaylists();
      await playlistManager.scheduleScanLibrary(true);
      schedulePlaylistMbidEnrichment(playlist.id, {
        reason: "flow-static-playlist",
        priority: 5,
      });

      res.json({
        success: true,
        playlist,
        trackCount: uniqueCompletedJobs.length,
      });
    } catch (error) {
      if (playlist?.id) {
        try {
          await playlistManager.weeklyReset([playlist.id]);
          flowPlaylistConfig.deleteSharedPlaylist(playlist.id);
          await playlistManager.ensureSmartPlaylists();
        } catch {}
      }
      if (error?.code === "SHARED_PLAYLIST_NAME_CONFLICT") {
        return res.status(400).json({
          error: "Shared playlist name already exists",
          message: error.message,
        });
      }
      res.status(500).json({
        error: "Failed to create static playlist",
        message: error.message,
      });
    }
  });

  router.post("/flows/:flowId/tracks/:jobId/research", async (req, res) => {
    try {
      const { flowId, jobId } = req.params;
      return await enqueueResearchTrack(req, res, flowId, jobId, "flow");
    } catch (error) {
      res.status(500).json({
        error: "Failed to re-search flow track",
        message: error.message,
      });
    }
  });

  router.get("/flows/:flowId/lidarr-import-list", (req, res) => {
    const { flowId } = req.params;
    const flow = getAccessibleFlow(req.user, flowId);
    if (!flow) {
      return res.status(404).json({ error: "Flow not found" });
    }
    const ensured = flowPlaylistConfig.ensureLidarrFeedToken(flowId);
    if (!ensured?.lidarrFeedToken) {
      return res.status(404).json({ error: "Flow not found" });
    }
    res.json({
      token: ensured.lidarrFeedToken,
      itemCount: buildLidarrImportListItems(downloadTracker.getByPlaylistType(flowId)).length,
    });
  });
}

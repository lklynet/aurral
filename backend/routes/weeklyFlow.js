import express from "express";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { downloadTracker } from "../services/weeklyFlowDownloadTracker.js";
import { weeklyFlowWorker } from "../services/weeklyFlowWorker.js";
import { playlistSource } from "../services/weeklyFlowPlaylistSource.js";
import { soulseekClient } from "../services/simpleSoulseekClient.js";
import { playlistManager } from "../services/weeklyFlowPlaylistManager.js";
import { flowPlaylistConfig } from "../services/weeklyFlowPlaylistConfig.js";
import { weeklyFlowOperationQueue } from "../services/weeklyFlowOperationQueue.js";
import { getWeeklyFlowStatusSnapshot } from "../services/weeklyFlowStatusSnapshot.js";
import { noCache } from "../middleware/cache.js";
import { hasPermission, verifyTokenAuth } from "../middleware/auth.js";
import {
  requireAuth,
  requirePermission,
} from "../middleware/requirePermission.js";

const router = express.Router();
const AUDIO_CONTENT_TYPES = {
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
};

router.get("/stream/:jobId", noCache, async (req, res) => {
  if (!verifyTokenAuth(req)) {
    return res
      .status(401)
      .json({ error: "Unauthorized", message: "Authentication required" });
  }
  if (req.user && !hasPermission(req.user, "accessFlow")) {
    return res
      .status(403)
      .json({ error: "Forbidden", message: "Permission required: accessFlow" });
  }
  const { jobId } = req.params;
  const job = downloadTracker.getJob(jobId);
  if (!job) {
    return res.status(404).json({ error: "Track not found" });
  }
  if (job.status !== "done" || !job.finalPath) {
    return res.status(400).json({ error: "Track is not ready to stream" });
  }
  const safeRoot = path.resolve(weeklyFlowWorker.weeklyFlowRoot);
  const safePath = path.resolve(job.finalPath);
  if (!safePath.startsWith(safeRoot)) {
    return res.status(403).json({ error: "Invalid track path" });
  }
  let stat;
  try {
    stat = await fsp.stat(safePath);
    if (!stat.isFile()) {
      return res.status(404).json({ error: "Track not found" });
    }
  } catch {
    return res.status(404).json({ error: "Track file missing" });
  }
  const ext = path.extname(safePath).toLowerCase();
  res.setHeader(
    "Content-Type",
    AUDIO_CONTENT_TYPES[ext] || "application/octet-stream",
  );
  res.setHeader("Accept-Ranges", "bytes");

  const range = req.headers.range;
  if (!range) {
    res.setHeader("Content-Length", stat.size);
    fs.createReadStream(safePath).pipe(res);
    return;
  }

  const match = /bytes=(\d*)-(\d*)/.exec(range);
  if (!match) {
    res.status(416).end();
    return;
  }
  const rawStart = match[1] ? Number(match[1]) : 0;
  const rawEnd = match[2] ? Number(match[2]) : stat.size - 1;
  const start = Number.isFinite(rawStart) ? rawStart : 0;
  const end = Number.isFinite(rawEnd) ? rawEnd : stat.size - 1;
  if (start < 0 || end < start || end >= stat.size) {
    res.status(416).end();
    return;
  }
  res.status(206);
  res.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
  res.setHeader("Content-Length", end - start + 1);
  fs.createReadStream(safePath, { start, end }).pipe(res);
});

router.use(requireAuth);
router.use(requirePermission("accessFlow"));
const DEFAULT_LIMIT = 30;
const QUEUE_LIMIT = 50;
const flowEnableMutationVersion = new Map();
const queueFlowEnableRefresh = (flowId, mutationVersion) => {
  weeklyFlowOperationQueue
    .enqueue(`enable:${flowId}`, async () => {
      if (
        flowEnableMutationVersion.get(flowId) !== mutationVersion ||
        !flowPlaylistConfig.isEnabled(flowId)
      ) {
        return;
      }

      const flowStats = downloadTracker.getPlaylistTypeStats(flowId);
      const shouldStopWorker =
        weeklyFlowWorker.running &&
        (flowStats.pending > 0 || flowStats.downloading > 0);
      if (shouldStopWorker) {
        weeklyFlowWorker.stop();
      }
      playlistManager.updateConfig(false);
      await playlistManager.weeklyReset([flowId]);
      downloadTracker.clearByPlaylistType(flowId);

      if (
        flowEnableMutationVersion.get(flowId) !== mutationVersion ||
        !flowPlaylistConfig.isEnabled(flowId)
      ) {
        if (shouldStopWorker) {
          const stillPending = downloadTracker.getNextPending();
          if (stillPending && !weeklyFlowWorker.running) {
            await weeklyFlowWorker.start();
          }
        }
        return;
      }

      const latestFlow = flowPlaylistConfig.getFlow(flowId);
      if (!latestFlow) return;
      const tracks = await playlistSource.getTracksForFlow(latestFlow);

      if (
        flowEnableMutationVersion.get(flowId) !== mutationVersion ||
        !flowPlaylistConfig.isEnabled(flowId)
      ) {
        return;
      }

      if (tracks.length === 0) {
        if (shouldStopWorker) {
          const stillPending = downloadTracker.getNextPending();
          if (stillPending && !weeklyFlowWorker.running) {
            await weeklyFlowWorker.start();
          }
        }
        return;
      }
      downloadTracker.addJobs(tracks, flowId);
      if (!weeklyFlowWorker.running) {
        await weeklyFlowWorker.start();
      }
    })
    .catch((error) => {
      console.error(
        `[WeeklyFlow] Failed to generate tracks for ${flowId}:`,
        error.message,
      );
    });
};

const queueFlowDisableCleanup = (flowId, mutationVersion) => {
  weeklyFlowOperationQueue
    .enqueue(`disable:${flowId}`, async () => {
      if (flowEnableMutationVersion.get(flowId) !== mutationVersion) {
        return;
      }

      const flowStats = downloadTracker.getPlaylistTypeStats(flowId);
      const shouldStopWorker =
        weeklyFlowWorker.running &&
        (flowStats.pending > 0 || flowStats.downloading > 0);
      if (shouldStopWorker) {
        weeklyFlowWorker.stop();
      }
      playlistManager.updateConfig(false);
      await playlistManager.weeklyReset([flowId]);
      downloadTracker.clearByPlaylistType(flowId);

      if (flowEnableMutationVersion.get(flowId) !== mutationVersion) {
        return;
      }

      const stillPending = downloadTracker.getNextPending();
      if (stillPending && !weeklyFlowWorker.running) {
        await weeklyFlowWorker.start();
      }
    })
    .catch((error) => {
      console.error(
        `[WeeklyFlow] Failed to disable flow cleanup for ${flowId}:`,
        error.message,
      );
    });
};

router.post("/start/:flowId", async (req, res) => {
  try {
    const { flowId } = req.params;
    const { limit } = req.body;
    const flow = flowPlaylistConfig.getFlow(flowId);
    if (!flow) {
      return res.status(404).json({ error: "Flow not found" });
    }

    if (!soulseekClient.isConfigured()) {
      return res.status(400).json({
        error: "Soulseek credentials not configured",
      });
    }

    const size =
      Number.isFinite(Number(limit)) && Number(limit) > 0
        ? Number(limit)
        : flow.size || DEFAULT_LIMIT;
    const tracks = await playlistSource.getTracksForFlow({
      ...flow,
      size,
    });
    if (tracks.length === 0) {
      return res.status(400).json({
        error: `No tracks found for flow: ${flow.name}`,
      });
    }

    const jobIds = downloadTracker.addJobs(tracks, flowId);

    if (!weeklyFlowWorker.running) {
      await weeklyFlowWorker.start();
    }

    res.json({
      success: true,
      flowId,
      tracksQueued: tracks.length,
      jobIds,
    });
  } catch (error) {
    res.status(500).json({
      error: "Failed to start weekly flow",
      message: error.message,
    });
  }
});

router.get("/status", (req, res) => {
  const includeJobs =
    req.query.includeJobs === "1" || req.query.includeJobs === "true";
  const flowId = req.query.flowId ? String(req.query.flowId) : null;
  const parsedLimit = Number(req.query.jobsLimit);
  const jobsLimit =
    Number.isFinite(parsedLimit) && parsedLimit > 0
      ? Math.min(Math.floor(parsedLimit), 500)
      : null;
  res.json(
    getWeeklyFlowStatusSnapshot({
      includeJobs,
      flowId,
      jobsLimit,
    }),
  );
});

router.post("/flows", async (req, res) => {
  try {
    const {
      name,
      mix,
      size,
      deepDive,
      recipe,
      tags,
      relatedArtists,
      scheduleDays,
    } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: "name is required" });
    }
    const flow = flowPlaylistConfig.createFlow({
      name,
      mix,
      size,
      deepDive,
      recipe,
      tags,
      relatedArtists,
      scheduleDays,
    });
    await playlistManager.ensureSmartPlaylists();
    res.json({ success: true, flow });
  } catch (error) {
    res.status(500).json({
      error: "Failed to create flow",
      message: error.message,
    });
  }
});

router.put("/flows/:flowId", async (req, res) => {
  try {
    const { flowId } = req.params;
    const {
      name,
      mix,
      size,
      deepDive,
      recipe,
      tags,
      relatedArtists,
      scheduleDays,
    } = req.body || {};
    const updated = flowPlaylistConfig.updateFlow(flowId, {
      name,
      mix,
      size,
      deepDive,
      recipe,
      tags,
      relatedArtists,
      scheduleDays,
    });
    if (!updated) {
      return res.status(404).json({ error: "Flow not found" });
    }
    await playlistManager.ensureSmartPlaylists();
    res.json({ success: true, flow: updated });
  } catch (error) {
    res.status(500).json({
      error: "Failed to update flow",
      message: error.message,
    });
  }
});

router.delete("/flows/:flowId", async (req, res) => {
  try {
    const { flowId } = req.params;
    const mutationVersion = (flowEnableMutationVersion.get(flowId) || 0) + 1;
    flowEnableMutationVersion.set(flowId, mutationVersion);
    const deleted = await weeklyFlowOperationQueue.enqueue(
      `delete:${flowId}`,
      async () => {
        if (flowEnableMutationVersion.get(flowId) !== mutationVersion) {
          return false;
        }
        weeklyFlowWorker.stop();
        playlistManager.updateConfig(false);
        await playlistManager.weeklyReset([flowId]);
        downloadTracker.clearByPlaylistType(flowId);
        const didDelete = flowPlaylistConfig.deleteFlow(flowId);
        await playlistManager.ensureSmartPlaylists();
        const stillPending = downloadTracker.getNextPending();
        if (stillPending && !weeklyFlowWorker.running) {
          await weeklyFlowWorker.start();
        }
        flowEnableMutationVersion.delete(flowId);
        return didDelete;
      },
    );
    if (!deleted) {
      return res.status(404).json({ error: "Flow not found" });
    }
    res.json({ success: true, flowId });
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

    const flow = flowPlaylistConfig.getFlow(flowId);
    if (!flow) {
      return res.status(404).json({ error: "Flow not found" });
    }

    if (enabled) {
      const mutationVersion = (flowEnableMutationVersion.get(flowId) || 0) + 1;
      flowEnableMutationVersion.set(flowId, mutationVersion);
      if (!soulseekClient.isConfigured()) {
        return res.status(400).json({
          error: "Soulseek credentials not configured",
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

      queueFlowEnableRefresh(flowId, mutationVersion);
    } else {
      const mutationVersion = (flowEnableMutationVersion.get(flowId) || 0) + 1;
      flowEnableMutationVersion.set(flowId, mutationVersion);
      flowPlaylistConfig.setEnabled(flowId, false);
      await playlistManager.ensureSmartPlaylists();

      res.json({
        success: true,
        flowId,
        enabled: false,
      });
      queueFlowDisableCleanup(flowId, mutationVersion);
    }
  } catch (error) {
    res.status(500).json({
      error: "Failed to update flow",
      message: error.message,
    });
  }
});

router.get("/jobs/:flowId", (req, res) => {
  const { flowId } = req.params;
  const parsedLimit = Number(req.query.limit);
  const limit =
    Number.isFinite(parsedLimit) && parsedLimit > 0
      ? Math.min(Math.floor(parsedLimit), 500)
      : 200;
  const jobs = downloadTracker.getByPlaylistType(flowId).slice(0, limit);
  res.json(jobs);
});

router.get("/jobs", (req, res) => {
  const { status } = req.query;
  const jobs = status
    ? downloadTracker.getByStatus(status)
    : downloadTracker.getAll();
  res.json(jobs);
});

router.post("/worker/start", async (req, res) => {
  try {
    await weeklyFlowWorker.start();
    res.json({ success: true, message: "Worker started" });
  } catch (error) {
    res.status(500).json({
      error: "Failed to start worker",
      message: error.message,
    });
  }
});

router.post("/worker/stop", (req, res) => {
  weeklyFlowWorker.stop();
  res.json({ success: true, message: "Worker stopped" });
});

router.delete("/jobs/completed", (req, res) => {
  const count = downloadTracker.clearCompleted();
  res.json({ success: true, cleared: count });
});

router.delete("/jobs/all", (req, res) => {
  const count = downloadTracker.clearAll();
  res.json({ success: true, cleared: count });
});

router.post("/reset", async (req, res) => {
  try {
    const { flowIds } = req.body;
    const types =
      flowIds || flowPlaylistConfig.getFlows().map((flow) => flow.id);

    await weeklyFlowOperationQueue.enqueue("reset:manual", async () => {
      weeklyFlowWorker.stop();
      playlistManager.updateConfig(false);
      await playlistManager.weeklyReset(types);
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

router.post("/playlist/:playlistType/create", async (req, res) => {
  try {
    playlistManager.updateConfig(false);
    await playlistManager.ensureSmartPlaylists();
    res.json({
      success: true,
      message:
        "Smart playlists ensured. Tracks in aurral-weekly-flow/<flow-id> will appear in matching smart playlists after Navidrome scans the flow library.",
    });
  } catch (error) {
    res.status(500).json({
      error: "Failed to ensure smart playlists or trigger scan",
      message: error.message,
    });
  }
});

router.get("/test/soulseek", async (req, res) => {
  try {
    if (!soulseekClient.isConfigured()) {
      return res.status(400).json({
        error: "Soulseek not configured",
        configured: false,
      });
    }

    const connected = soulseekClient.isConnected();
    if (!connected) {
      try {
        await soulseekClient.connect();
      } catch (error) {
        return res.status(500).json({
          error: "Failed to connect to Soulseek",
          message: error.message,
          configured: true,
          connected: false,
        });
      }
    }

    res.json({
      success: true,
      configured: true,
      connected: true,
      message: "Soulseek client is ready",
    });
  } catch (error) {
    res.status(500).json({
      error: "Soulseek test failed",
      message: error.message,
    });
  }
});

router.post("/test/download", async (req, res) => {
  try {
    const { artistName, trackName } = req.body;

    if (!artistName || !trackName) {
      return res.status(400).json({
        error: "artistName and trackName are required",
      });
    }

    if (!soulseekClient.isConfigured()) {
      return res.status(400).json({
        error: "Soulseek not configured",
      });
    }

    if (!soulseekClient.isConnected()) {
      await soulseekClient.connect();
    }

    const searchWithTimeout = (ms) =>
      Promise.race([
        soulseekClient.search(artistName, trackName),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Search timed out")), ms),
        ),
      ]);

    const results = await searchWithTimeout(15000);
    if (!results || results.length === 0) {
      return res.status(404).json({
        error: "No search results found",
        artistName,
        trackName,
      });
    }

    const bestMatch = soulseekClient.pickBestMatch(results, trackName);
    if (!bestMatch) {
      return res.status(404).json({
        error: "No suitable match found",
        resultsCount: results.length,
      });
    }

    res.json({
      success: true,
      artistName,
      trackName,
      resultsCount: results.length,
      bestMatch: {
        file: bestMatch.file,
        size: bestMatch.size,
        user: bestMatch.user,
        slots: bestMatch.slots,
      },
      message: "Search successful - ready to download",
    });
  } catch (error) {
    console.error("[weekly-flow] test/download error:", error);
    res.status(500).json({
      error: "Test download failed",
      message: error?.message || String(error),
    });
  }
});

export default router;

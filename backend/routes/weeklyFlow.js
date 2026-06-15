import express from "express";
import { randomUUID } from "crypto";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { downloadTracker } from "../services/weeklyFlowDownloadTracker.js";
import { weeklyFlowWorker } from "../services/weeklyFlowWorker.js";
import { slskdClient } from "../services/slskdClient.js";
import { startSlskdOrchestratorWorker } from "../services/slskdOrchestratorWorker.js";
import { playlistManager } from "../services/weeklyFlowPlaylistManager.js";
import {
  buildSharedTrackIdentity,
  dedupeSharedTracks,
  filterMissingSharedTracks,
  flowPlaylistConfig,
} from "../services/weeklyFlowPlaylistConfig.js";
import { weeklyFlowOperationQueue } from "../services/weeklyFlowOperationQueue.js";
import {
  createWeeklyFlowOperationToken,
  markLatestWeeklyFlowOperationToken,
} from "../services/weeklyFlowOperations.js";
import {
  restartWorkerIfPending as restartWorkerIfPendingWithLocks,
  withPlaylistMutation,
} from "../services/weeklyFlowMutationGuards.js";
import { getWeeklyFlowStatusSnapshot } from "../services/weeklyFlowStatusSnapshot.js";
import {
  normalizeExistingFileMode,
  reuseTrackForPlaylist,
} from "../services/weeklyFlowFileReuse.js";
import {
  recordFlowGenerationStarted,
  recordFlowTracksGenerated,
  recordPlaylistTracksAdded,
} from "../services/aurralHistoryService.js";
import { PLAYLIST_LIBRARY_DIR } from "../services/playlistPaths.js";
import {
  remapLegacyWeeklyFlowPath,
  resolveExistingWeeklyFlowTrackPath,
} from "../services/weeklyFlowPaths.js";
import { noCache } from "../middleware/cache.js";
import { hasPermission, verifyTokenAuth } from "../middleware/auth.js";
import {
  requireAuth,
  requireAdmin,
  requirePermission,
} from "../middleware/requirePermission.js";
import { getLastfmApiKey } from "../services/apiClients.js";

const router = express.Router();
const EXISTING_FILE_MODE_OPTIONS = ["download", "reuse"];
const AUDIO_CONTENT_TYPES = {
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
};

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

const normalizeFlowStringArray = (value) => {
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

const normalizeFlowMixForValidation = (mix, recipe) => {
  const source = mix && typeof mix === "object" && !Array.isArray(mix)
    ? mix
    : recipe && typeof recipe === "object" && !Array.isArray(recipe)
      ? recipe
      : {};
  return {
    discover: Math.max(0, Number(source?.discover || 0) || 0),
    mix: Math.max(0, Number(source?.mix || 0) || 0),
    trending: Math.max(0, Number(source?.trending || 0) || 0),
    focus: Math.max(0, Number(source?.focus || 0) || 0),
  };
};

const getUnavailableFlowSourceError = (mix) => {
  if (getLastfmApiKey()) return null;
  const normalizedMix = normalizeFlowMixForValidation(mix);
  if (normalizedMix.discover > 0) return "Discover flow source requires Last.fm";
  if (normalizedMix.trending > 0) return "Trending flow source requires Last.fm";
  if (normalizedMix.focus > 0) return "Focus flow source requires Last.fm";
  if (normalizedMix.mix > 0) {
    return "Library flow source requires Last.fm in this version";
  }
  return null;
};

const validateFlowPayload = ({
  name,
  mix,
  recipe,
  size,
  tags,
  relatedArtists,
  scheduleDays,
} = {}) => {
  if (!name || !String(name).trim()) {
    return "name is required";
  }
  const parsedSize = Number(size);
  if (!Number.isFinite(parsedSize) || parsedSize <= 0) {
    return "size must be a positive number";
  }
  const normalizedMix = normalizeFlowMixForValidation(mix, recipe);
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
  return null;
};

const isPathInsideRoot = (candidatePath, rootPath) => {
  const relative = path.relative(rootPath, candidatePath);
  return (
    relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  );
};

const normalizeImportedTrackList = (value) => {
  if (!Array.isArray(value)) return [];
  return dedupeSharedTracks(
    value
      .map((track) => {
        if (!track || typeof track !== "object" || Array.isArray(track))
          return null;
        const artistName = String(
          track.artistName ??
            track.artist ??
            track.artist_name ??
            track["Artist Name(s)"] ??
            "",
        ).trim();
        const trackName = String(
          track.trackName ??
            track.title ??
            track.name ??
            track.track ??
            track["Track Name"] ??
            "",
        ).trim();
        if (!artistName || !trackName) return null;
        const albumName = String(
          track.albumName ?? track.album ?? track["Album Name"] ?? "",
        ).trim();
        const artistMbid = String(
          track.artistMbid ?? track.artistId ?? track.mbid ?? "",
        ).trim();
        const albumMbid = String(
          track.albumMbid ?? track.releaseGroupMbid ?? track.albumId ?? "",
        ).trim();
        const trackMbid = String(
          track.trackMbid ?? track.recordingMbid ?? track.recordingId ?? "",
        ).trim();
        const releaseYear = String(
          track.releaseYear ?? track.year ?? "",
        ).trim();
        const durationMs =
          track.durationMs != null && Number.isFinite(Number(track.durationMs))
            ? Math.max(0, Math.round(Number(track.durationMs)))
            : null;
        const artistAliases = Array.isArray(track.artistAliases)
          ? track.artistAliases
              .map((entry) => String(entry || "").trim())
              .filter(Boolean)
          : [];
        const reason = String(track.reason ?? "").trim();
        return {
          artistName,
          trackName,
          albumName: albumName || null,
          artistMbid: artistMbid || null,
          albumMbid: albumMbid || null,
          trackMbid: trackMbid || null,
          releaseYear: releaseYear || null,
          durationMs,
          artistAliases,
          reason: reason || null,
        };
      })
      .filter(Boolean),
  );
};

const buildTrackIdentity = (track) => buildSharedTrackIdentity(track);

const sortJobsForTrackReuse = (jobs) =>
  [...jobs].sort((a, b) => {
    const priority = (job) => {
      if (job?.status === "done") return 0;
      if (job?.status === "failed") return 1;
      if (job?.status === "downloading") return 2;
      if (job?.status === "pending") return 3;
      return 4;
    };
    const priorityDiff = priority(a) - priority(b);
    if (priorityDiff !== 0) return priorityDiff;
    return Number(a?.createdAt || 0) - Number(b?.createdAt || 0);
  });

const getPlaylistLibraryRoot = (playlistType) =>
  path.resolve(
    weeklyFlowWorker.weeklyFlowRoot,
    PLAYLIST_LIBRARY_DIR,
    String(playlistType || "").trim(),
  );

const reuseTracksForPlaylist = async (tracks, playlistId) => {
  const settings = weeklyFlowWorker.getWorkerSettings();
  const existingFileMode = normalizeExistingFileMode(settings.existingFileMode);
  const reusedJobIds = [];
  const tracksToQueue = [];
  for (const track of Array.isArray(tracks) ? tracks : []) {
    const reuse = await reuseTrackForPlaylist(track, playlistId, {
      existingFileMode,
      weeklyFlowRoot: weeklyFlowWorker.weeklyFlowRoot,
      targetPlaylistType: playlistId,
      skipHistory: true,
    });
    if (reuse.reused) {
      reusedJobIds.push(reuse.jobId);
    } else {
      tracksToQueue.push(track);
    }
  }
  return { reusedJobIds, tracksToQueue };
};

const recordPlaylistHistory = (playlistId, { tracksQueued = 0, tracksReused = 0 } = {}) => {
  if (tracksQueued + tracksReused <= 0) return;
  recordPlaylistTracksAdded({
    playlistId,
    tracksQueued,
    tracksReused,
  });
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
  if (!canAccessPlaylistType(req.user, job.playlistType)) {
    return res.status(404).json({ error: "Track not found" });
  }
  if (job.status !== "done" || !job.finalPath) {
    return res.status(400).json({ error: "Track is not ready to stream" });
  }
  const resolved = await resolveExistingWeeklyFlowTrackPath(
    job.finalPath,
    weeklyFlowWorker.weeklyFlowRoot,
  );
  if (!resolved) {
    return res.status(404).json({ error: "Track file missing" });
  }
  if (resolved.migratedFrom) {
    downloadTracker.setDone(job.id, resolved.path, job.albumName || null);
  }
  const safePath = resolved.path;
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

router.get("/artwork/:playlistId", noCache, async (req, res) => {
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

  const { playlistId } = req.params;
  if (!canAccessPlaylistType(req.user, playlistId)) {
    return res.status(404).json({ error: "Playlist artwork not found" });
  }
  const artwork = await playlistManager.resolveArtworkFile(playlistId);
  if (!artwork) {
    return res.status(404).json({ error: "Playlist artwork not found" });
  }

  const { getArtworkContentTypeForExtension } =
    await import("../services/playlistArtworkGenerator.js");
  res.type(getArtworkContentTypeForExtension(artwork.extension));
  res.sendFile(artwork.safePath);
});

const artworkUploadParser = express.raw({
  limit: "8mb",
  type: (req) => {
    const contentType = String(req.headers["content-type"] || "").toLowerCase();
    return contentType.startsWith("image/");
  },
});

router.use(requireAuth);
router.use(requirePermission("accessFlow"));
const DEFAULT_LIMIT = 30;
const QUEUE_LIMIT = 50;

const markFlowMutationToken = (flowId) => {
  const token = createWeeklyFlowOperationToken();
  const tokenScope = `flow:${flowId}:mutation`;
  markLatestWeeklyFlowOperationToken(tokenScope, token);
  return { token, tokenScope };
};

const restartWorkerIfPending = restartWorkerIfPendingWithLocks;

const pauseSharedPlaylistRetryCycle = async (playlistId) => {
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

const getAccessibleFlow = (user, flowId) =>
  flowPlaylistConfig.getFlowForUser(user, flowId);

const getAccessibleSharedPlaylist = (user, playlistId) =>
  flowPlaylistConfig.getSharedPlaylistForUser(user, playlistId);

const canAccessPlaylistType = (user, playlistType) => {
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

router.put("/artwork/:playlistId", artworkUploadParser, async (req, res) => {
  const { playlistId } = req.params;
  if (!canAccessPlaylistType(req.user, playlistId)) {
    return res.status(404).json({ error: "Playlist not found" });
  }
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    return res.status(400).json({
      error: "Bad Request",
      message: "Image body is required",
    });
  }
  try {
    await playlistManager.saveArtworkUpload(playlistId, req.body);
    return res.json({ ok: true });
  } catch (error) {
    return res.status(400).json({
      error: "Bad Request",
      message: error?.message || "Failed to save artwork",
    });
  }
});

router.delete("/artwork/:playlistId", async (req, res) => {
  const { playlistId } = req.params;
  if (!canAccessPlaylistType(req.user, playlistId)) {
    return res.status(404).json({ error: "Playlist not found" });
  }
  try {
    await playlistManager.removeArtwork(playlistId);
    return res.json({ ok: true });
  } catch (error) {
    return res.status(400).json({
      error: "Bad Request",
      message: error?.message || "Failed to remove artwork",
    });
  }
});

router.post("/artwork/:playlistId/generate", async (req, res) => {
  const { playlistId } = req.params;
  if (!canAccessPlaylistType(req.user, playlistId)) {
    return res.status(404).json({ error: "Playlist not found" });
  }
  try {
    await playlistManager.generateArtwork(playlistId);
    return res.json({ ok: true });
  } catch (error) {
    return res.status(400).json({
      error: "Bad Request",
      message: error?.message || "Failed to generate artwork",
    });
  }
});

const filterJobsForUser = (user, jobs) =>
  (Array.isArray(jobs) ? jobs : []).filter((job) =>
    canAccessPlaylistType(user, job?.playlistType),
  );

const queueFlowEnableRefresh = (flowId) => {
  const { token, tokenScope } = markFlowMutationToken(flowId);
  weeklyFlowOperationQueue
    .enqueuePayload(
      {
        kind: "enable-flow-refresh",
        label: `enable:${flowId}`,
        flowId,
        tokenScope,
        token,
      },
      { waitForCompletion: false },
    )
    .catch((error) => {
      console.error(
        `[WeeklyFlow] Failed to generate tracks for ${flowId}:`,
        error.message,
      );
    });
};

const queueFlowDisableCleanup = (flowId) => {
  const { token, tokenScope } = markFlowMutationToken(flowId);
  weeklyFlowOperationQueue
    .enqueuePayload(
      {
        kind: "disable-flow-cleanup",
        label: `disable:${flowId}`,
        flowId,
        tokenScope,
        token,
      },
      { waitForCompletion: false },
    )
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
    const flow = getAccessibleFlow(req.user, flowId);
    if (!flow) {
      return res.status(404).json({ error: "Flow not found" });
    }

    if (!slskdClient.isConfigured()) {
      return res.status(400).json({
        error: "slskd not configured",
      });
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

    if (result?.missing) {
      return res.status(404).json({ error: "Flow not found" });
    }
    if (result?.cancelled) {
      return res.status(409).json({
        error: "Flow start superseded by another change",
      });
    }
    if (result?.empty) {
      return res.status(400).json({
        error: `No tracks found for flow: ${result.flowName || flow.name}`,
      });
    }
    if (result?.queued) {
      return res.json({
        success: true,
        flowId,
        queued: true,
        operationId: result.operationId,
        tracksQueued: 0,
        jobIds: [],
        reserveTracks: 0,
      });
    }

    res.json({
      success: true,
      flowId,
      tracksQueued: result?.tracksQueued || 0,
      jobIds: result?.jobIds || [],
      reserveTracks: result?.reserveTracks || 0,
    });
  } catch (error) {
    res.status(500).json({
      error: "Failed to start weekly flow",
      message: error.message,
    });
  }
});

router.get("/status", noCache, (req, res) => {
  const includeJobs =
    req.query.includeJobs === "1" || req.query.includeJobs === "true";
  const flowId = req.query.flowId ? String(req.query.flowId) : null;
  const parsedLimit = Number(req.query.jobsLimit);
  const jobsLimit =
    Number.isFinite(parsedLimit) && parsedLimit > 0
      ? Math.min(Math.floor(parsedLimit), 500)
      : null;
  const snapshot = getWeeklyFlowStatusSnapshot({
    user: req.user,
    includeJobs,
    flowId,
    jobsLimit,
  });
  res.json({
    ...snapshot,
    slskd: snapshot.slskd,
  });
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
      recipe,
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
      recipe,
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
    const updated = flowPlaylistConfig.updateFlow(flowId, {
      name,
      mix,
      size,
      deepDive,
      recipe,
      tags,
      relatedArtists,
      scheduleDays,
      scheduleTime,
    });
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
    if (deleted?.queued) {
      return res.json({ success: true, flowId, queued: true });
    }
    if (deleted?.cancelled) {
      return res.status(409).json({
        error: "Flow delete superseded by another change",
      });
    }
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
      if (!slskdClient.isConfigured()) {
        return res.status(400).json({
          error: "slskd not configured",
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

      queueFlowEnableRefresh(flowId);
    } else {
      flowPlaylistConfig.setEnabled(flowId, false);
      await playlistManager.ensureSmartPlaylists();

      res.json({
        success: true,
        flowId,
        enabled: false,
      });
      queueFlowDisableCleanup(flowId);
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
      const identity = buildTrackIdentity(job);
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

router.post("/shared-playlists", async (req, res) => {
  try {
    const {
      name,
      sourceName = null,
      sourceFlowId = null,
      tracks,
    } = req.body || {};
    const safeName = String(name || "").trim();
    const normalizedTracks = normalizeImportedTrackList(tracks);
    const rawTracksProvided = Array.isArray(tracks);

    if (!safeName) {
      return res.status(400).json({ error: "name is required" });
    }
    if (rawTracksProvided && tracks.length > 0 && normalizedTracks.length === 0) {
      return res.status(400).json({
        error: "tracks are invalid",
        message: "Add at least one valid track",
      });
    }

    const result = await weeklyFlowOperationQueue.enqueuePayload({
      kind: "shared-playlist-create",
      label: "shared-playlist:create",
      playlistId: randomUUID(),
      name: safeName,
      sourceName,
      sourceFlowId,
      tracks: normalizedTracks,
      ownerUserId: req.user.id,
    });

    res.json({
      success: true,
      playlist: result?.playlist || null,
      tracksQueued: Number(result?.tracksQueued || 0),
      tracksReused: Number(result?.tracksReused || 0),
      jobIds: result?.jobIds || [],
      queued: result?.queued === true,
    });
  } catch (error) {
    if (error?.code === "SHARED_PLAYLIST_NAME_CONFLICT") {
      return res.status(400).json({
        error: "Shared playlist name already exists",
        message: error.message,
      });
    }
    res.status(500).json({
      error: "Failed to create shared playlist",
      message: error.message,
    });
  }
});

router.post("/shared-playlists/import", async (req, res) => {
  try {
    const {
      name,
      sourceName = null,
      sourceFlowId = null,
      tracks,
    } = req.body || {};
    const safeName = String(name || "").trim();
    const normalizedTracks = normalizeImportedTrackList(tracks);

    if (!safeName) {
      return res.status(400).json({ error: "name is required" });
    }
    if (normalizedTracks.length === 0) {
      return res.status(400).json({
        error: "tracks are required",
        message: "Import file must include at least one track",
      });
    }
    if (!slskdClient.isConfigured()) {
      return res.status(400).json({
        error: "slskd not configured",
      });
    }

    const result = await weeklyFlowOperationQueue.enqueuePayload({
      kind: "shared-playlist-create",
      label: "shared-playlist:import",
      playlistId: randomUUID(),
      name: safeName,
      sourceName,
      sourceFlowId,
      tracks: normalizedTracks,
      ownerUserId: req.user.id,
    });

    res.json({
      success: true,
      playlist: result?.playlist || null,
      tracksQueued: Number(result?.tracksQueued || 0),
      tracksReused: Number(result?.tracksReused || 0),
      jobIds: result?.jobIds || [],
      queued: result?.queued === true,
    });
  } catch (error) {
    if (error?.code === "SHARED_PLAYLIST_NAME_CONFLICT") {
      return res.status(400).json({
        error: "Shared playlist name already exists",
        message: error.message,
      });
    }
    res.status(500).json({
      error: "Failed to import shared playlist",
      message: error.message,
    });
  }
});

router.post("/shared-playlists/:playlistId/tracks", async (req, res) => {
  try {
    const { playlistId } = req.params;
    const playlist = getAccessibleSharedPlaylist(req.user, playlistId);
    if (!playlist) {
      return res.status(404).json({ error: "Shared playlist not found" });
    }
    const rawTracks = req.body?.tracks;
    const normalizedTracks = normalizeImportedTrackList(rawTracks);
    if (Array.isArray(rawTracks) && rawTracks.length > 0 && normalizedTracks.length === 0) {
      return res.status(400).json({
        error: "tracks are invalid",
        message: "Add at least one valid track",
      });
    }
    if (normalizedTracks.length === 0) {
      return res.status(400).json({
        error: "tracks are required",
        message: "Add at least one valid track",
      });
    }

    const result = await weeklyFlowOperationQueue.enqueuePayload({
      kind: "shared-playlist-append-tracks",
      label: `shared-playlist:${playlistId}:tracks:add`,
      playlistId,
      tracks: normalizedTracks,
    });
    if (result?.missing) {
      return res.status(404).json({ error: "Shared playlist not found" });
    }

    res.json({
      success: true,
      playlist: result?.playlist || playlist,
      tracksQueued: Number(result?.tracksQueued || 0),
      tracksReused: Number(result?.tracksReused || 0),
      jobIds: result?.jobIds || [],
      queued: result?.queued === true,
    });
  } catch (error) {
    res.status(500).json({
      error: "Failed to add playlist tracks",
      message: error.message,
    });
  }
});

router.put("/shared-playlists/:playlistId", async (req, res) => {
  try {
    const { playlistId } = req.params;
    const { name, tracks } = req.body || {};
    const hasNameUpdate = Object.prototype.hasOwnProperty.call(
      req.body || {},
      "name",
    );
    const hasTracksUpdate = Object.prototype.hasOwnProperty.call(
      req.body || {},
      "tracks",
    );
    if (!hasNameUpdate && !hasTracksUpdate) {
      return res.status(400).json({
        error: "At least one playlist field is required",
      });
    }
    const currentPlaylist = getAccessibleSharedPlaylist(req.user, playlistId);
    if (!currentPlaylist) {
      return res.status(404).json({ error: "Shared playlist not found" });
    }
    const safeName = hasNameUpdate
      ? String(name || "").trim()
      : String(currentPlaylist.name || "").trim();
    if (!safeName) {
      return res.status(400).json({ error: "name is required" });
    }
    const normalizedTracks = hasTracksUpdate
      ? normalizeImportedTrackList(tracks)
      : currentPlaylist.tracks;
    if (
      hasTracksUpdate &&
      Array.isArray(tracks) &&
      tracks.length > 0 &&
      normalizedTracks.length === 0
    ) {
      return res.status(400).json({
        error: "tracks are invalid",
        message: "Playlist update must include at least one valid track",
      });
    }

    const result = await weeklyFlowOperationQueue.enqueuePayload({
      kind: "shared-playlist-update",
      label: `shared-playlist:${playlistId}:update`,
      playlistId,
      name: safeName,
      tracks: normalizedTracks,
      hasNameUpdate,
      hasTracksUpdate,
    });
    if (result?.missing) {
      return res.status(404).json({ error: "Shared playlist not found" });
    }
    res.json({
      success: true,
      playlist: result?.playlist || currentPlaylist,
      tracksQueued: Number(result?.tracksQueued || 0),
      queued: result?.queued === true,
    });
  } catch (error) {
    if (error?.code === "SHARED_PLAYLIST_NAME_CONFLICT") {
      return res.status(400).json({
        error: "Shared playlist name already exists",
        message: error.message,
      });
    }
    res.status(500).json({
      error: "Failed to update shared playlist",
      message: error.message,
    });
  }
});

router.delete(
  "/shared-playlists/:playlistId/tracks/:jobId",
  async (req, res) => {
    try {
      const { playlistId, jobId } = req.params;
      const playlist = getAccessibleSharedPlaylist(req.user, playlistId);
      if (!playlist) {
        return res.status(404).json({ error: "Shared playlist not found" });
      }
      const job = downloadTracker.getJob(jobId);
      if (!job || job.playlistType !== playlistId) {
        return res.status(404).json({ error: "Track not found" });
      }
      const result = await weeklyFlowOperationQueue.enqueuePayload({
        kind: "shared-playlist-delete-track",
        label: `shared-playlist:${playlistId}:track:${jobId}:delete`,
        playlistId,
        jobId,
      });
      if (result?.missingPlaylist) {
        return res.status(404).json({ error: "Shared playlist not found" });
      }
      if (result?.missingJob) {
        return res.status(404).json({ error: "Track not found" });
      }

      res.json({
        success: true,
        playlist: result?.playlist || playlist,
        removedJobId: result?.removedJobId || jobId,
        queued: result?.queued === true,
      });
    } catch (error) {
      res.status(500).json({
        error: "Failed to remove shared playlist track",
        message: error.message,
      });
    }
  },
);

router.post(
  "/shared-playlists/:playlistId/tracks/:jobId/research",
  async (req, res) => {
    try {
      const { playlistId, jobId } = req.params;
      const playlist = getAccessibleSharedPlaylist(req.user, playlistId);
      if (!playlist) {
        return res.status(404).json({ error: "Shared playlist not found" });
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
        label: `shared-playlist:${playlistId}:track:${jobId}:research`,
        playlistId,
        jobId,
      });
      if (result?.missingPlaylist) {
        return res.status(404).json({ error: "Shared playlist not found" });
      }
      if (result?.missingJob) {
        return res.status(404).json({ error: "Track not found" });
      }
      if (result?.alreadyProcessing) {
        return res.status(409).json({
          error: "Track is already being processed",
        });
      }

      res.json({
        success: true,
        jobId,
        playlistId,
        queued: result?.queued === true,
      });
    } catch (error) {
      res.status(500).json({
        error: "Failed to re-search shared playlist track",
        message: error.message,
      });
    }
  },
);

router.delete("/shared-playlists/:playlistId", async (req, res) => {
  try {
    const { playlistId } = req.params;
    const exists = getAccessibleSharedPlaylist(req.user, playlistId);
    if (!exists) {
      return res.status(404).json({ error: "Shared playlist not found" });
    }

    const deleted = await weeklyFlowOperationQueue.enqueuePayload({
      kind: "shared-playlist-delete",
      label: `shared-playlist:${playlistId}:delete`,
      playlistId,
    });
    if (deleted?.queued) {
      return res.json({ success: true, playlistId, queued: true });
    }
    if (!deleted) {
      return res.status(404).json({ error: "Shared playlist not found" });
    }

    res.json({ success: true, playlistId });
  } catch (error) {
    res.status(500).json({
      error: "Failed to delete shared playlist",
      message: error.message,
    });
  }
});

router.get("/jobs/:flowId", (req, res) => {
  const { flowId } = req.params;
  if (!canAccessPlaylistType(req.user, flowId)) {
    return res.status(404).json({ error: "Playlist not found" });
  }
  const parsedLimit = Number(req.query.limit);
  const limit =
    Number.isFinite(parsedLimit) && parsedLimit > 0
      ? Math.min(Math.floor(parsedLimit), 500)
      : 200;
  const jobs = filterJobsForUser(
    req.user,
    downloadTracker.getByPlaylistType(flowId, limit),
  );
  res.json(jobs);
});

router.get("/jobs", (req, res) => {
  const { status } = req.query;
  const jobs = filterJobsForUser(
    req.user,
    status ? downloadTracker.getByStatus(status) : downloadTracker.getAll(),
  );
  res.json(jobs);
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
      weeklyFlowWorker.setRetryCyclePaused(playlistId, false);
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
  const settings = weeklyFlowWorker.updateWorkerSettings({
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

router.delete("/jobs/all", requireAdmin, (req, res) => {
  const count = downloadTracker.clearAll();
  res.json({ success: true, cleared: count });
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
        "Playlists ensured. M3U files in the Aurral playlist library reference completed track paths and import after Navidrome scans that library.",
    });
  } catch (error) {
    res.status(500).json({
      error: "Failed to ensure playlists or trigger scan",
      message: error.message,
    });
  }
});

export default router;

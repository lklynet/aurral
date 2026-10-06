import { cleanupBulkOperations, getBulkOperation } from "../../../services/playlists/bulkOperationStore.js";
import {
  captureStaticPlaylistSelection,
  getReleasedUnfinishedJobs,
  getStaticPlaylistJobIds,
  staticPlaylistReferencesJob,
} from "../../../services/playlists/staticPlaylistJobs.js";
import { randomUUID } from "crypto";
import { downloadTracker } from "../../../services/downloadJobs/downloadTracker.js";
import {
  dedupePlaylistTracks,
  flowPlaylistConfig,
} from "../../../services/playlists/flowPlaylistConfig.js";
import { playlistOperationQueue } from "../../../services/playlists/playlistOperationQueue.js";
import {
  enqueueResearchTrack,
  getAccessibleStaticPlaylist,
} from "./utils.js";
import { normalizeImportSource } from "../../../services/playlists/flowPlaylistConfig.js";
import { markDownloadWorkCancelledForJobs } from "../../../services/downloadJobs/downloadCancellationService.js";
import {
  isDownloadJobCancelled,
  restoreDownloadJobCancellations,
} from "../../../services/downloadJobs/downloadCancellation.js";

function cancelReleasedDownloads(playlist, jobIds) {
  const jobs = getReleasedUnfinishedJobs(playlist, jobIds).filter((job) => !isDownloadJobCancelled(job.id));
  markDownloadWorkCancelledForJobs(jobs);
  return jobs;
}

async function createOrImportStaticPlaylist(req, res, { requireTracks, label }) {
  const {
    name,
    sourceName = null,
    sourceFlowId = null,
    tracks,
  } = req.body || {};
  const safeName = String(name || "").trim();
  const normalizedTracks = Array.isArray(tracks) ? dedupePlaylistTracks(tracks) : [];
  const rawTracksProvided = Array.isArray(tracks);

  if (!safeName) {
    return res.status(400).json({ error: "name is required" });
  }
  if (requireTracks && normalizedTracks.length === 0) {
    return res.status(400).json({
      error: "tracks are required",
      message: "Import file must include at least one track",
    });
  }
  if (rawTracksProvided && tracks.length > 0 && normalizedTracks.length === 0) {
    return res.status(400).json({
      error: "tracks are invalid",
      message: "Add at least one valid track",
    });
  }

  const playlistId = randomUUID();
  const result = await playlistOperationQueue.enqueuePayload({
    kind: "static-playlist-create",
    label,
    playlistId,
    name: safeName,
    sourceName,
    sourceFlowId,
    tracks: normalizedTracks,
    ownerUserId: req.user.id,
  });

  return res.json({
    success: true,
    playlistId,
    queued: true,
    operationId: result.operationId,
  });
}

async function enqueueBulkAction(req, res, action) {
  const source = getAccessibleStaticPlaylist(req.user, req.params.playlistId);
  if (!source) return res.status(404).json({ error: "Playlist not found" });
  const { jobIds, target: requestedTarget } = req.body || {};
  if (!Array.isArray(jobIds) || !jobIds.length || jobIds.some((id) => typeof id !== "string" || !id.trim())) {
    return res.status(400).json({ error: "jobIds must contain at least one track ID" });
  }
  const ids = [...new Set(jobIds.map((id) => id.trim()))];
  let target = null;
  if (action === "move") {
    const playlistId = typeof requestedTarget?.playlistId === "string" ? requestedTarget.playlistId.trim() : "";
    const name = typeof requestedTarget?.name === "string" ? requestedTarget.name.trim() : "";
    if (Boolean(playlistId) === Boolean(name)) return res.status(400).json({ error: "Specify a destination playlist ID or name" });
    if (playlistId === source.id) return res.status(400).json({ error: "Choose a different destination playlist" });
    if (playlistId && !getAccessibleStaticPlaylist(req.user, playlistId)) return res.status(404).json({ error: "Destination playlist not found" });
    target = playlistId ? { playlistId } : { playlistId: randomUUID(), name, create: true };
  }
  const selections = [];
  const rejected = [];
  for (const jobId of ids) {
    const selection = captureStaticPlaylistSelection(source, jobId);
    if (selection) selections.push(selection);
    else rejected.push({ jobId, message: "Track not found in this playlist" });
  }
  if (!selections.length) return res.json({ queued: false, acceptedJobIds: [], rejected });
  const result = await playlistOperationQueue.enqueueBulkPayload({
    ownerUserId: req.user.id, sourcePlaylistId: source.id, action, target, selections,
  });
  return res.json({ ...result, acceptedJobIds: selections.map((selection) => selection.jobId), rejected });
}

export function registerStaticPlaylists(router) {
  for (const [path, action] of [["track-removals", "remove"], ["track-moves", "move"]]) {
    router.post(`/static-playlists/:playlistId/${path}`, async (req, res) => {
      try { return await enqueueBulkAction(req, res, action); }
      catch (error) { return res.status(500).json({ error: "Failed to queue playlist action", message: error.message }); }
    });
  }
  router.get("/static-playlists/:playlistId/operations/:operationId", (req, res) => {
    try {
      cleanupBulkOperations();
      const record = getBulkOperation(req.params.operationId);
      if (!record || record.ownerUserId !== req.user.id || record.sourcePlaylistId !== req.params.playlistId ||
          !getAccessibleStaticPlaylist(req.user, req.params.playlistId)) {
        return res.status(404).json({ error: "Playlist operation not found" });
      }
      return res.json({ operationId: record.operationId, state: record.state, action: record.action,
        outcomes: record.outcomes, targetPlaylistId: record.target?.playlistId || null,
        message: record.message || null });
    } catch (error) { return res.status(500).json({ error: "Failed to read playlist operation", message: error.message }); }
  });
  router.post("/static-playlists", async (req, res) => {
    try {
      return await createOrImportStaticPlaylist(req, res, {
        requireTracks: false,
        label: "static-playlist:create",
      });
    } catch (error) {
      if (error?.code === "STATIC_PLAYLIST_NAME_CONFLICT") {
        return res.status(400).json({
          error: "Playlist name already exists",
          message: error.message,
        });
      }
      res.status(500).json({
        error: "Failed to create playlist",
        message: error.message,
      });
    }
  });

  router.post("/static-playlists/import", async (req, res) => {
    try {
      return await createOrImportStaticPlaylist(req, res, {
        requireTracks: true,
        label: "static-playlist:import",
      });
    } catch (error) {
      if (error?.code === "STATIC_PLAYLIST_NAME_CONFLICT") {
        return res.status(400).json({
          error: "Playlist name already exists",
          message: error.message,
        });
      }
      res.status(500).json({
        error: "Failed to import playlist",
        message: error.message,
      });
    }
  });

  router.post("/static-playlists/:playlistId/tracks", async (req, res) => {
    try {
      const { playlistId } = req.params;
      const playlist = getAccessibleStaticPlaylist(req.user, playlistId);
      if (!playlist) {
        return res.status(404).json({ error: "Playlist not found" });
      }
      const rawTracks = req.body?.tracks;
      const normalizedTracks = Array.isArray(rawTracks) ? dedupePlaylistTracks(rawTracks) : [];
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

      const result = await playlistOperationQueue.enqueuePayload({
        kind: "static-playlist-append-tracks",
        label: `static-playlist:${playlistId}:tracks:add`,
        playlistId,
        tracks: normalizedTracks,
      });

      return res.json({
        success: true,
        playlistId,
        queued: true,
        operationId: result.operationId,
      });
    } catch (error) {
      res.status(500).json({
        error: "Failed to add playlist tracks",
        message: error.message,
      });
    }
  });

  router.put("/static-playlists/:playlistId/track-availability", (req, res) => {
    const { playlistId } = req.params;
    if (!getAccessibleStaticPlaylist(req.user, playlistId)) {
      return res.status(404).json({ error: "Playlist not found" });
    }
    if (typeof req.body?.enabled !== "boolean") {
      return res.status(400).json({ error: "enabled must be a boolean" });
    }
    const playlist = flowPlaylistConfig.updateStaticPlaylist(playlistId, {
      showTrackAvailability: req.body.enabled,
    });
    return res.json({ success: true, showTrackAvailability: playlist.showTrackAvailability });
  });

  router.put("/static-playlists/:playlistId/record-history", (req, res) => {
    const { playlistId } = req.params;
    if (!getAccessibleStaticPlaylist(req.user, playlistId)) {
      return res.status(404).json({ error: "Playlist not found" });
    }
    if (typeof req.body?.enabled !== "boolean") {
      return res.status(400).json({ error: "enabled must be a boolean" });
    }
    const playlist = flowPlaylistConfig.updateStaticPlaylist(playlistId, {
      recordHistory: req.body.enabled,
    });
    return res.json({ success: true, recordHistory: playlist.recordHistory });
  });

  router.put("/static-playlists/:playlistId", async (req, res) => {
    try {
      const { playlistId } = req.params;
      const { name, tracks } = req.body || {};
      const body = req.body || {};
      const hasNameUpdate = Object.hasOwn(body, "name");
      const hasTracksUpdate = Object.hasOwn(body, "tracks");
      const hasImportSourceUpdate = Object.hasOwn(body, "importSource");
      if (!hasNameUpdate && !hasTracksUpdate && !hasImportSourceUpdate) {
        return res.status(400).json({
          error: "At least one playlist field is required",
        });
      }
      const currentPlaylist = getAccessibleStaticPlaylist(req.user, playlistId);
      if (!currentPlaylist) {
        return res.status(404).json({ error: "Playlist not found" });
      }
      const safeName = hasNameUpdate
        ? String(name || "").trim()
        : String(currentPlaylist.name || "").trim();
      if (!safeName) {
        return res.status(400).json({ error: "name is required" });
      }
      const normalizedTracks = hasTracksUpdate
        ? Array.isArray(tracks) ? dedupePlaylistTracks(tracks) : []
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
      let importSource = null;
      if (hasImportSourceUpdate) {
        if (!currentPlaylist.importSource) {
          return res.status(400).json({
            error: "Playlist has no import source",
          });
        }
        importSource = normalizeImportSource({
          ...currentPlaylist.importSource,
          ...(req.body?.importSource || {}),
        });
        if (!importSource) {
          return res.status(400).json({
            error: "importSource is invalid",
          });
        }
      }

      const result = await playlistOperationQueue.enqueuePayload({
        kind: "static-playlist-update",
        label: `static-playlist:${playlistId}:update`,
        playlistId,
        name: safeName,
        tracks: normalizedTracks,
        hasNameUpdate,
        hasTracksUpdate,
        hasImportSourceUpdate,
        importSource,
      });
      return res.json({
        success: true,
        playlistId,
        queued: true,
        operationId: result.operationId,
      });
    } catch (error) {
      if (error?.code === "STATIC_PLAYLIST_NAME_CONFLICT") {
        return res.status(400).json({
          error: "Playlist name already exists",
          message: error.message,
        });
      }
      res.status(500).json({
        error: "Failed to update playlist",
        message: error.message,
      });
    }
  });

  router.delete(
    "/static-playlists/:playlistId/tracks/:jobId",
    async (req, res) => {
      try {
        const { playlistId, jobId } = req.params;
        const playlist = getAccessibleStaticPlaylist(req.user, playlistId);
        if (!playlist) {
          return res.status(404).json({ error: "Playlist not found" });
        }
        if (!downloadTracker.getJob(jobId) || !staticPlaylistReferencesJob(playlist, jobId)) {
          return res.status(404).json({ error: "Track not found" });
        }
        const cancelledJobs = cancelReleasedDownloads(playlist, [jobId]);
        let result;
        try {
          result = await playlistOperationQueue.enqueuePayload({
            kind: "static-playlist-delete-track",
            label: `static-playlist:${playlistId}:track:${jobId}:delete`,
            playlistId,
            jobId,
          });
        } catch (error) {
          restoreDownloadJobCancellations(cancelledJobs.map((job) => job.id));
          throw error;
        }

        return res.json({
          success: true,
          playlistId,
          removedJobId: jobId,
          queued: true,
          operationId: result.operationId,
        });
      } catch (error) {
        res.status(500).json({
          error: "Failed to remove playlist track",
          message: error.message,
        });
      }
    },
  );

  router.post(
    "/static-playlists/:playlistId/tracks/:jobId/research",
    async (req, res) => {
      try {
        const { playlistId, jobId } = req.params;
        return await enqueueResearchTrack(
          req,
          res,
          playlistId,
          jobId,
          "static-playlist",
        );
      } catch (error) {
        res.status(500).json({
          error: "Failed to re-search playlist track",
          message: error.message,
        });
      }
    },
  );

  router.delete("/static-playlists/:playlistId", async (req, res) => {
    try {
      const { playlistId } = req.params;
      const exists = getAccessibleStaticPlaylist(req.user, playlistId);
      if (!exists) {
        return res.status(404).json({ error: "Playlist not found" });
      }
      const cancelledJobs = cancelReleasedDownloads(exists, getStaticPlaylistJobIds(exists));

      let deleted;
      try {
        deleted = await playlistOperationQueue.enqueuePayload({
          kind: "static-playlist-delete",
          label: `static-playlist:${playlistId}:delete`,
          playlistId,
        });
      } catch (error) {
        restoreDownloadJobCancellations(cancelledJobs.map((job) => job.id));
        throw error;
      }
      return res.json({
        success: true,
        playlistId,
        queued: true,
        operationId: deleted.operationId,
      });
    } catch (error) {
      res.status(500).json({
        error: "Failed to delete playlist",
        message: error.message,
      });
    }
  });
}

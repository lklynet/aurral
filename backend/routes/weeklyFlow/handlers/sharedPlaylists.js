import { randomUUID } from "crypto";
import { downloadTracker } from "../../../services/weeklyFlow/weeklyFlowDownloadTracker.js";
import { weeklyFlowWorker } from "../../../services/weeklyFlow/weeklyFlowWorker.js";
import {
  dedupeSharedTracks,
} from "../../../services/weeklyFlow/weeklyFlowPlaylistConfig.js";
import { weeklyFlowOperationQueue } from "../../../services/weeklyFlow/weeklyFlowOperationQueue.js";
import {
  enqueueResearchTrack,
  getAccessibleSharedPlaylist,
} from "./utils.js";
import { normalizeImportSource } from "../../../services/weeklyFlow/weeklyFlowPlaylistConfig.js";

async function createOrImportSharedPlaylist(req, res, { requireTracks, label }) {
  const {
    name,
    sourceName = null,
    sourceFlowId = null,
    tracks,
  } = req.body || {};
  const safeName = String(name || "").trim();
  const normalizedTracks = Array.isArray(tracks) ? dedupeSharedTracks(tracks) : [];
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
  const result = await weeklyFlowOperationQueue.enqueuePayload({
    kind: "shared-playlist-create",
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

export function registerSharedPlaylists(router) {
  router.post("/shared-playlists", async (req, res) => {
    try {
      return await createOrImportSharedPlaylist(req, res, {
        requireTracks: false,
        label: "shared-playlist:create",
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
      return await createOrImportSharedPlaylist(req, res, {
        requireTracks: true,
        label: "shared-playlist:import",
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
      const normalizedTracks = Array.isArray(rawTracks) ? dedupeSharedTracks(rawTracks) : [];
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

  router.put("/shared-playlists/:playlistId", async (req, res) => {
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
        ? Array.isArray(tracks) ? dedupeSharedTracks(tracks) : []
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

      const result = await weeklyFlowOperationQueue.enqueuePayload({
        kind: "shared-playlist-update",
        label: `shared-playlist:${playlistId}:update`,
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
        const playlistReferencesJob = playlist.tracks?.some(
          (track) => String(track?.canonicalJobId || "") === String(jobId || ""),
        );
        if (!job || (job.playlistType !== playlistId && !playlistReferencesJob)) {
          return res.status(404).json({ error: "Track not found" });
        }
        const result = await weeklyFlowOperationQueue.enqueuePayload({
          kind: "shared-playlist-delete-track",
          label: `shared-playlist:${playlistId}:track:${jobId}:delete`,
          playlistId,
          jobId,
        });

        return res.json({
          success: true,
          playlistId,
          removedJobId: jobId,
          queued: true,
          operationId: result.operationId,
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
        return await enqueueResearchTrack(
          req,
          res,
          playlistId,
          jobId,
          "shared-playlist",
        );
      } catch (error) {
        res.status(500).json({
          error: "Failed to re-search shared playlist track",
          message: error.message,
        });
      }
    },
  );

  router.post(
    "/shared-playlists/:playlistId/research-missing",
    async (req, res) => {
      try {
        const { playlistId } = req.params;
        const playlist = getAccessibleSharedPlaylist(req.user, playlistId);
        if (!playlist) {
          return res.status(404).json({ error: "Shared playlist not found" });
        }
        const count = await weeklyFlowWorker.researchMissingTracks(playlistId);
        res.json({ success: true, playlistId, requeued: count });
      } catch (error) {
        res.status(500).json({
          error: "Failed to re-search missing tracks",
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
      return res.json({
        success: true,
        playlistId,
        queued: true,
        operationId: deleted.operationId,
      });
    } catch (error) {
      res.status(500).json({
        error: "Failed to delete shared playlist",
        message: error.message,
      });
    }
  });
}

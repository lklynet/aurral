import {
  enqueueImportedPlaylist,
  fetchImportedPlaylistTracks,
} from "../../../services/importLists/importPlaylist.ts";
import { listenbrainzPlaylistClient } from "../../../services/importLists/listenbrainzPlaylists.ts";
import { logger, safeLogDiagnostic } from "../../../services/logger.ts";
import { asAppError } from "../../../../lib/errors.ts";
import type { Router } from "express";

const getErrorStatus = (error: unknown) => {
  const failure = asAppError(error);
  return failure?.statusCode || failure?.response?.status || 500;
};

const getPlaylistImport = (
  body: { playlistType?: unknown; playlistId?: unknown } | null | undefined,
) => {
  const playlistType = String(body?.playlistType || "").trim();
  return playlistType
    ? { provider: "listenbrainz-createdfor", externalId: playlistType }
    : {
        provider: "listenbrainz-playlist",
        externalId: String(body?.playlistId || "").trim(),
      };
};

export function registerListenBrainzImport(router: Router) {
  router.get("/import/listenbrainz/playlists", async (req, res) => {
    try {
      res.json(await listenbrainzPlaylistClient.listPlaylists(req.user!.id));
    } catch (error) {
      logger.warn("playlist-import", "ListenBrainz playlist listing failed", {
        reason: safeLogDiagnostic(error),
      });
      res.status(getErrorStatus(error)).json({
        error: "Failed to fetch ListenBrainz playlists",
        message: asAppError(error)?.message || "Unknown error",
      });
    }
  });

  router.post("/import/listenbrainz/preview", async (req, res) => {
    try {
      const playlistImport = getPlaylistImport(req.body);
      if (!playlistImport.externalId) {
        return res.status(400).json({ error: "playlistId is required" });
      }
      const { tracks, stats } = await fetchImportedPlaylistTracks({
        userId: req.user!.id,
        ...playlistImport,
      });
      res.json({
        trackCount: tracks.length,
        skipped: stats.incomplete + stats.duplicate,
        previewTracks: tracks.slice(0, 3),
      });
    } catch (error) {
      logger.warn("playlist-import", "ListenBrainz playlist preview failed", {
        reason: safeLogDiagnostic(error),
      });
      res.status(getErrorStatus(error)).json({
        error: "Failed to preview ListenBrainz playlist",
        message: asAppError(error)?.message || "Unknown error",
      });
    }
  });

  router.post("/import/listenbrainz", async (req, res) => {
    let stage = "fetch";
    try {
      const playlistImport = getPlaylistImport(req.body);
      const name = String(req.body?.name || "").trim();
      const externalName = String(req.body?.externalName || "").trim();
      const syncIntervalHours = Number(req.body?.syncIntervalHours ?? 24);
      const keepRemovedTracks = req.body?.keepRemovedTracks !== false;
      const syncEnabled = req.body?.syncEnabled === false ? false : syncIntervalHours > 0;
      if (!playlistImport.externalId) {
        return res.status(400).json({ error: "playlistId is required" });
      }
      if (!name) return res.status(400).json({ error: "name is required" });
      const { tracks, stats, artworkUrl } = await fetchImportedPlaylistTracks({
        userId: req.user!.id,
        ...playlistImport,
      });
      stage = "enqueue";
      const result = await enqueueImportedPlaylist({
        ownerUserId: req.user!.id,
        name,
        sourceName: "ListenBrainz",
        ...playlistImport,
        externalName,
        tracks,
        sourceStats: stats,
        artworkUrl,
        syncEnabled,
        syncIntervalHours,
        keepRemovedTracks,
      });
      res.json({
        success: true,
        playlist: null,
        tracksQueued: Number(result?.tracksQueued || 0),
        tracksReused: 0,
        queued: result?.queued === true,
      });
    } catch (error) {
      const failure = asAppError(error);
      if (failure?.code === "STATIC_PLAYLIST_NAME_CONFLICT") {
        logger.debug("playlist-import", "ListenBrainz playlist import name already exists", {
          playlistName: String(req.body?.name || "").trim() || null,
        });
        return res.status(409).json({
          error: "Playlist name already exists",
          message: failure?.message,
        });
      }
      const status = getErrorStatus(error);
      logger[status >= 500 ? "error" : "warn"](
        "playlist-import",
        "ListenBrainz playlist import request failed",
        {
          playlistName: String(req.body?.name || "").trim() || null,
          stage,
          reason: safeLogDiagnostic(error),
        },
      );
      res.status(status).json({
        error: "Failed to import ListenBrainz playlist",
        message: failure?.message || "Unknown error",
      });
    }
  });
}

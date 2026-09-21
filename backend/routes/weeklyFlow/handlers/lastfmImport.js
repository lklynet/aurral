import {
  enqueueImportedPlaylist,
  fetchImportedPlaylistTracks,
} from "../../../services/importLists/importPlaylist.js";
import { lastfmStationClient } from "../../../services/importLists/lastfmStations.js";
import { logger, safeLogDiagnostic } from "../../../services/logger.js";

const getErrorStatus = (error) => error?.statusCode || error?.response?.status || 500;

const getPlaylistImport = (body) => ({
  provider: "lastfm-station",
  externalId: String(body?.playlistId || "").trim(),
  externalUsername: String(body?.username || "").trim(),
});

export function registerLastfmImport(router) {
  router.get("/import/lastfm/playlists", async (req, res) => {
    try {
      const requestedUsername = Array.isArray(req.query?.username)
        ? req.query.username[0]
        : req.query?.username;
      res.json(await lastfmStationClient.listPlaylists(req.user.id, requestedUsername));
    } catch (error) {
      logger.warn("playlist-import", "Last.fm station listing failed", {
        reason: safeLogDiagnostic(error),
      });
      res.status(getErrorStatus(error)).json({
        error: "Failed to fetch Last.fm stations",
        message: error?.message || "Unknown error",
      });
    }
  });

  router.post("/import/lastfm/preview", async (req, res) => {
    try {
      const playlistImport = getPlaylistImport(req.body);
      const { tracks, stats } = await fetchImportedPlaylistTracks({
        userId: req.user.id,
        ...playlistImport,
      });
      res.json({
        trackCount: tracks.length,
        skipped: stats.incomplete + stats.duplicate,
        previewTracks: tracks.slice(0, 3),
      });
    } catch (error) {
      logger.warn("playlist-import", "Last.fm station preview failed", {
        reason: safeLogDiagnostic(error),
      });
      res.status(getErrorStatus(error)).json({
        error: "Failed to preview Last.fm station",
        message: error?.message || "Unknown error",
      });
    }
  });

  router.post("/import/lastfm", async (req, res) => {
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
      const { tracks, stats, user } = await fetchImportedPlaylistTracks({
        userId: req.user.id,
        ...playlistImport,
      });
      stage = "enqueue";
      const result = await enqueueImportedPlaylist({
        ownerUserId: req.user.id,
        name,
        sourceName: "Last.fm",
        ...playlistImport,
        externalUsername: playlistImport.externalUsername || user || "",
        externalName,
        tracks,
        sourceStats: stats,
        syncEnabled,
        syncIntervalHours,
        keepRemovedTracks,
      });
      res.json({
        success: true,
        playlist: result?.playlist || null,
        tracksQueued: Number(result?.tracksQueued || 0),
        tracksReused: Number(result?.tracksReused || 0),
        queued: result?.queued === true,
      });
    } catch (error) {
      if (error?.code === "SHARED_PLAYLIST_NAME_CONFLICT") {
        logger.debug("playlist-import", "Last.fm station import name already exists", {
          playlistName: String(req.body?.name || "").trim() || null,
        });
        return res.status(409).json({
          error: "Playlist name already exists",
          message: error.message,
        });
      }
      const status = getErrorStatus(error);
      logger[status >= 500 ? "error" : "warn"]("playlist-import", "Last.fm station import request failed", {
        playlistName: String(req.body?.name || "").trim() || null,
        stage,
        reason: safeLogDiagnostic(error),
      });
      res.status(status).json({
        error: "Failed to import Last.fm station",
        message: error?.message || "Unknown error",
      });
    }
  });
}

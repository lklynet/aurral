import {
  extractYoutubePlaylistId,
  validateYoutubePlaylistId,
  youtubeMusicPlaylistClient,
} from "../../../services/importLists/youtubeMusicPlaylists.js";
import { enqueueImportedPlaylist } from "../../../services/importLists/importPlaylist.js";
import { logger, safeLogDiagnostic } from "../../../services/logger.js";

const getSkippedCount = (stats = {}) =>
  ["unavailable", "podcast", "incomplete", "duplicate"]
    .reduce((sum, key) => sum + Number(stats[key] || 0), 0);

const sendProviderError = (res, error, fallback) => {
  const statusCode = Number(error?.statusCode);
  const status = Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 599
    ? statusCode
    : 500;
  return res.status(status).json({
    error: fallback,
    message: error?.message || "Unknown error",
    ...(error?.code ? { code: error.code } : {}),
  });
};

export function registerYoutubeMusicImport(router) {
  router.post("/import/youtube-music/preview", async (req, res) => {
    try {
      const playlistId = extractYoutubePlaylistId(req.body?.url);
      const playlist = await youtubeMusicPlaylistClient.getPlaylist(playlistId);
      res.json({
        playlist: { id: playlist.id, name: playlist.name },
        trackCount: playlist.tracks.length,
        skipped: getSkippedCount(playlist.stats),
        previewTracks: playlist.tracks.slice(0, 3),
      });
    } catch (error) {
      const status = Number(error?.statusCode) || 500;
      logger[status >= 500 ? "error" : "warn"](
        "playlist-import",
        "YouTube Music playlist preview failed",
        { reason: safeLogDiagnostic(error) },
      );
      sendProviderError(res, error, "Failed to preview YouTube Music playlist");
    }
  });

  router.post("/import/youtube-music", async (req, res) => {
    let stage = "fetch";
    try {
      const playlistId = validateYoutubePlaylistId(req.body?.playlistId);
      const name = String(req.body?.name || "").trim();
      if (!name) return res.status(400).json({ error: "name is required" });
      const syncIntervalHours = Number(req.body?.syncIntervalHours ?? 24);
      const syncEnabled = req.body?.syncEnabled === false ? false : syncIntervalHours > 0;
      const keepRemovedTracks = req.body?.keepRemovedTracks !== false;
      const playlist = await youtubeMusicPlaylistClient.getPlaylist(playlistId);
      stage = "enqueue";
      const result = await enqueueImportedPlaylist({
        ownerUserId: req.user.id,
        name,
        sourceName: "YouTube Music",
        provider: "youtube-music-playlist",
        externalId: playlist.id,
        externalName: playlist.name,
        tracks: playlist.tracks,
        sourceStats: playlist.stats,
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
        logger.debug("playlist-import", "YouTube Music playlist import name already exists", {
          playlistName: String(req.body?.name || "").trim() || null,
        });
        return res.status(409).json({
          error: "Playlist name already exists",
          message: error.message,
        });
      }
      const status = Number(error?.statusCode) || 500;
      logger[status >= 500 ? "error" : "warn"](
        "playlist-import",
        "YouTube Music playlist import request failed",
        {
          playlistName: String(req.body?.name || "").trim() || null,
          stage,
          reason: safeLogDiagnostic(error),
        },
      );
      sendProviderError(res, error, "Failed to import YouTube Music playlist");
    }
  });
}

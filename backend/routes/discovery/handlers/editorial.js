import { requireAuth, requirePermission } from "../../../middleware/requirePermission.js";
import {
  addEditorialPlaylistToLibrary,
  getEditorialPlaylist,
  getEditorialShelf,
  resolveEditorialTrackLinks,
} from "../../../services/discovery/editorialPlaylists.js";
import { logger, safeLogDiagnostic } from "../../../services/logger.js";

const sendEditorialError = (res, error, fallback) => {
  const statusCode = Number(error?.statusCode);
  const status = Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 599
    ? statusCode
    : 500;
  logger[status >= 500 ? "warn" : "debug"]("discovery", fallback, {
    reason: safeLogDiagnostic(error),
  });
  return res.status(status).json({
    error: fallback,
    message: error?.message || "Unknown error",
    ...(error?.code ? { code: error.code } : {}),
  });
};

export function registerEditorial(router) {
  router.get("/editorial", requireAuth, async (req, res) => {
    try {
      res.json(await getEditorialShelf(req.user));
    } catch (error) {
      sendEditorialError(res, error, "Failed to load editorial playlists");
    }
  });

  router.get("/editorial/links", requireAuth, async (req, res) => {
    try {
      res.json(await resolveEditorialTrackLinks({
        artistName: req.query.artist,
        albumName: req.query.album,
        deezerAlbumId: req.query.albumId,
      }));
    } catch (error) {
      sendEditorialError(res, error, "Failed to find this artist or album");
    }
  });

  router.get("/editorial/:playlistId", requireAuth, async (req, res) => {
    try {
      res.set("Cache-Control", "no-store");
      res.json(await getEditorialPlaylist(req.user, req.params.playlistId));
    } catch (error) {
      sendEditorialError(res, error, "Failed to load editorial playlist");
    }
  });

  router.post(
    "/editorial/:playlistId/library",
    requireAuth,
    requirePermission("accessFlow"),
    async (req, res) => {
      try {
        res.json(await addEditorialPlaylistToLibrary(req.user, req.params.playlistId));
      } catch (error) {
        sendEditorialError(res, error, "Failed to add editorial playlist");
      }
    },
  );
}

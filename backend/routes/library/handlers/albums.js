import { libraryManager } from "../../../services/libraryManager.js";
import { playlistManager } from "../../../services/weeklyFlow/weeklyFlowPlaylistManager.js";
import { dbOps } from "../../../db/helpers/index.js";
import { hasPermission } from "../../../middleware/auth.js";
import { cacheMiddleware } from "../../../middleware/cache.js";
import {
  requireAuth,
  requirePermission,
} from "../../../middleware/requirePermission.js";
import { logger } from "../../../services/logger.js";
import {
  findCanonicalAlbumsForArtist,
  getCanonicalLibraryReadModel,
} from "../../../services/canonicalLibraryReadAdapter.js";

export function registerAlbums(router) {
  router.get("/albums", cacheMiddleware(5), async (req, res) => {
    try {
      const { artistId } = req.query;
      if (!artistId) {
        return res.status(400).json({ error: "artistId parameter is required" });
      }

      if (req.query.readPath === "canonical") {
        const { albums } = getCanonicalLibraryReadModel({ source: req.query.source || "lidarr" });
        return res.json(findCanonicalAlbumsForArtist(albums, artistId));
      }

      const albums = await libraryManager.getAlbums(artistId);
      const formatted = albums.map((album) => ({
        ...album,
        foreignAlbumId: album.foreignAlbumId || album.mbid,
        title: album.albumName,
        statistics: album.statistics || {
          trackCount: 0,
          sizeOnDisk: 0,
          percentOfTracks: 0,
        },
      }));
      res.json(formatted);
    } catch (error) {
      res.status(500).json({
        error: "Failed to fetch albums",
        message: error.message,
      });
    }
  });

  router.post(
    "/albums",
    requireAuth,
    requirePermission("addAlbum"),
    async (req, res) => {
      try {
        const { artistId, releaseGroupMbid, albumName } = req.body;

        if (!artistId || !releaseGroupMbid || !albumName) {
          return res.status(400).json({
            error: "artistId, releaseGroupMbid, and albumName are required",
          });
        }

        let mbid = releaseGroupMbid;
        if (String(releaseGroupMbid).startsWith("dz-")) {
          const { resolveDeezerAlbumToMbid } = await import(
            "../../../services/apiClients/index.js"
          );
          const artist = await libraryManager.getArtistById(artistId);
          const artistName = artist?.artistName || "";
          mbid =
            (await resolveDeezerAlbumToMbid(
              artistName,
              albumName,
              releaseGroupMbid
            )) || null;
          if (!mbid) {
            return res.status(400).json({
              error:
                "Could not resolve metadata for this album. Try adding the artist to Lidarr first or use a different album.",
            });
          }
        }

        const settings = dbOps.getSettings();
        const searchOnAdd = settings.integrations?.lidarr?.searchOnAdd ?? false;

        const album = await libraryManager.addAlbum(artistId, mbid, albumName, {
          triggerSearch: searchOnAdd,
        });
        if (album?.error) {
          logger.error("library", `Failed to add album ${albumName}:`, {
            message: album.error,
          });
          const statusCode =
            Number.isInteger(album.statusCode) && album.statusCode >= 400
              ? album.statusCode
              : 503;
          return res.status(statusCode).json({
            error: "Failed to add album",
            message: album.error,
          });
        }
        if (album.artistName && album.albumName) {
          playlistManager
            .removeDiscoverSymlinksForAlbum(album.artistName, album.albumName)
            .catch(() => {});
        }
        const { recordAlbumRequested } = await import(
          "../../../services/aurralHistoryService.js"
        );
        recordAlbumRequested({
          albumId: album.id,
          albumName: album.albumName || albumName,
          artistName: album.artistName,
          artistMbid: album.mbid || album.foreignAlbumId,
          searching: searchOnAdd,
          user: req.user,
        });
        return res.status(201).json({ ...album, queued: false });
      } catch (error) {
        res.status(500).json({
          error: "Failed to add album",
          message: error.message,
        });
      }
    }
  );

  router.post(
    "/albums/request",
    requireAuth,
    requirePermission("addAlbum"),
    async (req, res) => {
      try {
        const {
          albumMbid,
          albumName,
          artistMbid,
          artistName,
          triggerSearch = false,
        } = req.body || {};

        if (!albumMbid || !albumName || !artistMbid || !artistName) {
          return res.status(400).json({
            error: "albumMbid, albumName, artistMbid, and artistName are required",
          });
        }

        const result = await libraryManager.requestAlbumFromSearch({
          albumMbid,
          albumName,
          artistName,
          artistMbid,
          triggerSearch,
          user: req.user,
        });
        const settings = dbOps.getSettings();
        const searchOnAdd = settings.integrations?.lidarr?.searchOnAdd ?? false;
        const searching =
          triggerSearch === true ||
          searchOnAdd ||
          result?.status === "searching";
        const { recordAlbumRequested, recordAlbumSearchCompleted } = await import(
          "../../../services/aurralHistoryService.js"
        );
        const historyAlbum = {
          albumId: result?.album?.id || result?.id,
          albumName: result?.album?.albumName || result?.albumName || albumName,
          artistName: result?.artist?.artistName || result?.artistName || artistName,
          artistMbid: result?.artist?.mbid || result?.mbid || artistMbid,
          user: req.user,
        };
        recordAlbumRequested({
          ...historyAlbum,
          searching: result?.status === "available" ? false : searching,
        });
        if (result?.status === "available") {
          recordAlbumSearchCompleted(historyAlbum);
        }
        return res.status(201).json({ ...result, queued: false });
      } catch (error) {
        const statusCode =
          Number.isInteger(error?.statusCode) && error.statusCode >= 400
            ? error.statusCode
            : 500;
        res.status(statusCode).json({
          error: error.message || "Failed to request album",
        });
      }
    },
  );

  router.get("/albums/:id", cacheMiddleware(120), async (req, res) => {
    try {
      const { id } = req.params;
      const album = await libraryManager.getAlbumById(id);
      if (!album) {
        return res.status(404).json({ error: "Album not found" });
      }
      res.json(album);
    } catch (error) {
      res.status(500).json({
        error: "Failed to fetch album",
        message: error.message,
      });
    }
  });

  router.put(
    "/albums/:id",
    requireAuth,
    (req, res, next) => {
      if (
        hasPermission(req.user, "changeMonitoring") ||
        hasPermission(req.user, "addAlbum")
      ) {
        return next();
      }
      return res.status(403).json({
        error: "Forbidden",
        message: "Permission required: changeMonitoring or addAlbum",
      });
    },
    async (req, res) => {
      try {
        const { id } = req.params;
        const album = await libraryManager.updateAlbum(id, req.body);
        if (album?.error) {
          return res.status(503).json({ error: album.error });
        }
        res.json(album);
      } catch (error) {
        res.status(500).json({
          error: "Failed to update album",
          message: error.message,
        });
      }
    },
  );

  router.delete(
    "/albums/:id",
    requireAuth,
    requirePermission("deleteAlbum"),
    async (req, res) => {
      try {
        const { id } = req.params;
        const { deleteFiles = false } = req.query;
        const result = await libraryManager.deleteAlbum(
          id,
          deleteFiles === "true"
        );
        if (!result?.success) {
          return res
            .status(503)
            .json({ error: result?.error || "Failed to delete album" });
        }
        res.json({ success: true, message: "Album deleted successfully" });
      } catch (error) {
        res.status(500).json({
          error: "Failed to delete album",
          message: error.message,
        });
      }
    }
  );
}

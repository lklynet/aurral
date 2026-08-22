import { UUID_REGEX } from "../../../../lib/uuid.js";
import { libraryManager } from "../../../services/libraryManager.js";
import { cacheMiddleware } from "../../../middleware/cache.js";
import {
  requireAuth,
  requirePermission,
} from "../../../middleware/requirePermission.js";
import { logger } from "../../../services/logger.js";
import { getCanonicalLibraryReadModelForArtistPage } from "../../../services/canonicalLibraryReadAdapter.js";
export function registerArtists(router) {
  router.get("/artists", cacheMiddleware(120), async (req, res) => {
    try {
      if (req.query.readPath === "canonical") {
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10000, 1), 10000);
        const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
        const { artists } = getCanonicalLibraryReadModelForArtistPage({
          source: req.query.source || "all",
          limit,
          offset,
        });
        return res.json(artists.map((artist) => ({
          ...artist,
          added: artist.addedAt,
        })));
      }
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10000, 1), 10000);
      const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
      const artists = await libraryManager.getAllArtists();
      const paged = artists.slice(offset, offset + limit);
      const formatted = paged.map((artist) => ({
        ...artist,
        foreignArtistId: artist.foreignArtistId || artist.mbid,
        added: artist.addedAt,
      }));
      res.json(formatted);
    } catch (error) {
      res.status(500).json({
        error: "Failed to fetch artists",
        message: error.message,
      });
    }
  });

  router.get("/artists/:mbid", cacheMiddleware(120), async (req, res) => {
    try {
      const { mbid } = req.params;
      if (!UUID_REGEX.test(mbid)) {
        return res.status(400).json({ error: "Invalid MBID format" });
      }

      const artist = await libraryManager.getArtist(mbid);
      if (!artist) {
        return res.status(404).json({ error: "Artist not found" });
      }

      const formatted = {
        ...artist,
        foreignArtistId: artist.foreignArtistId || artist.mbid,
        added: artist.addedAt,
      };
      res.json(formatted);
    } catch (error) {
      res.status(500).json({
        error: "Failed to fetch artist",
        message: error.message,
      });
    }
  });

  router.post("/artists", requireAuth, requirePermission("addArtist"), async (req, res) => {
    try {
      const {
        foreignArtistId: mbid,
        artistName,
        quality,
        monitorOption,
        rootFolderPath,
        qualityProfileId,
        tagId,
        releaseGroupMbid,
      } = req.body;

      if (!mbid || !artistName) {
        return res.status(400).json({
          error: "foreignArtistId and artistName are required",
        });
      }

      if (!UUID_REGEX.test(mbid)) {
        return res.status(400).json({ error: "Invalid MBID format" });
      }

      const { lidarrClient } = await import("../../../services/lidarrClient.js");
      if (!lidarrClient || !lidarrClient.isConfigured()) {
        return res.status(503).json({ error: "Lidarr is not configured" });
      }

      const existingArtist = await libraryManager.getArtist(mbid);
      if (existingArtist?.id) {
        return res.status(200).json({
          queued: false,
          foreignArtistId: mbid,
          artistName,
          artist: {
            ...existingArtist,
            foreignArtistId: existingArtist.foreignArtistId || existingArtist.mbid,
            added: existingArtist.addedAt,
          },
        });
      }

      let preparedAddOptions = null;
      try {
        preparedAddOptions = await libraryManager.resolveArtistAddOptions({
          user: req.user,
          quality,
          monitorOption,
          rootFolderPath,
          qualityProfileId,
          tagId,
          albumOnly: Boolean(releaseGroupMbid),
          albumMbid: releaseGroupMbid || null,
        });
      } catch (error) {
        const statusCode =
          error?.statusCode === 400 || error?.statusCode === 409 ? error.statusCode : 500;
        return res.status(statusCode).json({
          error:
            statusCode === 409
              ? "Saved Lidarr default is no longer valid"
              : "Failed to validate Lidarr add options",
          message: error.message,
          field: error.field || null,
          code: error.code || null,
        });
      }

      const artist = await libraryManager.addArtistWithResolvedOptions(
        mbid,
        artistName,
        preparedAddOptions,
      );
      if (artist?.error) {
        logger.error("library", `Failed to add artist ${artistName}:`, {
          message: artist.error,
        });
        return res.status(503).json({
          error: "Failed to add artist",
          message: artist.error,
        });
      }

      return res.status(201).json({
        queued: false,
        foreignArtistId: mbid,
        artistName,
        artist: {
          ...artist,
          foreignArtistId: artist.foreignArtistId || artist.mbid || mbid,
          added: artist.addedAt,
        },
      });
    } catch (error) {
      res.status(500).json({
        error: "Failed to add artist",
        message: error.message,
      });
    }
  });

  router.put(
    "/artists/:mbid",
    requireAuth,
    requirePermission("changeMonitoring"),
    async (req, res) => {
      try {
        const { mbid } = req.params;
        if (!UUID_REGEX.test(mbid)) {
          return res.status(400).json({ error: "Invalid MBID format" });
        }

        const artist = await libraryManager.updateArtist(mbid, req.body);
        if (artist?.error) {
          return res.status(503).json({
            error: artist.error,
            message: artist.error,
          });
        }
        const { lidarrClient } = await import("../../../services/lidarrClient.js");
        if (lidarrClient && lidarrClient.isConfigured()) {
          if (artist.monitorOption && artist.monitorOption !== "none") {
            await libraryManager.applyArtistMonitoringDefaults(artist);
          }
        }
        res.json(artist);
      } catch (error) {
        res.status(500).json({
          error: "Failed to update artist",
          message: error.message,
        });
      }
    },
  );

  router.delete(
    "/artists/:mbid",
    requireAuth,
    requirePermission("deleteArtist"),
    async (req, res) => {
      try {
        const { mbid } = req.params;
        const { deleteFiles = false } = req.query;

        if (!UUID_REGEX.test(mbid)) {
          return res.status(400).json({ error: "Invalid MBID format" });
        }

        const result = await libraryManager.deleteArtist(mbid, deleteFiles === "true");
        if (!result?.success) {
          const message = result?.error || "Failed to delete artist";
          return res.status(503).json({ error: message, message });
        }
        res.json({ success: true, message: "Artist deleted successfully" });
      } catch (error) {
        res.status(500).json({
          error: "Failed to delete artist",
          message: error.message,
        });
      }
    },
  );

  router.post(
    "/artists/:mbid/refresh",
    requireAuth,
    requirePermission("changeMonitoring"),
    async (req, res) => {
      try {
        const { mbid } = req.params;
        if (!UUID_REGEX.test(mbid)) {
          return res.status(400).json({ error: "Invalid MBID format" });
        }

        const artist = await libraryManager.getArtist(mbid);
        if (!artist) {
          return res.status(404).json({ error: "Artist not found" });
        }

        const { lidarrClient } = await import("../../../services/lidarrClient.js");

        const albums = await libraryManager.getAlbums(artist.id);

        if (lidarrClient && lidarrClient.isConfigured()) {
          const lidarrArtist = await lidarrClient.getArtist(artist.id);
          if (lidarrArtist && lidarrArtist.monitor !== "none" && lidarrArtist.monitored) {
            await lidarrClient.triggerArtistSearch(artist.id);
          }
        }

        res.json({
          success: true,
          message: "Artist refreshed successfully",
          albums: albums.length,
        });
      } catch (error) {
        res.status(500).json({
          error: "Failed to refresh artist",
          message: error.message,
        });
      }
    },
  );
}

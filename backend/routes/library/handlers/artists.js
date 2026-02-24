import { UUID_REGEX } from "../../../config/constants.js";
import { libraryManager } from "../../../services/libraryManager.js";
import { musicbrainzGetArtistReleaseGroups } from "../../../services/apiClients.js";
import { dbOps } from "../../../config/db-helpers.js";
import { cacheMiddleware } from "../../../middleware/cache.js";
import {
  requireAuth,
  requirePermission,
} from "../../../middleware/requirePermission.js";

const monitorArtistAlbums = async (artist, albums, lidarrClient) => {
  if (
    !artist?.monitored ||
    !artist.monitorOption ||
    artist.monitorOption === "none"
  ) {
    return;
  }
  let eligibleAlbums = albums;
  if (lidarrClient && lidarrClient.isConfigured() && artist?.id) {
    try {
      const lidarrArtist = await lidarrClient.getArtist(artist.id);
      const settings = dbOps.getSettings();
      const fallbackMetadataProfileId =
        settings.integrations?.lidarr?.metadataProfileId;
      const metadataProfileId =
        lidarrArtist?.metadataProfileId ||
        lidarrArtist?.metadataProfile?.id ||
        fallbackMetadataProfileId;
      const profiles = metadataProfileId
        ? await lidarrClient.getMetadataProfiles()
        : null;
      const metadataProfile = Array.isArray(profiles)
        ? profiles.find(
            (profile) =>
              String(profile?.id) === String(metadataProfileId),
          )
        : null;
      const normalizeTypeName = (value) =>
        String(value || "")
          .toLowerCase()
          .replace(/[^a-z0-9]/g, "");
      const getTypeName = (item) => {
        if (!item) return "";
        if (typeof item === "string") return item;
        if (typeof item.name === "string") return item.name;
        if (typeof item.value === "string") return item.value;
        if (typeof item.albumType?.name === "string")
          return item.albumType.name;
        return "";
      };
      let allowedPrimaryTypes = null;
      if (metadataProfile?.primaryAlbumTypes) {
        const allowed = new Set();
        for (const item of metadataProfile.primaryAlbumTypes) {
          const name = getTypeName(item);
          if (!name) continue;
          const isAllowed =
            typeof item === "string" ? true : item.allowed !== false;
          if (!isAllowed) continue;
          allowed.add(normalizeTypeName(name));
        }
        if (allowed.size > 0) {
          allowedPrimaryTypes = allowed;
        }
      }
      if (allowedPrimaryTypes) {
        const mbid =
          artist.mbid || artist.foreignArtistId || artist.id?.toString?.();
        const releaseGroups = mbid
          ? await musicbrainzGetArtistReleaseGroups(mbid)
          : [];
        const mbidToType = new Map(
          releaseGroups.map((rg) => [
            rg.id,
            normalizeTypeName(rg["primary-type"]),
          ]),
        );
        eligibleAlbums = albums.filter((album) => {
          const key =
            album.mbid || album.foreignAlbumId || album.id?.toString?.();
          const type = mbidToType.get(key);
          if (!type) return true;
          return allowedPrimaryTypes.has(type);
        });
      }
    } catch {}
  }
  const albumsToMonitor = [];

  const sortedAlbums = [...eligibleAlbums].sort((a, b) => {
    const dateA = a.releaseDate || a.addedAt || "";
    const dateB = b.releaseDate || b.addedAt || "";
    return dateB.localeCompare(dateA);
  });

  switch (artist.monitorOption) {
    case "all":
    case "existing":
      albumsToMonitor.push(...eligibleAlbums.filter((a) => !a.monitored));
      break;
    case "latest":
      if (sortedAlbums.length > 0 && !sortedAlbums[0].monitored) {
        albumsToMonitor.push(sortedAlbums[0]);
      }
      break;
    case "first": {
      const oldestAlbum = sortedAlbums[sortedAlbums.length - 1];
      if (oldestAlbum && !oldestAlbum.monitored) {
        albumsToMonitor.push(oldestAlbum);
      }
      break;
    }
    case "missing":
      albumsToMonitor.push(
        ...eligibleAlbums.filter((a) => {
          const stats = a.statistics || {};
          return !a.monitored && (stats.percentOfTracks || 0) < 100;
        }),
      );
      break;
    case "future": {
      const artistAddedDate = new Date(artist.addedAt);
      albumsToMonitor.push(
        ...eligibleAlbums.filter((a) => {
          if (a.monitored) return false;
          if (!a.releaseDate) return false;
          const releaseDate = new Date(a.releaseDate);
          return releaseDate > artistAddedDate;
        }),
      );
      break;
    }
  }

  if (lidarrClient && lidarrClient.isConfigured()) {
    await Promise.allSettled(
      albumsToMonitor.map(async (album) => {
        try {
          await libraryManager.updateAlbum(album.id, { monitored: true });
          await lidarrClient.request("/command", "POST", {
            name: "AlbumSearch",
            albumIds: [parseInt(album.id, 10)],
          });
        } catch (err) {
          console.error(
            `Failed to monitor/search album ${album.albumName}:`,
            err.message,
          );
        }
      }),
    );
  }
};

export default function registerArtists(router) {
  router.get("/artists", cacheMiddleware(120), async (req, res) => {
    try {
      const artists = await libraryManager.getAllArtists();
      const formatted = artists.map((artist) => ({
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

  router.post(
    "/artists",
    requireAuth,
    requirePermission("addArtist"),
    async (req, res) => {
      try {
        const {
          foreignArtistId: mbid,
          artistName,
          quality,
          monitorOption,
        } = req.body;

        if (!mbid || !artistName) {
          return res.status(400).json({
            error: "foreignArtistId and artistName are required",
          });
        }

        if (!UUID_REGEX.test(mbid)) {
          return res.status(400).json({ error: "Invalid MBID format" });
        }

        const settings = dbOps.getSettings();
        const defaultMonitorOption =
          settings.integrations?.lidarr?.defaultMonitorOption || "none";
        const { lidarrClient } =
          await import("../../../services/lidarrClient.js");
        if (!lidarrClient || !lidarrClient.isConfigured()) {
          return res.status(503).json({ error: "Lidarr is not configured" });
        }

        res.status(202).json({
          queued: true,
          foreignArtistId: mbid,
          artistName,
        });

        (async () => {
          const artist = await libraryManager.addArtist(mbid, artistName, {
            quality: quality || settings.quality || "standard",
            monitorOption: monitorOption ?? defaultMonitorOption,
          });
          if (artist?.error) {
            console.error(
              `[Library] Failed to add artist ${artistName}:`,
              artist.error,
            );
            return;
          }
          if (artist.monitorOption && artist.monitorOption !== "none") {
            let albums = await libraryManager.getAlbums(artist.id);
            if (!albums.length) {
              await libraryManager.fetchArtistAlbums(artist.id, mbid);
              albums = await libraryManager.getAlbums(artist.id);
            }
            await monitorArtistAlbums(artist, albums, lidarrClient);
          }
        })();
      } catch (error) {
        res.status(500).json({
          error: "Failed to add artist",
          message: error.message,
        });
      }
    },
  );

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
        const { lidarrClient } =
          await import("../../../services/lidarrClient.js");
        if (lidarrClient && lidarrClient.isConfigured()) {
          let albums = await libraryManager.getAlbums(artist.id);
          if (artist.monitorOption && artist.monitorOption !== "none") {
            if (!albums.length) {
              await libraryManager.fetchArtistAlbums(artist.id, mbid);
              albums = await libraryManager.getAlbums(artist.id);
            }
            await monitorArtistAlbums(artist, albums, lidarrClient);
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

        const result = await libraryManager.deleteArtist(
          mbid,
          deleteFiles === "true",
        );
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

  router.post("/artists/:mbid/refresh", async (req, res) => {
    try {
      const { mbid } = req.params;
      if (!UUID_REGEX.test(mbid)) {
        return res.status(400).json({ error: "Invalid MBID format" });
      }

      const artist = await libraryManager.getArtist(mbid);
      if (!artist) {
        return res.status(404).json({ error: "Artist not found" });
      }

      const { lidarrClient } =
        await import("../../../services/lidarrClient.js");

      const albums = await libraryManager.getAlbums(artist.id);

      await Promise.allSettled(
        albums.map((album) =>
          libraryManager.updateAlbumStatistics(album.id).catch((err) => {
            console.error(
              `Failed to update statistics for album ${album.albumName}:`,
              err.message,
            );
          }),
        ),
      );

      await libraryManager.updateArtistStatistics(artist.id);

      if (lidarrClient && lidarrClient.isConfigured()) {
        const lidarrArtist = await lidarrClient.getArtist(artist.id);
        if (
          lidarrArtist &&
          lidarrArtist.monitor !== "none" &&
          lidarrArtist.monitored
        ) {
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
  });
}

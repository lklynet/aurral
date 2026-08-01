import { UUID_REGEX } from "../../../../lib/uuid.js";
import { dbOps } from "../../../db/helpers/index.js";
import { buildImageProxyUrl } from "../../../services/imageProxyService.js";
import { fetchReleaseGroupCoverUrl } from "../../../services/releaseGroupCoverService.js";
import { libraryManager, getCachedArtists } from "../../../services/libraryManager.js";
import { normalizePercentOfTracks } from "../../../services/lidarrAlbumStats.js";
import { logger } from "../../../services/logger.js";

export function registerMisc(router) {
  router.get("/rootfolder", async (req, res) => {
    try {
      const { lidarrClient } = await import("../../../services/lidarrClient.js");
      if (!lidarrClient.isConfigured()) {
        return res.json([]);
      }
      const rootFolders = await lidarrClient.getRootFolders();
      const list = Array.isArray(rootFolders) ? rootFolders.map((r) => ({ path: r.path })) : [];
      res.json(list);
    } catch (error) {
      res.status(500).json({
        error: "Failed to fetch root folder",
        message: error.message,
      });
    }
  });

  router.get("/lookup/:mbid", async (req, res) => {
    try {
      const { mbid } = req.params;
      if (!UUID_REGEX.test(mbid)) {
        return res.status(400).json({ error: "Invalid MBID format" });
      }

      const artist = await libraryManager.getArtist(mbid);
      if (artist) {
        res.json({
          exists: true,
          artist: {
            ...artist,
            foreignArtistId: artist.foreignArtistId || artist.mbid,
          },
        });
      } else {
        res.json({
          exists: false,
          artist: null,
        });
      }
    } catch (error) {
      res.status(500).json({
        error: "Failed to lookup artist",
        message: error.message,
      });
    }
  });

  router.post("/lookup/batch", async (req, res) => {
    try {
      const { mbids } = req.body;
      if (!Array.isArray(mbids)) {
        return res.status(400).json({ error: "mbids must be an array" });
      }

      const libraryArtists = getCachedArtists();
      const existingArtistIds = new Set(
        libraryArtists.map((artist) => artist.mbid).filter(Boolean),
      );
      const results = {};
      for (const mbid of mbids) {
        results[mbid] = existingArtistIds.has(mbid);
      }

      res.json(results);
    } catch (error) {
      res.status(500).json({
        error: "Failed to batch lookup artists",
        message: error.message,
      });
    }
  });

  router.post("/albums/lookup/batch", async (req, res) => {
    try {
      const { mbids } = req.body;
      if (!Array.isArray(mbids)) {
        return res.status(400).json({ error: "mbids must be an array" });
      }

      const { lidarrClient, LIDARR_ALBUM_LOOKUP_BATCH_MAX } =
        await import("../../../services/lidarrClient.js");
      const wanted = [...new Set(mbids.map((mbid) => String(mbid || "").trim()).filter(Boolean))];
      if (wanted.length > LIDARR_ALBUM_LOOKUP_BATCH_MAX) {
        return res.status(400).json({
          error: `mbids must contain at most ${LIDARR_ALBUM_LOOKUP_BATCH_MAX} unique values`,
        });
      }
      if (!lidarrClient.isConfigured()) {
        return res.json({});
      }
      const results = {};
      const albums = await lidarrClient.getAlbumsByMbidsSettled(wanted, { forceRefresh: true });

      for (let index = 0; index < wanted.length; index += 1) {
        const foreignAlbumId = wanted[index];
        const result = albums[index];
        if (result.status === "rejected") {
          logger.warn("library", "Lidarr album lookup failed", {
            foreignAlbumId,
            message: result.reason?.message || String(result.reason),
          });
          continue;
        }
        const album = result.value;
        if (!album) continue;

        const percentOfTracks = normalizePercentOfTracks(album?.statistics?.percentOfTracks);
        const sizeOnDisk = Number(album?.statistics?.sizeOnDisk || 0);
        const trackCount = Number(album?.statistics?.trackCount || 0);
        const trackFileCount = Number(album?.statistics?.trackFileCount || 0);
        const hasFiles = sizeOnDisk > 0 || trackFileCount > 0;
        const monitored = Boolean(album?.monitored);

        results[foreignAlbumId] = {
          inLibrary: true,
          libraryAlbumId: album.id !== undefined && album.id !== null ? String(album.id) : null,
          libraryArtistId:
            album.artistId !== undefined && album.artistId !== null ? String(album.artistId) : null,
          status: hasFiles ? "available" : monitored ? "monitored" : "unmonitored",
          monitored,
          percentOfTracks,
          sizeOnDisk,
          trackCount,
          trackFileCount,
          albumName: String(album?.title || "").trim(),
          releaseDate: String(album?.releaseDate || "").trim(),
        };
      }

      res.json(results);
    } catch (error) {
      res.status(500).json({
        error: "Failed to batch lookup albums",
        message: error.message,
      });
    }
  });

  router.get("/recent", async (req, res) => {
    try {
      const artists = await libraryManager.getAllArtists();
      const recent = [...artists]
        .sort((a, b) => new Date(b.addedAt || b.added) - new Date(a.addedAt || a.added))
        .slice(0, 20)
        .map((artist) => ({
          ...artist,
          foreignArtistId: artist.foreignArtistId || artist.mbid,
          added: artist.addedAt || artist.added,
        }));
      res.set("Cache-Control", "public, max-age=300");
      res.json(recent);
    } catch (error) {
      res.status(500).json({
        error: "Failed to fetch recent artists",
        message: error.message,
      });
    }
  });

  router.get("/recent-releases", async (req, res) => {
    try {
      const { getRecentMissingReleases } = await import(
        "../../../services/discovery/recentReleases.js"
      );      const recentMissing = await getRecentMissingReleases(24);

      const cachedCovers = dbOps.getImages(
        recentMissing
          .map((album) => album.mbid || album.foreignAlbumId)
          .filter(Boolean)
          .map((id) => `rg:${id}`),
      );

      const coverTargets = recentMissing.slice(0, 6);
      const warmedVisibleCovers = await Promise.all(
        coverTargets.map(async (album) => {
          const coverId = album.mbid || album.foreignAlbumId;
          if (!coverId) return [null, null];

          const cachedUrl = cachedCovers[`rg:${coverId}`]?.imageUrl || null;
          if (cachedUrl && cachedUrl !== "NOT_FOUND") {
            return [coverId, buildImageProxyUrl(cachedUrl) || cachedUrl];
          }

          const cover = await fetchReleaseGroupCoverUrl(coverId, {
            artistName: album.artistName || "",
            albumTitle: album.albumName || "",
          }).catch(() => null);

          if (!cover?.imageUrl) {
            return [coverId, null];
          }

          return [coverId, buildImageProxyUrl(cover.imageUrl) || cover.imageUrl];
        }),
      );

      const warmedCoverMap = Object.fromEntries(
        warmedVisibleCovers.filter(([coverId, coverUrl]) => coverId && coverUrl),
      );

      const withCachedCovers = recentMissing.map((album) => {
        const coverId = album.mbid || album.foreignAlbumId;
        const coverUrl =
          (coverId ? warmedCoverMap[coverId] : null) ||
          (coverId ? cachedCovers[`rg:${coverId}`]?.imageUrl || null : null);
        return {
          ...album,
          coverUrl:
            coverUrl && coverUrl !== "NOT_FOUND" ? buildImageProxyUrl(coverUrl) || coverUrl : null,
        };
      });

      res.set("Cache-Control", "public, max-age=300");
      res.json(withCachedCovers);
    } catch (error) {
      res.status(500).json({
        error: "Failed to fetch recent releases",
        message: error.message,
      });
    }
  });
}

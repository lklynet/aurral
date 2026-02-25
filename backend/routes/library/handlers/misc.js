import { UUID_REGEX } from "../../../config/constants.js";
import { libraryManager } from "../../../services/libraryManager.js";
import { qualityManager } from "../../../services/qualityManager.js";

export default function registerMisc(router) {
  router.post("/scan", async (req, res) => {
    res.status(400).json({ error: "Scanning is handled by Lidarr" });
  });

  router.get("/rootfolder", async (req, res) => {
    try {
      const { lidarrClient } =
        await import("../../../services/lidarrClient.js");
      if (!lidarrClient.isConfigured()) {
        return res.json([]);
      }
      const rootFolders = await lidarrClient.getRootFolders();
      const list = Array.isArray(rootFolders)
        ? rootFolders.map((r) => ({ path: r.path }))
        : [];
      res.json(list);
    } catch (error) {
      res.status(500).json({
        error: "Failed to fetch root folder",
        message: error.message,
      });
    }
  });

  router.get("/qualityprofile", async (req, res) => {
    try {
      const profiles = qualityManager.getQualityProfiles();
      res.json(profiles);
    } catch (error) {
      res.status(500).json({
        error: "Failed to fetch quality profiles",
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

      const libraryArtists = await libraryManager.getAllArtists();
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

  router.get("/recent", async (req, res) => {
    try {
      const artists = await libraryManager.getAllArtists();
      const recent = [...artists]
        .sort(
          (a, b) =>
            new Date(b.addedAt || b.added) - new Date(a.addedAt || a.added),
        )
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
      const [artists, albums] = await Promise.all([
        libraryManager.getAllArtists(),
        libraryManager.getAllAlbums(),
      ]);

      if (!Array.isArray(albums) || albums.length === 0) {
        return res.json([]);
      }

      const artistsById = new Map();
      if (Array.isArray(artists)) {
        artists.forEach((artist) => {
          if (artist?.id != null) {
            artistsById.set(artist.id, artist);
          }
        });
      }

      const now = Date.now();
      const recentCutoff = now - 90 * 24 * 60 * 60 * 1000;

      const recentMissing = albums
        .map((album) => {
          const artist = artistsById.get(album.artistId);
          if (!artist) return null;
          const mapped = libraryManager.mapLidarrAlbum(album, artist);
          const releaseDate = mapped.releaseDate || album.releaseDate || null;
          if (!releaseDate) return null;
          const releaseTime = new Date(releaseDate).getTime();
          if (!releaseTime || releaseTime < recentCutoff) return null;
          const percent = mapped.statistics?.percentOfTracks || 0;
          const size = mapped.statistics?.sizeOnDisk || 0;
          if (percent > 0 || size > 0) return null;
          return {
            ...mapped,
            artistName:
              mapped.artistName || artist.artistName || artist.name || null,
            artistMbid: artist.foreignArtistId || artist.mbid || null,
            foreignArtistId: artist.foreignArtistId || artist.mbid || null,
          };
        })
        .filter(Boolean)
        .sort((a, b) => {
          const dateA = a.releaseDate || "";
          const dateB = b.releaseDate || "";
          return dateB.localeCompare(dateA);
        })
        .slice(0, 24);

      res.set("Cache-Control", "public, max-age=300");
      res.json(recentMissing);
    } catch (error) {
      res.status(500).json({
        error: "Failed to fetch recent releases",
        message: error.message,
      });
    }
  });
}

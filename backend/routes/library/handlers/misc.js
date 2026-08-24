import { UUID_REGEX } from "../../../../lib/uuid.js";
import { dbOps } from "../../../db/helpers/index.js";
import { buildImageProxyUrl } from "../../../services/imageProxyService.js";
import { fetchReleaseGroupCoverUrl } from "../../../services/releaseGroupCoverService.js";
import { libraryManager } from "../../../services/libraryManager.js";
import { normalizePercentOfTracks } from "../../../services/lidarrAlbumStats.js";
import { logger } from "../../../services/logger.js";
import {
  getCanonicalLibraryReadModelForAlbumReferences,
  getCanonicalLibraryReadModelForArtists,
} from "../../../services/canonicalLibraryReadAdapter.js";
import { getCanonicalArtistMbids } from "../../../services/libraryQueryService.js";

const ARTIST_LOOKUP_BATCH_MAX = 100;

const canonicalAlbumLookup = (albums, reference) =>
  albums.find((album) =>
    [album.mbid, album.releaseGroupMbid, album.identityKey].some(
      (value) => String(value || "").trim() === String(reference || "").trim(),
    ),
  );

const canonicalAlbumResult = (album, ownedTrackMbids = []) => ({
  inLibrary: true,
  canonicalInLibrary: true,
  canonicalAlbumId: String(album.canonicalId ?? album.id),
  canonicalArtistId: String(album.artistId),
  libraryAlbumId: String(album.providerId ?? album.id),
  libraryArtistId: String(album.providerArtistId ?? album.artistId),
  status:
    Number(album.statistics?.trackCount || 0) > Number(album.statistics?.trackFileCount || 0)
      ? "partial"
      : album.available
        ? "available"
        : "partial",
  monitored: album.monitored,
  percentOfTracks: Number(album.statistics?.percentOfTracks || 0),
  sizeOnDisk: Number(album.statistics?.sizeOnDisk || 0),
  trackCount: Number(album.statistics?.trackCount || 0),
  trackFileCount: Number(album.statistics?.trackFileCount || 0),
  ownedTrackMbids,
  albumName: String(album.albumName || album.title || "").trim(),
  releaseDate: String(album.releaseDate || "").trim(),
});

const ownedLidarrTrackMbids = (tracks) =>
  (Array.isArray(tracks) ? tracks : [])
    .filter((track) => track?.hasFile === true || track?.path || track?.trackFile?.path)
    .map((track) => track?.mbid || track?.foreignRecordingId || track?.foreignTrackId)
    .map((mbid) => String(mbid || "").trim())
    .filter(Boolean);

const toLibraryArtist = (artist) => ({
  ...artist,
  id: artist.providerId ?? artist.id,
  canonicalId: String(artist.canonicalId ?? artist.id),
  foreignArtistId: artist.foreignArtistId || artist.mbid,
  added: artist.addedAt,
});

const toLibraryAlbum = (album) => ({
  ...album,
  id: album.providerId ?? album.id,
  artistId: album.providerArtistId ?? album.artistId,
  canonicalId: String(album.canonicalId ?? album.id),
  foreignAlbumId: album.foreignAlbumId || album.mbid,
  title: album.albumName,
  albumType: "Album",
});

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

      const { artists, albums } = getCanonicalLibraryReadModelForArtists({
        source: "all",
        availableOnly: false,
        mbids: [mbid],
      });
      const artist = artists.find((candidate) => candidate.mbid === mbid);
      const { lidarrClient } = await import("../../../services/lidarrClient.js");
      let lidarrArtist;
      let lidarrAlbums;
      if (lidarrClient.isConfigured()) {
        try {
          lidarrArtist = await lidarrClient.getArtistByMbid(mbid, { forceRefresh: true });
          if (lidarrArtist) {
            const albums = await lidarrClient.request(
              `/album?artistId=${encodeURIComponent(lidarrArtist.id)}`,
              "GET",
              null,
              false,
              { forceRefresh: true },
            );
            if (!Array.isArray(albums)) throw new Error("Invalid Lidarr album response");
            lidarrAlbums = albums.map((album) =>
              toLibraryAlbum(libraryManager.mapLidarrAlbum(album, lidarrArtist)),
            );
          }
        } catch {
          lidarrArtist = undefined;
          lidarrAlbums = undefined;
        }
      }
      if (lidarrArtist && lidarrAlbums) {
        res.json({
          exists: true,
          artist: toLibraryArtist(libraryManager.mapLidarrArtist(lidarrArtist)),
          albums: lidarrAlbums,
          canonical: true,
        });
      } else if (lidarrArtist === undefined && artist) {
        res.json({
          exists: true,
          artist: toLibraryArtist(artist),
          albums: albums.filter((album) => album.artistMbid === mbid).map(toLibraryAlbum),
          canonical: true,
        });
      } else {
        res.json({
          exists: false,
          artist: null,
          albums: [],
          canonical: true,
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

      const wanted = [...new Set(mbids.map((mbid) => String(mbid || "").trim()).filter(Boolean))];
      if (wanted.length > ARTIST_LOOKUP_BATCH_MAX) {
        return res.status(400).json({
          error: `mbids must contain at most ${ARTIST_LOOKUP_BATCH_MAX} unique values`,
        });
      }

      const existingArtistIds = getCanonicalArtistMbids({
        source: "all",
        availableOnly: false,
        mbids: wanted,
      });
      const results = {};
      for (const mbid of wanted) {
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

      const wanted = [...new Set(mbids.map((mbid) => String(mbid || "").trim()).filter(Boolean))];
      if (wanted.length === 0) return res.json({});
      const { lidarrClient, LIDARR_ALBUM_LOOKUP_BATCH_MAX } =
        await import("../../../services/lidarrClient.js");
      if (wanted.length > LIDARR_ALBUM_LOOKUP_BATCH_MAX) {
        return res.status(400).json({
          error: `mbids must contain at most ${LIDARR_ALBUM_LOOKUP_BATCH_MAX} unique values`,
        });
      }

      const { albums: canonicalAlbums, tracks: canonicalTracks } =
        getCanonicalLibraryReadModelForAlbumReferences({
          source: "all",
          availableOnly: false,
          references: wanted,
        });
      const tracksByAlbumId = new Map();
      for (const track of canonicalTracks) {
        const albumTracks = tracksByAlbumId.get(String(track.albumId)) || [];
        albumTracks.push(track);
        tracksByAlbumId.set(String(track.albumId), albumTracks);
      }
      const results = {};
      for (const foreignAlbumId of wanted) {
        const album = canonicalAlbumLookup(canonicalAlbums, foreignAlbumId);
        if (album) {
          const albumTracks = tracksByAlbumId.get(String(album.id)) || [];
          const trackCount = albumTracks.length;
          const trackFileCount = albumTracks.filter((track) => track.available).length;
          results[foreignAlbumId] = canonicalAlbumResult(
            {
              ...album,
              available: trackFileCount > 0,
              statistics: {
                ...album.statistics,
                trackCount,
                trackFileCount,
                percentOfTracks: trackCount > 0 ? (trackFileCount / trackCount) * 100 : 0,
              },
            },
            albumTracks
              .filter((track) => track.available && track.mbid)
              .map((track) => String(track.mbid).trim())
              .filter(Boolean),
          );
        }
      }

      if (!lidarrClient.isConfigured()) {
        return res.json(results);
      }
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
        if (!album) {
          delete results[foreignAlbumId];
          continue;
        }
        if (results[foreignAlbumId]) continue;

        const albumTracks = album.id ? await libraryManager.getTracks(album.id) : [];

        const percentOfTracks = normalizePercentOfTracks(album?.statistics?.percentOfTracks);
        const sizeOnDisk = Number(album?.statistics?.sizeOnDisk || 0);
        const trackCount = Number(album?.statistics?.trackCount || 0);
        const trackFileCount = Number(album?.statistics?.trackFileCount || 0);
        const hasFiles = sizeOnDisk > 0 || trackFileCount > 0;
        const monitored = Boolean(album?.monitored);

        results[foreignAlbumId] = {
          inLibrary: true,
          canonicalInLibrary: false,
          libraryAlbumId: album.id !== undefined && album.id !== null ? String(album.id) : null,
          libraryArtistId:
            album.artistId !== undefined && album.artistId !== null ? String(album.artistId) : null,
          status: hasFiles ? "available" : monitored ? "monitored" : "unmonitored",
          monitored,
          percentOfTracks,
          sizeOnDisk,
          trackCount,
          trackFileCount,
          ownedTrackMbids: ownedLidarrTrackMbids(albumTracks),
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

import { UUID_REGEX } from "../../../config/constants.js";
import { dbOps } from "../../../config/db-helpers.js";
import { cacheMiddleware } from "../../../middleware/cache.js";
import {
  fetchReleaseGroupCoverUrl,
  resolveReleaseGroupCoversBatch,
} from "../../../services/releaseGroupCoverService.js";
import { enrichTracksWithDeezerPreviews } from "../../../services/apiClients.js";
import {
  getArtistByMbid,
  getAlbumByMbid,
  getAlbumTracksByAlbumMbid,
} from "../../../services/metadataProvider.js";
import { toLegacyReleaseGroupSummary } from "../../../services/providers/brainzmashMappers.js";

function extractDeezerArtistIdFromLinks(links = []) {
  if (!Array.isArray(links)) return null;
  for (const link of links) {
    const type = String(link?.type || "").toLowerCase();
    const target = String(link?.target || link?.url?.resource || "").trim();
    if (type !== "deezer" && !/deezer\.com\/artist\//i.test(target)) continue;
    const match = target.match(/deezer\.com\/artist\/(\d+)/i);
    if (match?.[1]) return match[1];
  }
  return null;
}

export default function registerReleaseGroup(router) {
  router.post("/release-groups/covers", async (req, res) => {
    try {
      const items = Array.isArray(req.body?.items) ? req.body.items : [];
      if (!items.length) {
        return res.json({ covers: {} });
      }
      const covers = await resolveReleaseGroupCoversBatch(items);
      const hasTransientError = Object.values(covers).some(
        (entry) => entry?.transientError,
      );
      if (hasTransientError) {
        res.set("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
      } else {
        res.set("Cache-Control", "public, max-age=31536000, immutable");
      }
      return res.json({ covers });
    } catch (error) {
      console.error("Error in release-groups covers batch route:", error.message);
      res.set("Cache-Control", "public, max-age=60");
      return res.json({ covers: {} });
    }
  });

  router.get("/release-group/:mbid", cacheMiddleware(3600), async (req, res) => {
    try {
      const { mbid } = req.params;
      if (!UUID_REGEX.test(mbid)) {
        return res.status(400).json({ error: "Invalid MBID format" });
      }

      const album = await getAlbumByMbid(mbid);
      const primaryArtist = Array.isArray(album?.artists) ? album.artists[0] : null;
      const summary = toLegacyReleaseGroupSummary(album, primaryArtist);
      const coverImage =
        Array.isArray(album?.images) && album.images[0]?.url
          ? album.images[0].url
          : null;

      res.json({
        ...summary,
        genres: Array.isArray(album?.genres) ? album.genres : [],
        overview: album?.overview || "",
        coverUrl: coverImage,
      });
    } catch (error) {
      console.error(
        `Error in release-group details route for ${req.params.mbid}:`,
        error.message,
      );
      res.status(404).json({
        error: "Release not found",
        message: error.message,
      });
    }
  });

  router.get("/release-group/:mbid/cover", async (req, res) => {
    try {
      const { mbid } = req.params;
      const artistName =
        typeof req.query.artistName === "string" && req.query.artistName.trim()
          ? req.query.artistName.trim()
          : "";
      const albumTitleFromQuery =
        typeof req.query.albumTitle === "string" && req.query.albumTitle.trim()
          ? req.query.albumTitle.trim()
          : "";

      if (!UUID_REGEX.test(mbid)) {
        return res.status(400).json({ error: "Invalid MBID format", images: [] });
      }
      const cover = await fetchReleaseGroupCoverUrl(mbid, {
        artistName,
        albumTitle: albumTitleFromQuery,
      });
      if (cover?.imageUrl) {
        res.set("Cache-Control", "public, max-age=31536000, immutable");
        return res.json({
          images: [
            {
              image: cover.imageUrl,
              front: true,
              types: cover.types || ["Front"],
            },
          ],
          notFound: false,
          transientError: false,
        });
      }
      if (cover?.notFound) {
        res.set("Cache-Control", "public, max-age=3600");
        return res.json({ images: [], notFound: true, transientError: false });
      }
      res.set("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
      res.json({ images: [], notFound: false, transientError: true });
    } catch (error) {
      console.error(
        `Error in release-group cover route for ${req.params.mbid}:`,
        error.message
      );
      res.set("Cache-Control", "public, max-age=60");
      res.json({ images: [], notFound: false, transientError: true });
    }
  });

  router.get("/release-group/:mbid/tracks", cacheMiddleware(86400), async (req, res) => {
    try {
      const { mbid } = req.params;
      if (!UUID_REGEX.test(mbid)) {
        return res.status(400).json({ error: "Invalid MBID format" });
      }

      const artistMbid =
        typeof req.query.artistMbid === "string" &&
        UUID_REGEX.test(req.query.artistMbid)
          ? req.query.artistMbid
          : "";
      const artistName =
        typeof req.query.artistName === "string"
          ? req.query.artistName.trim()
          : "";
      const albumTitle =
        typeof req.query.albumTitle === "string"
          ? req.query.albumTitle.trim()
          : "";
      const releaseType =
        typeof req.query.releaseType === "string"
          ? req.query.releaseType.trim()
          : "";
      const releaseDate =
        typeof req.query.releaseDate === "string"
          ? req.query.releaseDate.trim()
          : "";
      const deezerAlbumId =
        typeof req.query.deezerAlbumId === "string"
          ? req.query.deezerAlbumId.trim()
          : "";

      const tracks = await getAlbumTracksByAlbumMbid(mbid);
      let deezerArtistId = "";
      if (artistMbid) {
        const override = dbOps.getArtistOverride(artistMbid);
        deezerArtistId = override?.deezerArtistId || "";
        if (!deezerArtistId) {
          const resolvedArtistMbid = override?.musicbrainzId || artistMbid;
          const metadataArtist = await getArtistByMbid(resolvedArtistMbid).catch(
            () => null,
          );
          deezerArtistId =
            extractDeezerArtistIdFromLinks(metadataArtist?.links) || "";
        }
      }
      const enrichedTracks = await enrichTracksWithDeezerPreviews(tracks, {
        artistName,
        deezerArtistId,
        deezerAlbumId,
        albumTitle,
        releaseType,
        releaseDate,
        cacheKey: `release-group:${mbid}:${
          deezerAlbumId || deezerArtistId || artistName
        }`,
      });

      res.json(
        enrichedTracks.map((track) => ({
          id: track.recordingId || track.id,
          mbid: track.recordingId || track.id,
          title: track.title,
          trackName: track.title,
          trackNumber: track.trackPosition || track.trackNumber || 0,
          position: track.trackPosition || track.trackNumber || 0,
          length: track.durationMs || null,
          preview_url: track.preview_url || null,
          previewProvider: track.previewProvider || null,
          previewTrackId: track.previewTrackId || null,
        })),
      );
    } catch (error) {
      console.error("Error fetching release group tracks:", error);
      res.status(500).json({
        error: "Failed to fetch tracks",
        message: error.message,
      });
    }
  });
}

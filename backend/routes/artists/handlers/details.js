import { UUID_REGEX } from "../../../config/constants.js";
import {
  getLastfmApiKey,
  lastfmRequest,
  lastfmGetArtistNameByMbid,
  getArtistBio,
  musicbrainzGetArtistReleaseGroups,
  enrichReleaseGroupsWithDeezer,
  enrichReleaseGroupsWithLastfm,
  musicbrainzGetArtistNameByMbid,
} from "../../../services/apiClients.js";
import { dbOps } from "../../../config/db-helpers.js";
import { cacheMiddleware } from "../../../middleware/cache.js";
import { requireAuth } from "../../../middleware/requirePermission.js";
import { pendingArtistRequests } from "../utils.js";

export default function registerDetails(router) {
  router.get("/", async (req, res) => {
    res.status(404).json({
      error: "Not found",
      message:
        "Use /api/artists/:mbid to get artist details, or /api/search/artists to search",
    });
  });

  router.get("/:mbid/overrides", requireAuth, async (req, res) => {
    const { mbid } = req.params;
    if (!UUID_REGEX.test(mbid)) {
      return res.status(400).json({
        error: "Invalid MBID format",
        message: `"${mbid}" is not a valid MusicBrainz ID. MBIDs must be UUIDs.`,
      });
    }
    const override = dbOps.getArtistOverride(mbid);
    return res.json({
      mbid,
      musicbrainzId: override?.musicbrainzId || null,
      deezerArtistId: override?.deezerArtistId || null,
    });
  });

  router.put("/:mbid/overrides", requireAuth, async (req, res) => {
    const { mbid } = req.params;
    if (!UUID_REGEX.test(mbid)) {
      return res.status(400).json({
        error: "Invalid MBID format",
        message: `"${mbid}" is not a valid MusicBrainz ID. MBIDs must be UUIDs.`,
      });
    }

    const rawMusicbrainzId =
      req.body?.musicbrainzId != null
        ? String(req.body.musicbrainzId).trim()
        : "";
    const rawDeezerArtistId =
      req.body?.deezerArtistId != null
        ? String(req.body.deezerArtistId).trim()
        : "";

    const musicbrainzId = rawMusicbrainzId || null;
    const deezerArtistId = rawDeezerArtistId || null;

    if (musicbrainzId && !UUID_REGEX.test(musicbrainzId)) {
      return res.status(400).json({
        error: "Invalid MusicBrainz ID format",
        message: `"${musicbrainzId}" is not a valid MusicBrainz ID. MBIDs must be UUIDs.`,
      });
    }

    if (deezerArtistId && !/^\d+$/.test(deezerArtistId)) {
      return res.status(400).json({
        error: "Invalid Deezer Artist ID",
        message: `"${deezerArtistId}" must be a numeric Deezer artist ID.`,
      });
    }

    if (!musicbrainzId && !deezerArtistId) {
      dbOps.deleteArtistOverride(mbid);
      dbOps.deleteImage(mbid);
      return res.json({
        mbid,
        musicbrainzId: null,
        deezerArtistId: null,
      });
    }

    const saved = dbOps.setArtistOverride(mbid, {
      musicbrainzId,
      deezerArtistId,
    });
    dbOps.deleteImage(mbid);
    return res.json(saved);
  });

  router.get("/:mbid", cacheMiddleware(300), async (req, res) => {
    try {
      const { mbid } = req.params;

      if (!UUID_REGEX.test(mbid)) {
        console.log(`[Artists Route] Invalid MBID format: ${mbid}`);
        return res.status(400).json({
          error: "Invalid MBID format",
          message: `"${mbid}" is not a valid MusicBrainz ID. MBIDs must be UUIDs.`,
        });
      }

      if (pendingArtistRequests.has(mbid)) {
        console.log(
          `[Artists Route] Request for ${mbid} already in progress, waiting...`,
        );
        try {
          const data = await pendingArtistRequests.get(mbid);
          res.setHeader("Content-Type", "application/json");
          return res.json(data);
        } catch (error) {
          return res.status(error.response?.status || 500).json({
            error: "Failed to fetch artist details",
            message: error.response?.data?.error || error.message,
          });
        }
      }

      console.log(`[Artists Route] Fetching artist details for MBID: ${mbid}`);

      const { libraryManager } =
        await import("../../../services/libraryManager.js");

      let data = null;
      const override = dbOps.getArtistOverride(mbid);
      const resolvedMbid = override?.musicbrainzId || mbid;
      const deezerArtistId = override?.deezerArtistId || null;

      let lidarrArtist = null;
      let lidarrAlbums = [];

      try {
        lidarrArtist = await libraryManager.getArtist(mbid);
        if (lidarrArtist) {
          console.log(
            `[Artists Route] Found artist in Lidarr: ${lidarrArtist.artistName}`,
          );
          lidarrAlbums = await libraryManager.getAlbums(lidarrArtist.id);
        }
      } catch (error) {
        console.warn(
          `[Artists Route] Failed to fetch from Lidarr: ${error.message}`,
        );
      }

      if (lidarrArtist) {
        const artistMbid =
          override?.musicbrainzId || lidarrArtist.foreignArtistId || mbid;
        const [bio, tagsData] = await Promise.all([
          getArtistBio(lidarrArtist.artistName, artistMbid, deezerArtistId),
          getLastfmApiKey()
            ? lastfmRequest("artist.getTopTags", { mbid: artistMbid })
            : null,
        ]);
        const tags = tagsData?.toptags?.tag
          ? (Array.isArray(tagsData.toptags.tag)
              ? tagsData.toptags.tag
              : [tagsData.toptags.tag]
            ).map((t) => ({ name: t.name, count: t.count || 0 }))
          : [];
        const payload = {
          id: artistMbid,
          name: lidarrArtist.artistName,
          "sort-name": lidarrArtist.artistName,
          disambiguation: "",
          "type-id": null,
          type: null,
          country: null,
          "life-span": {
            begin: null,
            end: null,
            ended: false,
          },
          tags,
          genres: [],
          "release-groups": lidarrAlbums.map((album) => ({
            id: album.mbid,
            title: album.albumName,
            "first-release-date": album.releaseDate || null,
            "primary-type": "Album",
            "secondary-types": [],
          })),
          relations: [],
          "release-group-count": lidarrAlbums.length,
          "release-count": lidarrAlbums.length,
          _lidarrData: {
            id: lidarrArtist.id,
            monitored: lidarrArtist.monitored,
            statistics: lidarrArtist.statistics,
          },
          ...(bio ? { bio } : {}),
        };

        res.setHeader("Content-Type", "application/json");
        res.json(payload);
        return;
      }

      const fetchPromise = (async () => {
        const name =
          (req.query.artistName || "").trim() ||
          (getLastfmApiKey()
            ? await lastfmGetArtistNameByMbid(resolvedMbid)
            : null) ||
          (await musicbrainzGetArtistNameByMbid(resolvedMbid)) ||
          "Unknown Artist";
        const tagsData = getLastfmApiKey()
          ? await lastfmRequest("artist.getTopTags", { mbid: resolvedMbid })
          : null;
        const tags = tagsData?.toptags?.tag
          ? (Array.isArray(tagsData.toptags.tag)
              ? tagsData.toptags.tag
              : [tagsData.toptags.tag]
            ).map((t) => ({ name: t.name, count: t.count || 0 }))
          : [];
        const releaseGroups =
          await musicbrainzGetArtistReleaseGroups(resolvedMbid);
        await enrichReleaseGroupsWithDeezer(
          releaseGroups,
          name,
          deezerArtistId,
        );
        if (getLastfmApiKey()) {
          await enrichReleaseGroupsWithLastfm(
            releaseGroups,
            name,
            resolvedMbid,
          );
        }
        const bio = await getArtistBio(name, resolvedMbid, deezerArtistId);
        return {
          id: resolvedMbid,
          name,
          "sort-name": name,
          disambiguation: "",
          "type-id": null,
          type: null,
          country: null,
          "life-span": { begin: null, end: null, ended: false },
          tags,
          genres: [],
          "release-groups": releaseGroups,
          relations: [],
          "release-group-count": releaseGroups.length,
          "release-count": releaseGroups.length,
          bio: bio || undefined,
        };
      })();

      pendingArtistRequests.set(mbid, fetchPromise);

      try {
        data = await fetchPromise;
        res.setHeader("Content-Type", "application/json");
        res.json(data);
      } catch (error) {
        const artistNameParam = (req.query.artistName || "").trim();
        const fallback = {
          id: resolvedMbid,
          name: artistNameParam || "Unknown Artist",
          "sort-name": artistNameParam || "Unknown Artist",
          disambiguation: "",
          "type-id": null,
          type: null,
          country: null,
          "life-span": { begin: null, end: null, ended: false },
          tags: [],
          genres: [],
          "release-groups": [],
          relations: [],
          "release-group-count": 0,
          "release-count": 0,
        };
        res.setHeader("Content-Type", "application/json");
        res.json(fallback);
      } finally {
        pendingArtistRequests.delete(mbid);
      }
    } catch (error) {
      console.error(
        `[Artists Route] Unexpected error in artist details route:`,
        error.message,
      );
      console.error(`[Artists Route] Error stack:`, error.stack);
      res.status(500).json({
        error: "Failed to fetch artist details",
        message: error.message,
      });
    }
  });
}

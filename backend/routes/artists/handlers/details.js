import { UUID_REGEX } from "../../../config/constants.js";
import {
  getLastfmApiKey,
  lastfmRequest,
  musicbrainzGetArtistAppearsOnReleaseGroups,
  musicbrainzGetArtistReleaseGroups,
  musicbrainzGetArtistNameByMbid,
} from "../../../services/apiClients.js";
import { dbOps } from "../../../config/db-helpers.js";
import { cacheMiddleware } from "../../../middleware/cache.js";
import { requireAuth } from "../../../middleware/requirePermission.js";
import { buildArtistRequestKey, pendingArtistRequests } from "../utils.js";
import { getArtistByMbid } from "../../../services/metadataProvider.js";

export default function registerDetails(router) {
  const toLegacyRelations = (metadataArtist) =>
    Array.isArray(metadataArtist?.links)
      ? metadataArtist.links
          .filter((link) => link?.target)
          .map((link) => ({
            type: link.type || "external",
            url: { resource: link.target },
          }))
      : [];

  const getLastfmTags = async (mbid, artistName = "") => {
    if (!getLastfmApiKey()) return [];
    let data = await lastfmRequest("artist.getTopTags", { mbid }).catch(() => null);
    if (!data?.toptags?.tag && artistName) {
      data = await lastfmRequest("artist.getTopTags", { artist: artistName }).catch(
        () => null,
      );
    }
    const tags = data?.toptags?.tag
      ? Array.isArray(data.toptags.tag)
        ? data.toptags.tag
        : [data.toptags.tag]
      : [];
    return tags
      .map((tag) => ({
        name: String(tag?.name || "").trim(),
        count: Number(tag?.count || 0),
      }))
      .filter((tag) => tag.name);
  };

  const getArtistTagPayload = async (mbid, artistName = "", metadataArtist = null) => {
    const lastfmTags = await getLastfmTags(mbid, artistName);
    if (lastfmTags.length > 0) {
      return {
        tags: lastfmTags,
        genres: lastfmTags.map((tag) => tag.name),
      };
    }
    const fallbackGenres = Array.isArray(metadataArtist?.genres)
      ? metadataArtist.genres.filter(Boolean)
      : [];
    return {
      tags: fallbackGenres.map((genre) => ({ name: genre, count: 0 })),
      genres: fallbackGenres,
    };
  };

  const parseSelectedReleaseTypes = (value) =>
    typeof value === "string" && value.trim()
      ? value
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean)
      : null;

  const parseAppearsOnLimit = (value) => {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  };

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
      const responseMode =
        typeof req.query.mode === "string" && req.query.mode.trim()
          ? req.query.mode.trim().toLowerCase()
          : "full";
      const coreOnly = responseMode === "core";
      const selectedReleaseTypes = parseSelectedReleaseTypes(
        req.query.releaseTypes,
      );
      const appearsOnLimit = parseAppearsOnLimit(req.query.appearsOnLimit);
      const requestKey = buildArtistRequestKey({
        mbid,
        mode: responseMode,
        selectedReleaseTypes,
        appearsOnLimit,
      });

      if (!UUID_REGEX.test(mbid)) {
        console.log(`[Artists Route] Invalid MBID format: ${mbid}`);
        return res.status(400).json({
          error: "Invalid MBID format",
          message: `"${mbid}" is not a valid MusicBrainz ID. MBIDs must be UUIDs.`,
        });
      }

      if (pendingArtistRequests.has(requestKey)) {
        console.log(
          `[Artists Route] Request for ${requestKey} already in progress, waiting...`,
        );
        try {
          const data = await pendingArtistRequests.get(requestKey);
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

      const { lidarrClient } =
        await import("../../../services/lidarrClient.js");
      const { libraryManager } =
        await import("../../../services/libraryManager.js");

      let data = null;
      const override = dbOps.getArtistOverride(mbid);
      const resolvedMbid = override?.musicbrainzId || mbid;

      let lidarrArtist = null;
      let lidarrAlbums = [];

      if (lidarrClient.isConfigured()) {
        try {
          lidarrArtist = await lidarrClient.getArtistByMbid(mbid);
          if (lidarrArtist) {
            console.log(
              `[Artists Route] Found artist in Lidarr: ${lidarrArtist.artistName}`,
            );
            const libraryArtist = await libraryManager.getArtist(mbid);
            if (libraryArtist) {
              lidarrAlbums = await libraryManager.getAlbums(
                libraryArtist.id,
                lidarrArtist,
              );
            }
          }
        } catch (error) {
          console.warn(
            `[Artists Route] Failed to fetch from Lidarr: ${error.message}`,
          );
        }
      }

      if (lidarrArtist) {
        const artistMbid =
          override?.musicbrainzId || lidarrArtist.foreignArtistId || mbid;
        const metadataArtist = coreOnly
          ? null
          : await getArtistByMbid(artistMbid).catch(() => null);
        const releaseGroups = await musicbrainzGetArtistReleaseGroups(
          artistMbid,
          selectedReleaseTypes,
          { includeTrackCounts: !appearsOnLimit },
        );
        const appearsOnReleaseGroups = coreOnly
          ? []
          : await musicbrainzGetArtistAppearsOnReleaseGroups(
              artistMbid,
              releaseGroups,
              { limit: appearsOnLimit },
            );
        const tagPayload = coreOnly
          ? { tags: [], genres: [] }
          : await getArtistTagPayload(
              artistMbid,
              metadataArtist?.name || lidarrArtist.artistName,
              metadataArtist,
            );
        const payload = {
          id: artistMbid,
          name: metadataArtist?.name || lidarrArtist.artistName,
          "sort-name":
            metadataArtist?.sortName || metadataArtist?.name || lidarrArtist.artistName,
          disambiguation: metadataArtist?.disambiguation || "",
          "type-id": null,
          type: metadataArtist?.type || null,
          country: null,
          "life-span": {
            begin: null,
            end: null,
            ended: false,
          },
          tags: tagPayload.tags,
          genres: tagPayload.genres,
          links: Array.isArray(metadataArtist?.links) ? metadataArtist.links : [],
          "release-groups": releaseGroups,
          "appears-on-release-groups": appearsOnReleaseGroups,
          relations: toLegacyRelations(metadataArtist),
          rating: metadataArtist?.rating || null,
          "release-group-count": releaseGroups.length,
          "release-count": releaseGroups.length,
          _lidarrData: {
            id: lidarrArtist.id,
            monitored: lidarrArtist.monitored,
            statistics: lidarrArtist.statistics,
          },
          ...(metadataArtist?.overview ? { bio: metadataArtist.overview } : {}),
        };

        res.setHeader("Content-Type", "application/json");
        res.json(payload);
        return;
      }

      const fetchPromise = (async () => {
        const metadataArtist = coreOnly
          ? null
          : await getArtistByMbid(resolvedMbid).catch(() => null);
        const name =
          (req.query.artistName || "").trim() ||
          metadataArtist?.name ||
          (await musicbrainzGetArtistNameByMbid(resolvedMbid)) ||
          "Unknown Artist";
        const tagPayload = coreOnly
          ? { tags: [], genres: [] }
          : await getArtistTagPayload(resolvedMbid, name, metadataArtist);
        const releaseGroups = await musicbrainzGetArtistReleaseGroups(
          resolvedMbid,
          selectedReleaseTypes,
          { includeTrackCounts: !appearsOnLimit },
        );
        const appearsOnReleaseGroups = coreOnly
          ? []
          : await musicbrainzGetArtistAppearsOnReleaseGroups(
              resolvedMbid,
              releaseGroups,
              { limit: appearsOnLimit },
            );
        return {
          id: resolvedMbid,
          name,
          "sort-name": metadataArtist?.sortName || name,
          disambiguation: metadataArtist?.disambiguation || "",
          "type-id": null,
          type: metadataArtist?.type || null,
          country: null,
          "life-span": { begin: null, end: null, ended: false },
          tags: tagPayload.tags,
          genres: tagPayload.genres,
          links: Array.isArray(metadataArtist?.links) ? metadataArtist.links : [],
          "release-groups": releaseGroups,
          "appears-on-release-groups": appearsOnReleaseGroups,
          relations: toLegacyRelations(metadataArtist),
          rating: metadataArtist?.rating || null,
          "release-group-count": releaseGroups.length,
          "release-count": releaseGroups.length,
          bio: metadataArtist?.overview || undefined,
        };
      })();

      pendingArtistRequests.set(requestKey, fetchPromise);

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
          links: [],
          "release-groups": [],
          "appears-on-release-groups": [],
          relations: [],
          "release-group-count": 0,
          "release-count": 0,
        };
        res.setHeader("Content-Type", "application/json");
        res.json(fallback);
      } finally {
        pendingArtistRequests.delete(requestKey);
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

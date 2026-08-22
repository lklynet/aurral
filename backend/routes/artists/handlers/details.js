import { UUID_REGEX } from "../../../../lib/uuid.js";
import { logger } from "../../../services/logger.js";
import {
  musicbrainzGetArtistAppearsOnReleaseGroups,
  musicbrainzGetArtistReleaseGroups,
  musicbrainzGetArtistNameByMbid,
} from "../../../services/apiClients/index.js";
import { dbOps } from "../../../db/helpers/index.js";
import { cacheMiddleware } from "../../../middleware/cache.js";
import { requireAuth } from "../../../middleware/requirePermission.js";
import { buildArtistRequestKey, pendingArtistRequests } from "../utils.js";
import { getArtistByMbid } from "../../../services/providers/brainzmashProvider.js";
import { getArtistTagPayload, buildArtistBase } from "../shared/transform.js";
import { getCanonicalArtistProjection } from "../../../services/libraryQueryService.js";

export function getCanonicalLidarrArtist(reference) {
  const artist = getCanonicalArtistProjection({ reference })[0] || null;
  if (!artist?.lidarrManaged) return null;
  return {
    id: artist.providerId || artist.id,
    artistName: artist.artistName,
    monitored: artist.monitored,
    statistics: artist.statistics,
  };
}

export function registerDetails(router) {
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
        logger.warn("api", "Invalid MBID format", { mbid });
        return res.status(400).json({
          error: "Invalid MBID format",
          message: `"${mbid}" is not a valid MusicBrainz ID. MBIDs must be UUIDs.`,
        });
      }

      if (pendingArtistRequests.has(requestKey)) {
        logger.info("api", "Request already in progress, waiting", { requestKey });
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

      logger.info("api", "Fetching artist details", { mbid });

      let data = null;
      const override = dbOps.getArtistOverride(mbid);
      const resolvedMbid = override?.musicbrainzId || mbid;

      const lidarrArtist =
        getCanonicalLidarrArtist(resolvedMbid) ||
        (resolvedMbid === mbid ? null : getCanonicalLidarrArtist(mbid));

      if (lidarrArtist) {
        const artistMbid = override?.musicbrainzId || mbid;
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
          ...buildArtistBase(metadataArtist?.name || lidarrArtist.artistName, artistMbid, metadataArtist),
          tags: tagPayload.tags,
          genres: tagPayload.genres,
          "release-groups": releaseGroups,
          "appears-on-release-groups": appearsOnReleaseGroups,
          "release-group-count": releaseGroups.length,
          "release-count": releaseGroups.length,
          _lidarrData: {
            id: lidarrArtist.id,
            monitored: lidarrArtist.monitored,
            statistics: lidarrArtist.statistics,
          },
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
          ...buildArtistBase(name, resolvedMbid, metadataArtist),
          tags: tagPayload.tags,
          genres: tagPayload.genres,
          "release-groups": releaseGroups,
          "appears-on-release-groups": appearsOnReleaseGroups,
          "release-group-count": releaseGroups.length,
          "release-count": releaseGroups.length,
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
      logger.error("api", "Unexpected error in artist details route", { error: error.message });
      logger.error("api", "Error stack", { stack: error.stack });
      res.status(500).json({
        error: "Failed to fetch artist details",
        message: error.message,
      });
    }
  });
}

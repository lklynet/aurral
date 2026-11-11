import { Hono } from "hono";
import * as v from "valibot";
import { UUID_REGEX } from "../../../../lib/uuid.ts";
import { logger } from "../../../services/logger.ts";
import {
  musicbrainzGetArtistAppearsOnReleaseGroups,
  musicbrainzGetArtistReleaseGroups,
  musicbrainzGetArtistNameByMbid,
} from "../../../services/apiClients/index.ts";
import { dbOps } from "../../../db/helpers/index.ts";
import { cacheFor } from "../../../middleware/cacheHeaders.ts";
import { requireAuth } from "../../../middleware/guards.ts";
import type { AppEnv } from "../../../middleware/requestUser.ts";
import { validate } from "../../../middleware/validate.ts";
import {
  appearsOnLimitQuery,
  buildArtistRequestKey,
  invalidMbid,
  queryText,
  releaseTypesQuery,
} from "../utils.ts";
import { getArtistByMbid } from "../../../services/providers/brainzmashProvider.ts";
import { invalidateArtistImage } from "../../../services/imageService.ts";
import { withCoverUrls } from "../../../services/releaseGroupCoverService.ts";
import {
  getArtistTagPayload,
  buildArtistBase,
  withListenBrainzStats,
} from "../shared/transform.ts";
import { asAppError, errorResponseText } from "../../../../lib/errors.ts";
import { isErrorStatus } from "../../shared/errorStatus.ts";

const TAG_WAIT_MS = 2000;

const tagsWithin = (tags: ReturnType<typeof getArtistTagPayload>) => {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<Awaited<typeof tags>>((resolve) => {
    timer = setTimeout(resolve, TAG_WAIT_MS, { tags: [], genres: [] });
  });
  return Promise.race([tags, deadline]).finally(() => clearTimeout(timer));
};

async function loadArtistDetails(
  mbid: string,
  {
    artistName,
    coreOnly,
    selectedReleaseTypes,
    appearsOnLimit,
  }: {
    artistName: string;
    coreOnly: boolean;
    selectedReleaseTypes: string[] | null;
    appearsOnLimit: number | null;
  },
) {
  const metadataArtistPromise = getArtistByMbid(mbid).catch(() => null);
  const releaseGroupsPromise = musicbrainzGetArtistReleaseGroups(
    mbid,
    selectedReleaseTypes,
    coreOnly ? { includeTrackCounts: false } : { includeTrackCounts: !appearsOnLimit },
  ).then(withListenBrainzStats);
  const appearsOnPromise = coreOnly
    ? Promise.resolve([])
    : musicbrainzGetArtistAppearsOnReleaseGroups(mbid, { limit: appearsOnLimit }).catch(() => []);
  const metadataArtist = await metadataArtistPromise;
  const name =
    artistName ||
    metadataArtist?.name ||
    (await musicbrainzGetArtistNameByMbid(mbid)) ||
    "Unknown Artist";
  const [tagPayload, { releaseGroups, pending }, appearsOnReleaseGroups] = await Promise.all([
    tagsWithin(getArtistTagPayload(mbid, name, metadataArtist)),
    releaseGroupsPromise,
    appearsOnPromise,
  ]);
  return {
    ...buildArtistBase(name, mbid, metadataArtist),
    tags: tagPayload.tags,
    genres: tagPayload.genres,
    "release-groups": withCoverUrls(releaseGroups),
    "appears-on-release-groups": withCoverUrls(appearsOnReleaseGroups),
    "release-group-count": releaseGroups.length,
    "release-count": releaseGroups.length,
    "release-stats-pending": pending,
  };
}

const pendingArtistRequests = new Map<string, ReturnType<typeof loadArtistDetails>>();

const detailsQuery = v.object({
  artistName: queryText,
  mode: v.pipe(queryText, v.toLowerCase()),
  releaseTypes: releaseTypesQuery,
  appearsOnLimit: appearsOnLimitQuery,
});

const overridesBody = v.object({
  musicbrainzId: v.nullish(v.pipe(v.string(), v.trim())),
  deezerArtistId: v.nullish(
    v.pipe(
      v.union([v.string(), v.number()]),
      v.transform((id) => String(id).trim()),
    ),
  ),
});

export default new Hono<AppEnv>()
  .basePath("/artists")
  .get("/", (c) =>
    c.json(
      {
        error: "Not found",
        message: "Use /api/artists/:mbid to get artist details, or /api/search/artists to search",
      },
      404,
    ),
  )
  .get("/:mbid/overrides", requireAuth, (c) => {
    const mbid = c.req.param("mbid");
    if (!UUID_REGEX.test(mbid)) return c.json(invalidMbid(mbid), 400);
    const override = dbOps.getArtistOverride(mbid);
    return c.json(
      {
        mbid,
        musicbrainzId: override?.musicbrainzId || null,
        deezerArtistId: override?.deezerArtistId || null,
      },
      200,
    );
  })
  .put("/:mbid/overrides", requireAuth, validate("json", overridesBody), (c) => {
    const mbid = c.req.param("mbid");
    if (!UUID_REGEX.test(mbid)) return c.json(invalidMbid(mbid), 400);

    const body = c.req.valid("json");
    const musicbrainzId = body.musicbrainzId || null;
    const deezerArtistId = body.deezerArtistId || null;

    if (musicbrainzId && !UUID_REGEX.test(musicbrainzId)) {
      return c.json(
        {
          error: "Invalid MusicBrainz ID format",
          message: `"${musicbrainzId}" is not a valid MusicBrainz ID. MBIDs must be UUIDs.`,
        },
        400,
      );
    }

    if (deezerArtistId && !/^\d+$/.test(deezerArtistId)) {
      return c.json(
        {
          error: "Invalid Deezer artist ID",
          message: `"${deezerArtistId}" must be a numeric Deezer artist ID.`,
        },
        400,
      );
    }

    if (!musicbrainzId && !deezerArtistId) {
      dbOps.deleteArtistOverride(mbid);
      invalidateArtistImage(mbid);
      return c.json({ mbid, musicbrainzId: null, deezerArtistId: null }, 200);
    }

    const saved = dbOps.setArtistOverride(mbid, { musicbrainzId, deezerArtistId });
    invalidateArtistImage(mbid);
    return c.json(saved, 200);
  })
  .get("/:mbid", cacheFor(300), validate("query", detailsQuery), async (c) => {
    try {
      const mbid = c.req.param("mbid");
      const query = c.req.valid("query");
      const responseMode = query.mode || "full";
      const coreOnly = responseMode === "core";
      const selectedReleaseTypes = query.releaseTypes ?? null;
      const appearsOnLimit = query.appearsOnLimit ?? null;
      const requestKey = buildArtistRequestKey({
        mbid,
        mode: responseMode,
        selectedReleaseTypes,
        appearsOnLimit,
      });

      if (!UUID_REGEX.test(mbid)) {
        logger.warn("api", "Invalid MBID format", { mbid });
        return c.json(invalidMbid(mbid), 400);
      }

      const pending = pendingArtistRequests.get(requestKey);
      if (pending) {
        logger.info("api", "Request already in progress, waiting", { requestKey });
        try {
          const artist = await pending;
          if (artist["release-stats-pending"]) c.header("Cache-Control", "no-store");
          return c.json(artist, 200);
        } catch (error) {
          const failure = asAppError(error);
          const status = failure?.response?.status;
          return c.json(
            {
              error: "Failed to fetch artist details",
              message: errorResponseText(failure, "error") || failure?.message,
            },
            isErrorStatus(status) ? status : 500,
          );
        }
      }

      logger.info("api", "Fetching artist details", { mbid });

      const override = dbOps.getArtistOverride(mbid);
      const resolvedMbid = override?.musicbrainzId || mbid;

      const fetchPromise = loadArtistDetails(resolvedMbid, {
        artistName: query.artistName,
        coreOnly,
        selectedReleaseTypes,
        appearsOnLimit,
      });
      pendingArtistRequests.set(requestKey, fetchPromise);

      try {
        const artist = await fetchPromise;
        if (artist["release-stats-pending"]) c.header("Cache-Control", "no-store");
        return c.json(artist, 200);
      } catch {
        return c.json(
          {
            ...buildArtistBase(query.artistName || "Unknown Artist", resolvedMbid),
            tags: [],
            "release-groups": [],
            "appears-on-release-groups": [],
            "release-group-count": 0,
            "release-count": 0,
            "release-stats-pending": false,
          },
          200,
        );
      } finally {
        pendingArtistRequests.delete(requestKey);
      }
    } catch (error) {
      const failure = asAppError(error);
      logger.error("api", "Unexpected error in artist details route", { error: failure?.message });
      logger.error("api", "Error stack", { stack: failure?.stack });
      return c.json({ error: "Failed to fetch artist details", message: failure?.message }, 500);
    }
  });

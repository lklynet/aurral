import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import * as v from "valibot";
import { UUID_REGEX } from "../../../../lib/uuid.ts";
import {
  musicbrainzGetArtistAppearsOnReleaseGroups,
  musicbrainzGetArtistReleaseGroups,
  musicbrainzGetArtistNameByMbid,
} from "../../../services/apiClients/index.ts";
import { dbOps } from "../../../db/helpers/index.ts";
import { requireStreamAuth } from "../../../middleware/guards.ts";
import { noCache } from "../../../middleware/cacheHeaders.ts";
import type { AppEnv } from "../../../middleware/requestUser.ts";
import { validate } from "../../../middleware/validate.ts";
import { logger } from "../../../services/logger.ts";
import { getArtistImage } from "../../../services/imageService.ts";
import { attachCachedCoverUrls } from "../../../services/releaseGroupCoverService.ts";
import { getArtistLibraryLookup } from "../../library/handlers/misc.ts";
import { getArtistByMbid } from "../../../services/providers/brainzmashProvider.ts";
import {
  getArtistTagPayload,
  buildArtistBase,
  getSimilarArtistCards,
  withListenBrainzStats,
} from "../shared/transform.ts";
import { asAppError, errorResponseText } from "../../../../lib/errors.ts";

type AppearsOnReleaseGroups = Awaited<
  ReturnType<typeof musicbrainzGetArtistAppearsOnReleaseGroups>
>;

const streamQuery = v.object({
  artistName: v.optional(v.pipe(v.string(), v.trim())),
  releaseTypes: v.optional(
    v.pipe(
      v.string(),
      v.transform((types) =>
        types.trim()
          ? types
              .split(",")
              .map((value) => value.trim())
              .filter(Boolean)
          : null,
      ),
    ),
  ),
  appearsOnLimit: v.optional(
    v.pipe(
      v.string(),
      v.transform((limit) => {
        const parsed = Number.parseInt(limit, 10);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
      }),
    ),
  ),
});

export default new Hono<AppEnv>()
  .basePath("/artists")
  .get("/:mbid/stream", noCache, requireStreamAuth, validate("query", streamQuery), (c) => {
    const mbid = c.req.param("mbid");
    if (!UUID_REGEX.test(mbid)) {
      return c.json(
        {
          error: "Invalid MBID format",
          message: `"${mbid}" is not a valid MusicBrainz ID. MBIDs must be UUIDs.`,
        },
        400,
      );
    }
    const query = c.req.valid("query");
    const streamArtistName = query.artistName ?? "";
    const selectedReleaseTypes = query.releaseTypes ?? null;
    const appearsOnLimit = query.appearsOnLimit ?? null;
    const { signal } = c.req.raw;
    const isClientConnected = () => !signal.aborted;

    c.header("X-Accel-Buffering", "no");
    return streamSSE(c, async (stream) => {
      const send = (event: string, data: unknown) =>
        stream.writeSSE({ event, data: JSON.stringify(data) });
      const sendArtist = async (payload: unknown) => {
        if (isClientConnected()) await send("artist", payload);
      };
      await send("connected", { mbid });

      try {
        const resolvedMbid = dbOps.getArtistOverride(mbid)?.musicbrainzId || mbid;
        await sendArtist({
          ...buildArtistBase(streamArtistName || "Unknown Artist", resolvedMbid),
          tags: [],
          genres: [],
        });

        const metadataArtistPromise = getArtistByMbid(resolvedMbid, { signal }).catch(() => null);
        const namePromise = (async () => {
          const metadataArtist = await metadataArtistPromise;
          if (metadataArtist?.name) return metadataArtist.name;
          if (streamArtistName) return streamArtistName;
          return (
            (await musicbrainzGetArtistNameByMbid(resolvedMbid, { signal })) || "Unknown Artist"
          );
        })();

        const artistTask = Promise.all([metadataArtistPromise, namePromise]).then(
          async ([metadataArtist, name]) => {
            if (!metadataArtist || !isClientConnected()) return;
            const tagPayload = await getArtistTagPayload(resolvedMbid, name, metadataArtist);
            await sendArtist({
              ...buildArtistBase(name, resolvedMbid, metadataArtist),
              tags: tagPayload.tags,
              genres: tagPayload.genres,
            });
          },
        );

        const libraryTask = (async () => {
          const lookup = await getArtistLibraryLookup(mbid);
          if (isClientConnected()) await send("library", lookup);
        })();

        const releaseGroupsPromise = musicbrainzGetArtistReleaseGroups(
          resolvedMbid,
          selectedReleaseTypes,
          {
            includeTrackCounts: false,
            hydrateLimit: appearsOnLimit ? 6 : 0,
            signal,
          },
        )
          .catch(() => [])
          .then(withListenBrainzStats);
        const discographyTask = Promise.all([
          metadataArtistPromise,
          namePromise,
          releaseGroupsPromise,
        ]).then(async ([metadataArtist, name, releaseGroups]) => {
          if (!isClientConnected()) return;
          const releaseGroupsWithCovers = attachCachedCoverUrls(releaseGroups, 12);
          await sendArtist({
            ...buildArtistBase(name, resolvedMbid, metadataArtist),
            "release-groups": releaseGroupsWithCovers,
            "release-group-count": releaseGroupsWithCovers.length,
            "release-count": releaseGroupsWithCovers.length,
          });
        });

        const appearsOnTask = musicbrainzGetArtistAppearsOnReleaseGroups(resolvedMbid, {
          limit: appearsOnLimit,
          signal,
        })
          .catch((): AppearsOnReleaseGroups => [])
          .then(async (appearsOnReleaseGroups) => {
            if (!isClientConnected()) return;
            await sendArtist({
              id: resolvedMbid,
              "appears-on-release-groups": attachCachedCoverUrls(
                appearsOnReleaseGroups,
                appearsOnLimit || 6,
              ),
            });
          });

        const coverTask = (async () => {
          if (!isClientConnected()) return;
          try {
            const cachedImage = dbOps.getImage(mbid);
            const artistName = (await namePromise.catch(() => null)) || streamArtistName || null;
            if (!isClientConnected()) return;
            if (cachedImage && cachedImage.imageUrl && cachedImage.imageUrl !== "NOT_FOUND") {
              const cachedCover = await getArtistImage(mbid, { artistName }).catch(() => null);
              await send("cover", { images: cachedCover?.images || [] });
              return;
            }
            const negativeCacheIsFresh =
              cachedImage?.imageUrl === "NOT_FOUND" &&
              cachedImage.cacheAge &&
              Date.now() - cachedImage.cacheAge < 7 * 24 * 60 * 60 * 1000;
            if (negativeCacheIsFresh) {
              await send("cover", { images: [] });
              return;
            }
            const cover = await getArtistImage(mbid, {
              artistName,
              forceRefresh: cachedImage?.imageUrl === "NOT_FOUND",
            });
            await send("cover", { images: cover?.images?.length ? cover.images : [] });
          } catch {
            await send("cover", { images: [] });
          }
        })();

        const similarTask = (async () => {
          if (!isClientConnected()) return;
          try {
            const artists = await getSimilarArtistCards(resolvedMbid, {
              artistName: streamArtistName,
              limit: 10,
              signal,
              resolveArtistName: async () =>
                (await metadataArtistPromise.catch(() => null))?.name ||
                (await namePromise.catch(() => null)),
            });
            if (isClientConnected()) await send("similar", { artists });
          } catch {
            await send("similar", { artists: [] });
          }
        })();

        await Promise.allSettled([
          artistTask,
          libraryTask,
          discographyTask,
          appearsOnTask,
          coverTask,
          similarTask,
        ]);
        await send("complete", {});
        await stream.sleep(100);
      } catch (error) {
        const failure = asAppError(error);
        logger.error("stream", `Error for artist ${mbid}:`, { message: failure?.message });
        await send("error", {
          error: "Failed to fetch artist details",
          message: errorResponseText(failure, "error") || failure?.message,
        });
      }
    });
  });

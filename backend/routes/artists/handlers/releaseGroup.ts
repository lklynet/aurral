import { Hono } from "hono";
import * as v from "valibot";
import { UUID_REGEX } from "../../../../lib/uuid.ts";
import { dbOps } from "../../../db/helpers/index.ts";
import { cacheFor, noCache } from "../../../middleware/cacheHeaders.ts";
import type { AppEnv } from "../../../middleware/requestUser.ts";
import { validate } from "../../../middleware/validate.ts";
import {
  fetchReleaseGroupCoverUrl,
  resolveReleaseGroupCoversBatch,
} from "../../../services/releaseGroupCoverService.ts";
import { enrichTracksWithDeezerPreviews } from "../../../services/apiClients/index.ts";
import {
  getArtistByMbid,
  getAlbumByMbid,
  getAlbumTracksByAlbumMbid,
} from "../../../services/providers/brainzmashProvider.ts";
import {
  getLinkedDeezerArtistId,
  toLegacyReleaseGroupSummary,
} from "../../../services/providers/brainzmashMappers.ts";
import { logger } from "../../../services/logger.ts";
import { chooseLibraryRelease } from "../../../services/releaseResolver.ts";
import { asAppError } from "../../../../lib/errors.ts";
import { queryText } from "../utils.ts";

type ReleaseGroupAlbum = Awaited<ReturnType<typeof getAlbumByMbid>>;
type ReleaseGroupCovers = Awaited<ReturnType<typeof resolveReleaseGroupCoversBatch>>;

const ratingsBody = v.object({ ids: v.optional(v.array(v.string()), []) });

const coversBody = v.object({
  items: v.optional(
    v.array(
      v.object({
        mbid: v.optional(v.string()),
        id: v.optional(v.string()),
        artistName: v.optional(v.string()),
        albumTitle: v.optional(v.string()),
      }),
    ),
    [],
  ),
});

const coverQuery = v.object({
  refresh: v.optional(v.string()),
  artistName: queryText,
  albumTitle: queryText,
});

const tracksQuery = v.object({
  artistMbid: queryText,
  artistName: queryText,
  albumTitle: queryText,
  releaseType: queryText,
  releaseDate: queryText,
  deezerAlbumId: queryText,
});

export default new Hono<AppEnv>()
  .basePath("/artists")
  .post("/release-groups/ratings", validate("json", ratingsBody), async (c) => {
    const ids = [...new Set(c.req.valid("json").ids)]
      .map((id) => id.trim())
      .filter((id) => UUID_REGEX.test(id))
      .slice(0, 24);
    const ratings: Record<
      string,
      { rating: ReleaseGroupAlbum["rating"]; firstReleaseDate: ReleaseGroupAlbum["releaseDate"] }
    > = {};
    if (!ids.length) return c.json({ ratings }, 200);

    const { signal } = c.req.raw;
    try {
      for (let index = 0; index < ids.length; index += 6) {
        signal.throwIfAborted();
        const batch = ids.slice(index, index + 6);
        const results = await Promise.allSettled(batch.map((id) => getAlbumByMbid(id, { signal })));
        batch.forEach((id, batchIndex) => {
          const result = results[batchIndex];
          if (result.status !== "fulfilled") return;
          ratings[id] = {
            rating: result.value?.rating || null,
            firstReleaseDate: result.value?.releaseDate || null,
          };
        });
      }
      return c.json({ ratings }, 200);
    } catch (error) {
      return c.json(
        { error: "Failed to load release ratings", message: asAppError(error)?.message },
        502,
      );
    }
  })
  .post("/release-groups/covers", validate("json", coversBody), async (c) => {
    const { items } = c.req.valid("json");
    const noCovers: ReleaseGroupCovers = {};
    if (!items.length) return c.json({ covers: noCovers }, 200);
    try {
      const covers = await resolveReleaseGroupCoversBatch(items);
      const hasTransientError = Object.values(covers).some((entry) => entry?.transientError);
      c.header(
        "Cache-Control",
        hasTransientError
          ? "public, max-age=60, stale-while-revalidate=300"
          : "public, max-age=31536000, immutable",
      );
      return c.json({ covers }, 200);
    } catch (error) {
      logger.error("releaseGroup", "Error in release-groups covers batch route:", {
        message: asAppError(error)?.message,
      });
      c.header("Cache-Control", "public, max-age=60");
      return c.json({ covers: noCovers }, 200);
    }
  })
  .get("/release-group/:mbid", cacheFor(3600), async (c) => {
    const mbid = c.req.param("mbid");
    try {
      if (!UUID_REGEX.test(mbid)) {
        return c.json({ error: "Invalid MBID format" }, 400);
      }

      const album = await getAlbumByMbid(mbid);
      const primaryArtist = Array.isArray(album?.artists) ? album.artists[0] : null;
      return c.json(
        {
          ...toLegacyReleaseGroupSummary(album, primaryArtist),
          genres: Array.isArray(album?.genres) ? album.genres : [],
          overview: album?.overview || "",
          coverUrl:
            Array.isArray(album?.images) && album.images[0]?.url ? album.images[0].url : null,
        },
        200,
      );
    } catch (error) {
      const failure = asAppError(error);
      logger.error("releaseGroup", `Error in release-group details route for ${mbid}:`, {
        message: failure?.message,
      });
      return c.json({ error: "Release not found", message: failure?.message }, 404);
    }
  })
  .get("/release-group/:mbid/cover", validate("query", coverQuery), async (c) => {
    const mbid = c.req.param("mbid");
    const query = c.req.valid("query");
    const bypassCache = query.refresh === "true";
    try {
      if (!UUID_REGEX.test(mbid)) {
        return c.json({ error: "Invalid MBID format", images: [] }, 400);
      }
      const cover = await fetchReleaseGroupCoverUrl(mbid, {
        artistName: query.artistName,
        albumTitle: query.albumTitle,
        bypassCache,
      });
      if (cover?.imageUrl) {
        c.header("Cache-Control", bypassCache ? "no-store" : "public, max-age=31536000, immutable");
        return c.json(
          {
            images: [{ image: cover.imageUrl, front: true, types: cover.types || ["Front"] }],
            notFound: false,
            transientError: false,
          },
          200,
        );
      }
      if (cover?.notFound) {
        c.header("Cache-Control", bypassCache ? "no-store" : "public, max-age=3600");
        return c.json({ images: [], notFound: true, transientError: false }, 200);
      }
      c.header(
        "Cache-Control",
        bypassCache ? "no-store" : "public, max-age=60, stale-while-revalidate=300",
      );
      return c.json({ images: [], notFound: false, transientError: true }, 200);
    } catch (error) {
      logger.error("releaseGroup", `Error in release-group cover route for ${mbid}:`, {
        message: asAppError(error)?.message,
      });
      c.header("Cache-Control", bypassCache ? "no-store" : "public, max-age=60");
      return c.json({ images: [], notFound: false, transientError: true }, 200);
    }
  })
  .get("/release-group/:mbid/tracks", noCache, validate("query", tracksQuery), async (c) => {
    try {
      const mbid = c.req.param("mbid");
      if (!UUID_REGEX.test(mbid)) {
        return c.json({ error: "Invalid MBID format" }, 400);
      }

      const query = c.req.valid("query");
      const artistMbid = UUID_REGEX.test(query.artistMbid) ? query.artistMbid : "";
      const { artistName, albumTitle, releaseType, releaseDate, deezerAlbumId } = query;

      const tracks = await getAlbumTracksByAlbumMbid(mbid, { chooseRelease: chooseLibraryRelease });
      let deezerArtistId = "";
      if (artistMbid) {
        const override = dbOps.getArtistOverride(artistMbid);
        deezerArtistId = override?.deezerArtistId || "";
        if (!deezerArtistId) {
          const resolvedArtistMbid = override?.musicbrainzId || artistMbid;
          const metadataArtist = await getArtistByMbid(resolvedArtistMbid).catch(() => null);
          deezerArtistId = getLinkedDeezerArtistId(metadataArtist?.links) || "";
        }
      }
      const enrichedTracks: ((typeof tracks)[number] & {
        preview_url?: string | null;
        previewProvider?: string;
        previewTrackId?: string;
      })[] = await enrichTracksWithDeezerPreviews(tracks, {
        artistName,
        deezerArtistId,
        deezerAlbumId,
        albumTitle,
        releaseType,
        releaseDate,
        cacheKey: `release-group:${mbid}:${deezerAlbumId || deezerArtistId || artistName}`,
      });

      return c.json(
        enrichedTracks.map((track) => ({
          id: track.recordingId || track.id,
          mbid: track.recordingId || track.id,
          title: track.title,
          trackName: track.title,
          trackNumber: track.trackPosition || track.trackNumber || 0,
          discNumber: track.mediumNumber || 1,
          position: track.trackPosition || track.trackNumber || 0,
          releaseMbid: track.releaseMbid || null,
          length: track.durationMs || null,
          preview_url: track.preview_url || null,
          previewProvider: track.previewProvider || null,
          previewTrackId: track.previewTrackId || null,
        })),
        200,
      );
    } catch (error) {
      const failure = asAppError(error);
      logger.error("releaseGroup", "Error fetching release group tracks:", {
        message: failure?.message,
      });
      return c.json({ error: "Failed to fetch tracks", message: failure?.message }, 500);
    }
  });

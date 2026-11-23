import { Hono, type Context } from "hono";
import * as v from "valibot";
import { UUID_REGEX } from "../../../../lib/uuid.ts";
import { dbOps } from "../../../db/helpers/index.ts";
import { cacheFor, noCache } from "../../../middleware/cacheHeaders.ts";
import { requireStreamAuth } from "../../../middleware/guards.ts";
import type { AppEnv } from "../../../middleware/requestUser.ts";
import { validate } from "../../../middleware/validate.ts";
import {
  fetchReleaseGroupCoverUrl,
  savedReleaseGroupCoverUrl,
} from "../../../services/releaseGroupCoverService.ts";
import { selectAlbumCover } from "../../../services/imageRanking.ts";
import { deezerPreviewSearchPath } from "../../../../lib/deezerPreview.ts";
import { enrichTracksWithDeezerPreviews } from "../../../services/apiClients/index.ts";
import {
  getArtistByMbid,
  getAlbumByMbid,
  getAlbumTracksByAlbumMbid,
  isMetadataNotFoundError,
} from "../../../services/providers/metadataProvider.ts";
import {
  getLinkedDeezerArtistId,
  toLegacyReleaseGroupSummary,
} from "../../../services/providers/metadataMappers.ts";
import { logger } from "../../../services/logger.ts";
import {
  albumEditions,
  chooseAlbumEdition,
  editionOf,
  libraryRelease,
} from "../../../services/releaseResolver.ts";
import { asAppError } from "../../../../lib/errors.ts";
import { queryText } from "../utils.ts";

const coverQuery = v.object({
  refresh: v.optional(v.string()),
  artistName: queryText,
  albumTitle: queryText,
});

const coverImageQuery = v.object({ artist: queryText, title: queryText });

const editionQuery = v.object({ release: queryText });

const previewsQuery = v.object({
  artistMbid: queryText,
  deezerAlbumId: queryText,
  release: queryText,
});

const metadataUnavailable = <E extends AppEnv>(c: Context<E>, error: unknown) => {
  c.header("Cache-Control", "no-store");
  return c.json({ error: "Metadata unavailable", message: asAppError(error)?.message }, 502);
};

export default new Hono<AppEnv>()
  .basePath("/artists")
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
            savedReleaseGroupCoverUrl(mbid) ||
            album.cover ||
            selectAlbumCover(album.images)?.url ||
            null,
        },
        200,
      );
    } catch (error) {
      const failure = asAppError(error);
      logger.error("releaseGroup", `Error in release-group details route for ${mbid}:`, {
        message: failure?.message,
      });
      if (isMetadataNotFoundError(error)) {
        return c.json({ error: "Release not found", message: failure?.message }, 404);
      }
      c.header("Expires", "0");
      return metadataUnavailable(c, error);
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
  .get(
    "/release-group/:mbid/cover/image",
    requireStreamAuth,
    validate("query", coverImageQuery),
    async (c) => {
      const mbid = c.req.param("mbid");
      if (!UUID_REGEX.test(mbid)) return c.json({ error: "Invalid MBID format" }, 400);
      const { artist, title } = c.req.valid("query");
      const cover = await fetchReleaseGroupCoverUrl(mbid, {
        artistName: artist,
        albumTitle: title,
        listedWithoutCover: Boolean(title),
      }).catch(() => null);
      if (!cover?.imageUrl) {
        c.header("Cache-Control", cover?.notFound ? "private, max-age=3600" : "no-store");
        return c.json({ error: "Cover not found" }, 404);
      }
      c.header("Cache-Control", "private, max-age=86400");
      return c.redirect(cover.imageUrl, 302);
    },
  )
  .get("/release-group/:mbid/editions", noCache, async (c) => {
    const mbid = c.req.param("mbid");
    if (!UUID_REGEX.test(mbid)) return c.json({ error: "Invalid MBID format" }, 400);
    try {
      const group = await getAlbumByMbid(mbid, { withFallbackReleases: true });
      const editions = albumEditions(group);
      return c.json(
        {
          editions: editions.map(({ id, name, date, trackCount }) => ({
            id,
            name,
            date,
            trackCount,
          })),
          library: editionOf(editions, libraryRelease(group))?.id ?? null,
        },
        200,
      );
    } catch (error) {
      const failure = asAppError(error);
      if (isMetadataNotFoundError(error)) {
        return c.json({ error: "Release not found", message: failure?.message }, 404);
      }
      logger.info("releaseGroup", "Album editions unavailable", {
        mbid,
        message: failure?.message,
      });
      return metadataUnavailable(c, error);
    }
  })
  .get("/release-group/:mbid/tracks", noCache, validate("query", editionQuery), async (c) => {
    const mbid = c.req.param("mbid");
    if (!UUID_REGEX.test(mbid)) return c.json({ error: "Invalid MBID format" }, 400);
    const { release } = c.req.valid("query");
    try {
      const [album, tracks] = await Promise.all([
        getAlbumByMbid(mbid, { withFallbackReleases: true }).catch(() => null),
        getAlbumTracksByAlbumMbid(mbid, {
          chooseRelease: (group) => chooseAlbumEdition(group, release),
        }),
      ]);
      const albumArtist = album?.artists[0]?.name?.trim() || "";
      return c.json(
        tracks.map((track) => {
          const previewArtist = track.credits?.[0]?.name?.trim() || albumArtist;
          return {
            id: track.recordingId || track.id,
            mbid: track.recordingId || track.id,
            title: track.title,
            trackName: track.title,
            trackNumber: track.trackPosition || track.trackNumber || 0,
            discNumber: track.mediumNumber || 1,
            discTitle: track.discTitle,
            position: track.trackPosition || track.trackNumber || 0,
            releaseMbid: track.releaseMbid || null,
            length: track.durationMs || null,
            popular: track.popular ?? false,
            preview_url:
              previewArtist && track.title
                ? deezerPreviewSearchPath(previewArtist, track.title)
                : null,
            ...(track.credits && { credits: track.credits }),
          };
        }),
        200,
      );
    } catch (error) {
      const failure = asAppError(error);
      logger.error("releaseGroup", "Error fetching release group tracks:", {
        message: failure?.message,
      });
      return c.json({ error: "Failed to fetch tracks", message: failure?.message }, 500);
    }
  })
  .get("/release-group/:mbid/previews", noCache, validate("query", previewsQuery), async (c) => {
    const mbid = c.req.param("mbid");
    if (!UUID_REGEX.test(mbid)) return c.json({ error: "Invalid MBID format" }, 400);
    const query = c.req.valid("query");
    const previews: Record<
      string,
      { preview_url: string; previewProvider?: string; previewTrackId?: string }
    > = {};
    try {
      const [album, tracks] = await Promise.all([
        getAlbumByMbid(mbid),
        getAlbumTracksByAlbumMbid(mbid, {
          chooseRelease: (group) => chooseAlbumEdition(group, query.release),
        }),
      ]);
      const artistMbid = UUID_REGEX.test(query.artistMbid)
        ? query.artistMbid
        : album.artists[0]?.id || "";
      const override = artistMbid ? dbOps.getArtistOverride(artistMbid) : null;
      const metadataArtist =
        artistMbid && !override?.deezerArtistId
          ? await getArtistByMbid(override?.musicbrainzId || artistMbid).catch(() => null)
          : null;
      const deezerArtistId =
        override?.deezerArtistId || getLinkedDeezerArtistId(metadataArtist?.links) || "";
      const artistName = metadataArtist?.name || album.artists[0]?.name || "";
      const previewed = await enrichTracksWithDeezerPreviews(tracks, {
        artistName,
        deezerArtistId,
        deezerAlbumId: query.deezerAlbumId,
        albumTitle: album.title,
        releaseType: album.type,
        releaseDate: album.releaseDate || "",
        cacheKey: `release-group:${mbid}:${query.release ? `${query.release}:` : ""}${query.deezerAlbumId || deezerArtistId || artistName}`,
      });
      for (const track of previewed) {
        if (!track.preview_url) continue;
        previews[track.recordingId || track.id] = {
          preview_url: track.preview_url,
          previewProvider: track.previewProvider,
          previewTrackId: track.previewTrackId,
        };
      }
    } catch (error) {
      logger.info("releaseGroup", "Release previews unavailable", {
        mbid,
        message: asAppError(error)?.message,
      });
    }
    return c.json({ previews }, 200);
  });

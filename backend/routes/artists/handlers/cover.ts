import { Hono } from "hono";
import * as v from "valibot";
import { UUID_REGEX } from "../../../../lib/uuid.ts";
import { logger } from "../../../services/logger.ts";
import { dbOps } from "../../../db/helpers/index.ts";
import { getArtistImage } from "../../../services/imageService.ts";
import { getLibraryArtistArtworkByMbid } from "../../../services/libraryArtwork.ts";
import { sendFile } from "../../../services/fileResponses.ts";
import { requireStreamAuth } from "../../../middleware/guards.ts";
import type { AppEnv } from "../../../middleware/requestUser.ts";
import { validate } from "../../../middleware/validate.ts";
import { asAppError } from "../../../../lib/errors.ts";
import { sendViaNode } from "../../shared/sendViaNode.ts";
import { queryText } from "../utils.ts";

const NEGATIVE_COVER_CACHE_MS = 7 * 24 * 60 * 60 * 1000;
const FANART_IMAGE = /^(https?:\/\/assets\.fanart\.tv)\/fanart\//i;

const resolveArtistImage = async (mbid: string, artistName: string | null, refresh = false) => {
  const cached = dbOps.getImage(mbid);
  const notFound = cached?.imageUrl === "NOT_FOUND";
  if (
    !refresh &&
    notFound &&
    cached.cacheAge &&
    Date.now() - cached.cacheAge < NEGATIVE_COVER_CACHE_MS
  ) {
    return { url: null, images: [], notFound: true };
  }
  return getArtistImage(mbid, { forceRefresh: refresh || notFound, artistName });
};

const sizedImageUrl = (url: string, width: number) => {
  if (!width || !FANART_IMAGE.test(url)) return url;
  const size = width <= 200 ? "preview" : width <= 400 ? "bigpreview" : "fanart";
  return url.replace(FANART_IMAGE, `$1/${size}/`);
};

const coverQuery = v.object({ refresh: v.optional(v.string()), artistName: queryText });
const imageQuery = v.object({ w: queryText });

export default new Hono<AppEnv>()
  .basePath("/artists")
  .get("/:mbid/cover", validate("query", coverQuery), async (c) => {
    const mbid = c.req.param("mbid");
    const query = c.req.valid("query");
    if (!UUID_REGEX.test(mbid)) {
      return c.json({ error: "Invalid MBID format", images: [] }, 400);
    }

    try {
      const result = await resolveArtistImage(
        mbid,
        query.artistName || null,
        Boolean(query.refresh),
      );
      const images = result.images || [];
      if (images.length > 0) {
        c.header("Cache-Control", "public, max-age=31536000, immutable");
      } else if (result.notFound) {
        c.header("Cache-Control", "public, max-age=3600");
      } else {
        logger.info("api", "Cover lookup failed transiently, skipping NOT_FOUND cache", { mbid });
        c.header("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
      }
      return c.json({ images }, 200);
    } catch (error) {
      const failure = asAppError(error);
      logger.error("api", "Error in cover route", { mbid, error: failure?.message });
      c.header("Cache-Control", "public, max-age=60");
      return c.json({ images: [] }, 200);
    }
  })
  .get("/:mbid/image", requireStreamAuth, validate("query", imageQuery), async (c) => {
    const mbid = c.req.param("mbid");
    if (!UUID_REGEX.test(mbid)) return c.json({ error: "Invalid MBID format" }, 400);
    const imageNotFound = () => c.json({ error: "Image not found" }, 404);

    const library = await getLibraryArtistArtworkByMbid(mbid).catch(() => null);
    if (library) {
      c.header("Cache-Control", "private, max-age=3600, stale-while-revalidate=604800");
      const sent = await sendViaNode(c, sendFile, library.filePath, {
        contentType: library.contentType,
        dotfiles: "deny",
      });
      return sent || imageNotFound();
    }

    const { w } = c.req.valid("query");
    const result = await resolveArtistImage(mbid, null).catch(() => null);
    if (!result?.url) {
      c.header("Cache-Control", result?.notFound ? "private, max-age=3600" : "no-store");
      return imageNotFound();
    }
    c.header("Cache-Control", "private, max-age=86400");
    return c.redirect(sizedImageUrl(result.url, Number(w) || 0), 302);
  });

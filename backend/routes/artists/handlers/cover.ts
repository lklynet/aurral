import { Hono } from "hono";
import * as v from "valibot";
import { UUID_REGEX } from "../../../../lib/uuid.ts";
import { logger } from "../../../services/logger.ts";
import { dbOps } from "../../../db/helpers/index.ts";
import { getArtistImage } from "../../../services/imageService.ts";
import type { AppEnv } from "../../../middleware/requestUser.ts";
import { validate } from "../../../middleware/validate.ts";
import { asAppError } from "../../../../lib/errors.ts";
import { queryText } from "../utils.ts";

const NEGATIVE_COVER_CACHE_MS = 7 * 24 * 60 * 60 * 1000;

export const getCachedCoverCacheControl = (
  images: Awaited<ReturnType<typeof getArtistImage>>["images"],
) => (images.length > 0 ? "public, max-age=31536000, immutable" : "no-store");

const coverQuery = v.object({ refresh: v.optional(v.string()), artistName: queryText });

export default new Hono<AppEnv>()
  .basePath("/artists")
  .get("/:mbid/cover", validate("query", coverQuery), async (c) => {
    const mbid = c.req.param("mbid");
    const query = c.req.valid("query");
    const refresh = Boolean(query.refresh);
    const artistName = query.artistName || null;

    try {
      if (!UUID_REGEX.test(mbid)) {
        return c.json({ error: "Invalid MBID format", images: [] }, 400);
      }

      const cachedImage = dbOps.getImage(mbid);
      if (!refresh && cachedImage && cachedImage.imageUrl && cachedImage.imageUrl !== "NOT_FOUND") {
        logger.info("api", "Cover cache hit", { mbid });
        const cachedResult = await getArtistImage(mbid, { artistName }).catch(() => null);
        const images = cachedResult?.images || [];
        c.header("Cache-Control", getCachedCoverCacheControl(images));
        return c.json({ images }, 200);
      }

      const negativeCacheIsFresh =
        cachedImage?.imageUrl === "NOT_FOUND" &&
        cachedImage.cacheAge &&
        Date.now() - cachedImage.cacheAge < NEGATIVE_COVER_CACHE_MS;
      if (!refresh && negativeCacheIsFresh) {
        logger.info("api", "NOT_FOUND cache", { mbid });
        c.header("Cache-Control", "public, max-age=3600");
        return c.json({ images: [] }, 200);
      }

      logger.info("api", "Fetching cover", { mbid });

      const result = await getArtistImage(mbid, {
        forceRefresh: refresh || cachedImage?.imageUrl === "NOT_FOUND",
        artistName,
      });
      const images = result.images || [];

      if (images.length > 0) {
        logger.info("api", "Successfully returning cover", { mbid });
        c.header("Cache-Control", "public, max-age=31536000, immutable");
      } else if (result.notFound) {
        logger.info("api", "No cover found", { mbid });
        c.header("Cache-Control", "public, max-age=3600");
      } else {
        logger.warn("api", "Cover lookup failed transiently, skipping NOT_FOUND cache", { mbid });
        c.header("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
      }

      return c.json({ images }, 200);
    } catch (error) {
      const failure = asAppError(error);
      logger.error("api", "Error in cover route", { mbid, error: failure?.message });
      c.header("Cache-Control", "public, max-age=60");
      return c.json({ images: [] }, 200);
    }
  });

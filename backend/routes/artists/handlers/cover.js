import { UUID_REGEX } from "../../../../lib/uuid.js";
import { logger } from "../../../services/logger.js";
import { dbOps } from "../../../db/helpers/index.js";
import { pendingCoverRequests } from "../utils.js";
import { getArtistImage } from "../../../services/imageService.js";

const NEGATIVE_COVER_CACHE_MS = 7 * 24 * 60 * 60 * 1000;

export const getCachedCoverCacheControl = (images) =>
  images.length > 0 ? "public, max-age=31536000, immutable" : "no-store";

export function registerCover(router) {
  router.get("/:mbid/cover", async (req, res) => {
    const { mbid } = req.params;
    const { refresh = false, artistName: queryArtistName } = req.query;
    const artistNameFromQuery =
      typeof queryArtistName === "string" && queryArtistName.trim() ? queryArtistName.trim() : null;

    try {
      if (!UUID_REGEX.test(mbid)) {
        return res.status(400).json({ error: "Invalid MBID format", images: [] });
      }

      if (pendingCoverRequests.has(mbid)) {
        logger.info("api", "Deduplicating cover request", { mbid });
        const result = await pendingCoverRequests.get(mbid);
        return res.json({ images: result.images || [] });
      }

      const cachedImage = dbOps.getImage(mbid);
      if (
        !refresh &&
        cachedImage &&
        cachedImage.imageUrl &&
        cachedImage.imageUrl !== "NOT_FOUND"
      ) {
        logger.info("api", "Cover cache hit", { mbid });
        const cachedResult = await getArtistImage(mbid, {
          artistName: artistNameFromQuery,
        }).catch(() => null);
        const images = cachedResult?.images || [];
        res.set("Cache-Control", getCachedCoverCacheControl(images));

        return res.json({ images });
      }

      const negativeCacheIsFresh =
        cachedImage?.imageUrl === "NOT_FOUND" &&
        cachedImage.cacheAge &&
        Date.now() - cachedImage.cacheAge < NEGATIVE_COVER_CACHE_MS;
      if (!refresh && negativeCacheIsFresh) {
        logger.info("api", "NOT_FOUND cache", { mbid });
        res.set("Cache-Control", "public, max-age=3600");
        return res.json({ images: [] });
      }

      logger.info("api", "Fetching cover", { mbid });

      const shouldForceRefresh =
        !!refresh || cachedImage?.imageUrl === "NOT_FOUND";

      const fetchPromise = (async () => {
        try {
          const result = await getArtistImage(mbid, {
            forceRefresh: shouldForceRefresh,
            artistName: artistNameFromQuery,
          });
          return {
            images: result.images || [],
            notFound: !!result.notFound,
            transientError: !!result.transientError,
          };
        } catch (error) {
          logger.error("api", "Error fetching cover", { mbid, error: error.message });
          return { images: [] };
        }
      })();

      pendingCoverRequests.set(mbid, fetchPromise);
      const result = await fetchPromise;

      if (result.images && result.images.length > 0) {
        logger.info("api", "Successfully returning cover", { mbid });
        res.set("Cache-Control", "public, max-age=31536000, immutable");
      } else {
        if (result.notFound) {
          logger.info("api", "No cover found, caching NOT_FOUND", { mbid });
          dbOps.setImage(mbid, "NOT_FOUND");
          res.set("Cache-Control", "public, max-age=3600");
        } else {
          logger.warn("api", "Cover lookup failed transiently, skipping NOT_FOUND cache", { mbid });
          res.set("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
        }
      }

      res.json({ images: result.images || [] });
    } catch (error) {
      logger.error("api", "Error in cover route", { mbid, error: error.message });
      res.set("Cache-Control", "public, max-age=60");
      res.json({ images: [] });
    } finally {
      if (mbid) {
        pendingCoverRequests.delete(mbid);
      }
    }
  });
}

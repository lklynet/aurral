import type { Router } from "express";
import { UUID_REGEX } from "../../../../lib/uuid.ts";
import { logger } from "../../../services/logger.ts";
import { dbOps } from "../../../db/helpers/index.ts";
import { getArtistImage } from "../../../services/imageService.ts";
import { asAppError } from "../../../../lib/errors.ts";

const NEGATIVE_COVER_CACHE_MS = 7 * 24 * 60 * 60 * 1000;

export type ArtistCoverImage = { image: string; front: boolean; types: string[] };

export type ArtistCoverResponse = { images: ArtistCoverImage[]; error?: string };

export const getCachedCoverCacheControl = (
  images: Awaited<ReturnType<typeof getArtistImage>>["images"],
) => (images.length > 0 ? "public, max-age=31536000, immutable" : "no-store");

export function registerCover(router: Router) {
  router.get("/:mbid/cover", async (req, res) => {
    const { mbid } = req.params;
    const { refresh = false, artistName: queryArtistName } = req.query;
    const artistNameFromQuery =
      typeof queryArtistName === "string" && queryArtistName.trim() ? queryArtistName.trim() : null;

    try {
      if (!UUID_REGEX.test(mbid)) {
        return res.status(400).json({ error: "Invalid MBID format", images: [] });
      }

      const cachedImage = dbOps.getImage(mbid);
      if (!refresh && cachedImage && cachedImage.imageUrl && cachedImage.imageUrl !== "NOT_FOUND") {
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

      const shouldForceRefresh = !!refresh || cachedImage?.imageUrl === "NOT_FOUND";

      const result = await getArtistImage(mbid, {
        forceRefresh: shouldForceRefresh,
        artistName: artistNameFromQuery,
      });
      const images = result.images || [];

      if (images.length > 0) {
        logger.info("api", "Successfully returning cover", { mbid });
        res.set("Cache-Control", "public, max-age=31536000, immutable");
      } else {
        if (result.notFound) {
          logger.info("api", "No cover found", { mbid });
          res.set("Cache-Control", "public, max-age=3600");
        } else {
          logger.warn("api", "Cover lookup failed transiently, skipping NOT_FOUND cache", { mbid });
          res.set("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
        }
      }

      res.json({ images });
    } catch (error) {
      const failure = asAppError(error);
      logger.error("api", "Error in cover route", { mbid, error: failure?.message });
      res.set("Cache-Control", "public, max-age=60");
      res.json({ images: [] });
    }
  });
}

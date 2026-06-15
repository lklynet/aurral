import { UUID_REGEX } from "../../../config/constants.js";
import { dbOps } from "../../../config/db-helpers.js";
import { pendingCoverRequests, fetchCoverInBackground } from "../utils.js";
import { getArtistImage } from "../../../services/imageService.js";
import { warmImageProxy } from "../../../services/imageProxyService.js";

export default function registerCover(router) {
  router.get("/:mbid/cover", async (req, res) => {
    const { mbid } = req.params;
    const { refresh = false, artistName: queryArtistName } = req.query;
    const artistNameFromQuery =
      typeof queryArtistName === "string" && queryArtistName.trim()
        ? queryArtistName.trim()
        : null;

    try {
      if (!UUID_REGEX.test(mbid)) {
        return res.status(400).json({ error: "Invalid MBID format", images: [] });
      }

      if (pendingCoverRequests.has(mbid)) {
        console.log(`[Cover Route] Deduplicating request for ${mbid}`);
        const result = await pendingCoverRequests.get(mbid);
        return res.json({ images: result.images || [] });
      }

      const override = dbOps.getArtistOverride(mbid);
      const resolvedMbid = override?.musicbrainzId || mbid;

      const cachedImage = dbOps.getImage(mbid);
      if (
        !refresh &&
        cachedImage &&
        cachedImage.imageUrl &&
        cachedImage.imageUrl !== "NOT_FOUND"
      ) {
        console.log(`[Cover Route] Cache hit for ${mbid}`);
        res.set("Cache-Control", "public, max-age=31536000, immutable");

        const cacheAge = cachedImage.cacheAge;
        const shouldRefresh =
          !cacheAge || Date.now() - cacheAge > 7 * 24 * 60 * 60 * 1000;

        if (shouldRefresh) {
          fetchCoverInBackground(mbid, artistNameFromQuery).catch(() => {});
        }
        warmImageProxy(cachedImage.imageUrl).catch(() => {
          dbOps.deleteImage(mbid);
          fetchCoverInBackground(mbid, artistNameFromQuery).catch(() => {});
        });

        const cachedResult = await getArtistImage(mbid, {
          artistName: artistNameFromQuery,
        }).catch(() => null);

        return res.json({
          images: cachedResult?.images?.length
            ? cachedResult.images
            : [
                {
                  image: cachedImage.imageUrl,
                  front: true,
                  types: ["Front"],
                },
              ],
        });
      }

      if (
        !refresh &&
        cachedImage &&
        cachedImage.imageUrl === "NOT_FOUND" &&
        !artistNameFromQuery
      ) {
        console.log(`[Cover Route] NOT_FOUND cache for ${mbid}`);
        res.set("Cache-Control", "public, max-age=3600");

        setTimeout(() => {
          fetchCoverInBackground(mbid, artistNameFromQuery).catch(() => {});
        }, 60000);

        return res.json({ images: [] });
      }

      console.log(`[Cover Route] Fetching cover for ${mbid}`);

      const shouldForceRefresh =
        !!refresh ||
        (cachedImage?.imageUrl === "NOT_FOUND" && !!artistNameFromQuery);

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
          console.error(`Error fetching cover for ${mbid}:`, error.message);
          return { images: [] };
        }
      })();

      pendingCoverRequests.set(mbid, fetchPromise);
      const result = await fetchPromise;

      if (result.images && result.images.length > 0) {
        console.log(`[Cover Route] Successfully returning cover for ${mbid}`);
        res.set("Cache-Control", "public, max-age=31536000, immutable");
      } else {
        if (result.notFound) {
          console.log(
            `[Cover Route] No cover found for ${mbid}, caching NOT_FOUND`
          );
          dbOps.setImage(mbid, "NOT_FOUND");
          res.set("Cache-Control", "public, max-age=3600");
        } else {
          console.log(
            `[Cover Route] Cover lookup for ${mbid} failed transiently; skipping NOT_FOUND cache`,
          );
          res.set("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
        }
      }

      res.json({ images: result.images || [] });
    } catch (error) {
      console.error(`Error in cover route for ${mbid}:`, error.message);
      res.set("Cache-Control", "public, max-age=60");
      res.json({ images: [] });
    } finally {
      if (mbid) {
        pendingCoverRequests.delete(mbid);
      }
    }
  });
}

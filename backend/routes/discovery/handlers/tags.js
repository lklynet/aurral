import { getLastfmApiKey, lastfmRequest } from "../../../services/apiClients/index.js";
import { getCanonicalArtistKeyProjection } from "../../../services/libraryQueryService.js";
import { getDiscoveryCache } from "../../../services/discovery/index.js";
import { buildImageProxyUrl } from "../../../services/imageProxyService.js";
import { extractLastfmImageUrl } from "../../artists/shared/transform.js";
import {
  DISCOVERY_PROVIDER_LISTENBRAINZ_FALLBACK,
  getFallbackTagNames,
  searchFallbackGenreArtists,
} from "../../../services/listenbrainzDiscoveryFallback.js";
import { logger } from "../../../services/logger.js";
import { buildArtistKeySet, pendingTagRequests, fetchLastfmTopTagNames } from "./utils.js";

export function registerTags(router) {
  router.get("/tags", async (req, res) => {
    try {
      const { q = "", limit = 10 } = req.query;
      const limitInt = Math.min(parseInt(limit) || 10, 20);
      const rawPrefix = String(q).trim();
      const prefix = rawPrefix.toLowerCase();
      let tagNames = [];
      if (getLastfmApiKey()) {
        tagNames = await fetchLastfmTopTagNames();
      }
      if (tagNames.length === 0) {
        const discoveryCache = getDiscoveryCache();
        const cached = [
          ...getFallbackTagNames(),
          ...(discoveryCache.topTags || []),
          ...(discoveryCache.topGenres || []),
        ]
          .map((t) => (t != null ? String(t).trim() : ""))
          .filter(Boolean);
        tagNames = [...new Set(cached)];
      }
      const seen = new Set();
      const filtered = tagNames.filter((name) => {
        const key = name.toLowerCase();
        if (seen.has(key)) return false;
        if (prefix && !key.includes(prefix)) return false;
        seen.add(key);
        return true;
      });
      if (
        prefix.length >= 2 &&
        !filtered.some((name) => name.toLowerCase() === prefix)
      ) {
        filtered.unshift(rawPrefix);
      }
      res.json({ tags: filtered.slice(0, limitInt) });
    } catch (error) {
      res.status(500).json({
        error: "Failed to fetch tag suggestions",
        message: error.message,
      });
    }
  });

  router.get("/by-tag", async (req, res) => {
    try {
      const { tag, limit = 24, offset = 0, includeLibrary, scope } = req.query;

      if (!tag) {
        return res.status(400).json({ error: "Tag parameter is required" });
      }

      const limitInt = Math.min(parseInt(limit) || 24, 50);
      const offsetInt = parseInt(offset) || 0;
      const page = Math.floor(offsetInt / limitInt) + 1;
      const includeLibraryFlag =
        includeLibrary === "true" || includeLibrary === "1";
      const scopeValue =
        scope === "all" || includeLibraryFlag ? "all" : "recommended";
      const cacheKey = `tag:${tag.toLowerCase()}:${limitInt}:${page}:${scopeValue}`;

      let recommendations = [];
      if (scopeValue === "all") {
        if (getLastfmApiKey()) {
          try {
            let data;
            if (pendingTagRequests.has(cacheKey)) {
              data = await pendingTagRequests.get(cacheKey);
            } else {
              const fetchPromise = lastfmRequest("tag.getTopArtists", {
                tag,
                limit: limitInt,
                page,
              });
              pendingTagRequests.set(cacheKey, fetchPromise);
              try {
                data = await fetchPromise;
              } finally {
                pendingTagRequests.delete(cacheKey);
              }
            }

            if (data?.topartists?.artist) {
              const artists = Array.isArray(data.topartists.artist)
                ? data.topartists.artist
                : [data.topartists.artist];

              recommendations = artists
                .map((artist) => {
                  const imageUrl = extractLastfmImageUrl(artist.image);

                  return {
                    id: artist.mbid,
                    name: artist.name,
                    sortName: artist.name,
                    type: "Artist",
                    tags: [tag],
                    image: buildImageProxyUrl(imageUrl) || imageUrl,
                  };
                })
                .filter((a) => a.id);
            }
          } catch (err) {
            logger.error("discovery", "Last.fm tag search failed", { error: err.message });
          }
        } else {
          const fallbackResult = await searchFallbackGenreArtists({
            tag,
            limit: limitInt,
            offset: offsetInt,
            existingArtistKeys: includeLibraryFlag
              ? new Set()
              : buildArtistKeySet(getCanonicalArtistKeyProjection()),
          });
          if (fallbackResult) {
            return res.json({
              recommendations: fallbackResult.artists,
              tag,
              total: fallbackResult.total,
              offset: offsetInt,
              provider: DISCOVERY_PROVIDER_LISTENBRAINZ_FALLBACK,
              fallbackLimited: true,
            });
          }

          const discoveryCache = getDiscoveryCache();
          const tagLower = String(tag).trim().toLowerCase();
          const pool = [
            ...(discoveryCache.recommendations || []),
            ...(discoveryCache.globalTop || []),
            ...(discoveryCache.fallbackGenres || []).flatMap((section) =>
              Array.isArray(section?.artists) ? section.artists : [],
            ),
          ];
          const seen = new Set();
          const matches = pool.filter((artist) => {
            const key = String(artist?.id || artist?.mbid || artist?.name || "")
              .trim()
              .toLowerCase();
            if (!key || seen.has(key)) return false;
            const artistTags = [
              ...(Array.isArray(artist?.tags) ? artist.tags : []),
              ...(Array.isArray(artist?.genres) ? artist.genres : []),
            ];
            const matched = artistTags.some(
              (entry) =>
                String(entry || "").trim().toLowerCase() === tagLower,
            );
            if (!matched) return false;
            seen.add(key);
            return true;
          });
          recommendations = matches.slice(offsetInt, offsetInt + limitInt);
          return res.json({
            recommendations,
            tag,
            total: matches.length,
            offset: offsetInt,
            provider: DISCOVERY_PROVIDER_LISTENBRAINZ_FALLBACK,
            fallbackLimited: true,
            message: "Tag search is limited without Last.fm",
          });
        }
      } else {
        const discoveryCache = getDiscoveryCache();
        const tagLower = String(tag).trim().toLowerCase();
        const matches = (discoveryCache.recommendations || []).filter(
          (artist) => {
            const tags = Array.isArray(artist.tags) ? artist.tags : [];
            return tags.some((t) => String(t).toLowerCase() === tagLower);
          },
        );
        recommendations = matches.slice(offsetInt, offsetInt + limitInt);
        return res.json({
          recommendations,
          tag,
          total: matches.length,
          offset: offsetInt,
        });
      }

      res.json({
        recommendations,
        tag,
        total: recommendations.length,
        offset: offsetInt,
      });
    } catch (error) {
      res.status(500).json({
        error: "Failed to search by tag",
        message: error.message,
      });
    }
  });

}

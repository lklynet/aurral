import type { Router } from "express";
import { dbOps } from "../../../db/helpers/index.ts";
import {
  getMusicDataSourceName,
  getPopularTags,
  getTagArtists,
} from "../../../services/musicDataSource/index.ts";
import { buildImageProxyUrl } from "../../../services/imageProxyService.ts";
import { getUserDiscoveryNamespace } from "../../../services/discovery/index.ts";
import type { DiscoveryRecommendation } from "../../../services/discovery/recommendationPipeline.ts";
import { getUserDiscovery } from "../../../services/discovery/userDiscovery.ts";
import { asAppError } from "../../../../lib/errors.ts";

const rankTagSuggestions = (names: unknown[], prefix: string) => {
  const seen = new Set();
  const groups: string[][] = [[], [], []];
  for (const rawName of names) {
    const name = String(rawName ?? "").trim();
    const key = name.toLowerCase();
    if (!name || seen.has(key) || (prefix && !key.includes(prefix))) continue;
    seen.add(key);
    groups[key === prefix ? 0 : key.startsWith(prefix) ? 1 : 2].push(name);
  }
  return groups.flat();
};

export type TagSuggestionsResponse = { tags: string[] };

export function registerTags(router: Router) {
  router.get("/tags", async (req, res) => {
    try {
      const { q = "", limit = 10 } = req.query;
      const limitInt = Math.min(parseInt(String(limit)) || 10, 20);
      const rawPrefix = String(q).trim();
      const prefix = rawPrefix.toLowerCase();
      const userGenres =
        req.user?.id != null
          ? dbOps.getDiscoveryCache(getUserDiscoveryNamespace(req.user.id)).topGenres || []
          : [];
      const suggestions = rankTagSuggestions([...userGenres, ...(await getPopularTags())], prefix);
      if (prefix.length >= 2 && suggestions[0]?.toLowerCase() !== prefix) {
        suggestions.unshift(rawPrefix);
      }
      res.json({ tags: suggestions.slice(0, limitInt) });
    } catch (error) {
      const failure = asAppError(error);
      res.status(500).json({
        error: "Failed to fetch tag suggestions",
        message: failure?.message,
      });
    }
  });

  router.get("/by-tag", async (req, res) => {
    try {
      const { tag, limit = 24, offset = 0, includeLibrary, scope } = req.query;

      if (!tag) {
        return res.status(400).json({ error: "Tag parameter is required" });
      }

      const limitInt = Math.min(parseInt(String(limit)) || 24, 50);
      const offsetInt = parseInt(String(offset)) || 0;
      const includeLibraryFlag = includeLibrary === "true" || includeLibrary === "1";
      const scopeValue = scope === "all" || includeLibraryFlag ? "all" : "recommended";

      if (scopeValue === "all") {
        const { artists, hasMore } = await getTagArtists(tag, {
          limit: limitInt,
          offset: offsetInt,
        });
        return res.json({
          recommendations: artists
            .filter((artist) => artist.mbid)
            .map((artist) => ({
              id: artist.mbid,
              name: artist.name,
              sortName: artist.name,
              type: "Artist",
              tags: [tag],
              image: buildImageProxyUrl(artist.image),
            })),
          tag,
          total: offsetInt + artists.length + (hasMore ? 1 : 0),
          offset: offsetInt,
          provider: getMusicDataSourceName(),
        });
      }

      const { body: discovery } = getUserDiscovery(req.user?.id ?? null, 0);
      const tagLower = String(tag).trim().toLowerCase();
      const matches = discovery.recommendations.filter((artist: DiscoveryRecommendation) => {
        const tags = Array.isArray(artist.tags) ? artist.tags : [];
        return tags.some((t) => String(t).toLowerCase() === tagLower);
      });
      res.json({
        recommendations: matches.slice(offsetInt, offsetInt + limitInt),
        tag,
        total: matches.length,
        offset: offsetInt,
      });
    } catch (error) {
      const failure = asAppError(error);
      res.status(500).json({
        error: "Failed to search by tag",
        message: failure?.message,
      });
    }
  });
}

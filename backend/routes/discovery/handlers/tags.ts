import { Hono } from "hono";
import * as v from "valibot";
import type { AppEnv } from "../../../middleware/requestUser.ts";
import { validate } from "../../../middleware/validate.ts";
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

const tagsQuery = v.object({ q: v.optional(v.string()), limit: v.optional(v.string()) });

const byTagQuery = v.object({
  tag: v.optional(v.union([v.string(), v.array(v.string())])),
  limit: v.optional(v.string()),
  offset: v.optional(v.string()),
  includeLibrary: v.optional(v.string()),
  scope: v.optional(v.string()),
});

export default new Hono<AppEnv>()
  .get("/tags", validate("query", tagsQuery), async (c) => {
    try {
      const { q = "", limit = "10" } = c.req.valid("query");
      const limitInt = Math.min(parseInt(limit) || 10, 20);
      const rawPrefix = q.trim();
      const prefix = rawPrefix.toLowerCase();
      const userId = c.var.user?.id;
      const userGenres =
        userId != null
          ? dbOps.getDiscoveryCache(getUserDiscoveryNamespace(userId)).topGenres || []
          : [];
      const suggestions = rankTagSuggestions([...userGenres, ...(await getPopularTags())], prefix);
      if (prefix.length >= 2 && suggestions[0]?.toLowerCase() !== prefix) {
        suggestions.unshift(rawPrefix);
      }
      return c.json({ tags: suggestions.slice(0, limitInt) }, 200);
    } catch (error) {
      return c.json(
        { error: "Failed to fetch tag suggestions", message: asAppError(error)?.message },
        500,
      );
    }
  })
  .get("/by-tag", validate("query", byTagQuery), async (c) => {
    try {
      const { tag, limit = "24", offset = "0", includeLibrary, scope } = c.req.valid("query");

      if (typeof tag !== "string" || !tag) {
        return c.json({ error: "Tag parameter is required" }, 400);
      }

      const limitInt = Math.min(parseInt(limit) || 24, 50);
      const offsetInt = parseInt(offset) || 0;
      const includeLibraryFlag = includeLibrary === "true" || includeLibrary === "1";

      if (scope === "all" || includeLibraryFlag) {
        const { artists, hasMore } = await getTagArtists(tag, {
          limit: limitInt,
          offset: offsetInt,
        });
        return c.json(
          {
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
          },
          200,
        );
      }

      const { body: discovery } = getUserDiscovery(c.var.user?.id ?? null, 0);
      const tagLower = tag.trim().toLowerCase();
      const matches = discovery.recommendations.filter((artist: DiscoveryRecommendation) => {
        const tags = Array.isArray(artist.tags) ? artist.tags : [];
        return tags.some((t) => String(t).toLowerCase() === tagLower);
      });
      return c.json(
        {
          recommendations: matches.slice(offsetInt, offsetInt + limitInt),
          tag,
          total: matches.length,
          offset: offsetInt,
        },
        200,
      );
    } catch (error) {
      return c.json({ error: "Failed to search by tag", message: asAppError(error)?.message }, 500);
    }
  });

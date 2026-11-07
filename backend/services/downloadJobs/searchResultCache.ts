import createCache from "../apiClients/simpleCache.ts";

// Tracks from one album search for the same "Artist Album" query, so one
// provider search answers all of them for a while.
const SEARCH_RESULT_TTL_SECONDS = 15 * 60;

const cacheKey = (query: string | undefined) =>
  String(query || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");

export function createSearchResultCache<Item>() {
  const results = createCache<Item[]>(SEARCH_RESULT_TTL_SECONDS, 200);
  return {
    get: (query: string | undefined) => results.get(cacheKey(query)),
    set: (query: string | undefined, items: Item[]) => results.set(cacheKey(query), items),
  };
}

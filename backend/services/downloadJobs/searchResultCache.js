import createCache from "../apiClients/simpleCache.js";

// Tracks from one album search for the same "Artist Album" query, so one
// provider search answers all of them for a while.
const SEARCH_RESULT_TTL_SECONDS = 15 * 60;
const results = createCache(SEARCH_RESULT_TTL_SECONDS, 200);

function cacheKey(source, query) {
  return `${source}\0${String(query || "").trim().toLowerCase().replace(/\s+/g, " ")}`;
}

export function getCachedSearchResults(source, query) {
  return results.get(cacheKey(source, query));
}

export function cacheSearchResults(source, query, items) {
  results.set(cacheKey(source, query), Array.isArray(items) ? items : []);
}

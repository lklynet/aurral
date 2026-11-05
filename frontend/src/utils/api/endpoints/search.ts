import { queryOptions } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { apiFetchWithin } from "../core.ts";
import { searchClient } from "../clients/search.ts";
import { queryClient, queryKeys } from "../../../queryClient.ts";

const searchFetch = apiFetchWithin(12_000);

export const unifiedSearchQuery = (query: string, limit: number) =>
  queryOptions({
    queryKey: queryKeys.searchUnified(query, limit),
    queryFn: ({ signal }) =>
      parseResponse(
        searchClient.unified.$get(
          { query: { q: query, limit: String(limit) } },
          { fetch: searchFetch, init: { signal } },
        ),
      ),
    staleTime: 30_000,
  });

export const librarySearchQuery = (query: string, limit: number) =>
  queryOptions({
    queryKey: queryKeys.searchLibrary(query, limit),
    queryFn: ({ signal }) =>
      parseResponse(
        searchClient.library.$get(
          { query: { q: query, limit: String(limit) } },
          { init: { signal } },
        ),
      ),
    staleTime: 15_000,
  });

export const playlistSearchQuery = (query: string) =>
  queryOptions({
    queryKey: queryKeys.searchPlaylists(query),
    queryFn: ({ signal }) =>
      parseResponse(
        searchClient.playlists.$get(
          { query: { q: query } },
          { fetch: searchFetch, init: { signal } },
        ),
      ),
    staleTime: 5 * 60_000,
    retry: false,
  });

export const searchUnified = (query: string, { limit = 5 }: { limit?: number } = {}) =>
  queryClient.fetchQuery(unifiedSearchQuery(query, limit));

export const searchLibrary = (query: string, { limit = 5 }: { limit?: number } = {}) =>
  queryClient.fetchQuery(librarySearchQuery(query, limit));

export const searchCatalog = async (
  query: string,
  scope = "artist",
  {
    limit = 24,
    offset = 0,
    releaseTypes = [],
    sort,
    signal,
  }: {
    limit?: number;
    offset?: number;
    releaseTypes?: string[];
    sort?: string;
    signal?: AbortSignal;
  } = {},
) => {
  const albumScope = scope === "album";
  const fetchCatalog = (requestSignal: AbortSignal | undefined) =>
    parseResponse(
      searchClient.$get(
        {
          query: {
            q: query,
            scope,
            limit: String(limit),
            offset: String(offset),
            releaseTypes: albumScope && releaseTypes.length ? releaseTypes.join(",") : undefined,
            sort: albumScope ? sort || undefined : undefined,
          },
        },
        { init: { signal: requestSignal } },
      ),
    );
  if (signal) return fetchCatalog(signal);
  return queryClient.fetchQuery({
    queryKey: queryKeys.searchCatalog(query, scope, { limit, offset, releaseTypes, sort }),
    queryFn: ({ signal: querySignal }) => fetchCatalog(querySignal),
    staleTime: 30_000,
  });
};

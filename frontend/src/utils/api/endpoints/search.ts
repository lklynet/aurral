import { queryOptions } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { apiFetchWithin, resolveAuthenticatedApiAssetUrl } from "../core.ts";
import { searchClient } from "../clients/search.ts";
import { queryClient, queryKeys } from "../../../queryClient.ts";

const searchFetch = apiFetchWithin(12_000);

const withAlbumCover = <T extends { type: string; coverUrl?: string | null }>(item: T): T =>
  item.type === "album" && item.coverUrl
    ? { ...item, coverUrl: resolveAuthenticatedApiAssetUrl(item.coverUrl) }
    : item;

export const unifiedSearchQuery = (query: string, limit: number) =>
  queryOptions({
    queryKey: queryKeys.searchUnified(query, limit),
    queryFn: async ({ signal }) => {
      const result = await parseResponse(
        searchClient.unified.$get(
          { query: { q: query, limit: String(limit) } },
          { fetch: searchFetch, init: { signal } },
        ),
      );
      return {
        ...result,
        top: result.top && withAlbumCover(result.top),
        albums: result.albums.map(withAlbumCover),
      };
    },
    staleTime: 30_000,
  });

export const librarySearchQuery = (query: string, limit: number) =>
  queryOptions({
    queryKey: queryKeys.searchLibrary(query, limit),
    queryFn: async ({ signal }) => {
      const result = await parseResponse(
        searchClient.library.$get(
          { query: { q: query, limit: String(limit) } },
          { init: { signal } },
        ),
      );
      const withCover = <T extends { coverUrl?: string | null }>(item: T) =>
        item.coverUrl
          ? { ...item, coverUrl: resolveAuthenticatedApiAssetUrl(item.coverUrl) }
          : item;
      return {
        ...result,
        artists: result.artists.map((artist) =>
          artist.image
            ? { ...artist, image: resolveAuthenticatedApiAssetUrl(artist.image) }
            : artist,
        ),
        albums: result.albums.map(withCover),
        tracks: result.tracks.map(withCover),
      };
    },
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
  const fetchCatalog = async (requestSignal: AbortSignal | undefined) => {
    const result = await parseResponse(
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
    return albumScope ? { ...result, items: result.items.map(withAlbumCover) } : result;
  };
  if (signal) return fetchCatalog(signal);
  return queryClient.fetchQuery({
    queryKey: queryKeys.searchCatalog(query, scope, { limit, offset, releaseTypes, sort }),
    queryFn: ({ signal: querySignal }) => fetchCatalog(querySignal),
    staleTime: 30_000,
  });
};

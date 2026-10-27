import { parseResponse } from "hono/client";
import { apiFetch, apiFetchWithin } from "../core.ts";
import { searchClient } from "../clients/search.ts";
import { queryClient, queryKeys } from "../../../queryClient.ts";

const suggestFetch = apiFetchWithin(12_000);

const fetchUnified = (
  query: string,
  mode: "suggest" | "full",
  limit: number | undefined,
  signal: AbortSignal | undefined,
) =>
  parseResponse(
    searchClient.unified.$get(
      { query: { q: query, mode, limit: limit == null ? undefined : String(limit) } },
      { fetch: mode === "full" ? apiFetch : suggestFetch, init: { signal } },
    ),
  );

export const searchUnified = async (
  query: string,
  {
    mode = "suggest",
    limit,
    signal,
  }: { mode?: "suggest" | "full"; limit?: number; signal?: AbortSignal } = {},
) => {
  if (signal) return fetchUnified(query, mode, limit, signal);
  return queryClient.fetchQuery({
    queryKey: queryKeys.searchUnified(query, mode, limit),
    queryFn: ({ signal: querySignal }) => fetchUnified(query, mode, limit, querySignal),
    staleTime: mode === "full" ? 30_000 : 5_000,
  });
};

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

export const searchLibrary = (
  query: string,
  { limit, signal }: { limit?: number; signal?: AbortSignal } = {},
) =>
  parseResponse(
    searchClient.library.$get(
      { query: { q: query, limit: limit == null ? undefined : String(limit) } },
      { init: { signal } },
    ),
  );

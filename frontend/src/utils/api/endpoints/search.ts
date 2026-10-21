import { getData } from "../core.ts";
import { queryClient, queryKeys } from "../../../queryClient.ts";
import type {
  searchUnified as searchUnifiedRoute,
  searchLibrary as searchLibraryRoute,
} from "../../../../../backend/services/unifiedSearchService.ts";
import type {
  searchAlbums,
  searchArtists,
  searchTags,
} from "../../../../../backend/services/searchService.ts";

type UnifiedSearchResponse = Awaited<ReturnType<typeof searchUnifiedRoute>>;
type LibrarySearchResponse = ReturnType<typeof searchLibraryRoute>;
type CatalogSearchResponse =
  | Awaited<ReturnType<typeof searchArtists>>
  | Awaited<ReturnType<typeof searchAlbums>>
  | Awaited<ReturnType<typeof searchTags>>;

export const searchUnified = async (
  query: string,
  {
    mode = "suggest",
    limit,
    signal,
  }: { mode?: "suggest" | "full"; limit?: number; signal?: AbortSignal } = {},
): Promise<UnifiedSearchResponse> => {
  const params: Record<string, string | number> = { q: query, mode };
  if (limit != null) {
    params.limit = limit;
  }
  const timeoutMs = mode === "full" ? 30000 : 12000;
  if (signal) {
    return getData<UnifiedSearchResponse>("/search/unified", {
      params,
      timeout: timeoutMs,
      signal,
    });
  }
  return queryClient.fetchQuery({
    queryKey: queryKeys.searchUnified(query, mode, limit),
    queryFn: ({ signal: querySignal }) =>
      getData<UnifiedSearchResponse>("/search/unified", {
        params,
        timeout: timeoutMs,
        signal: querySignal,
      }),
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
): Promise<CatalogSearchResponse> => {
  const params: Record<string, string | number> = { q: query, scope, limit, offset };
  if (scope === "album") {
    if (Array.isArray(releaseTypes) && releaseTypes.length) {
      params.releaseTypes = releaseTypes.join(",");
    }
    if (sort) {
      params.sort = sort;
    }
  }
  const queryOptions = { limit, offset, releaseTypes, sort };
  if (signal) {
    return getData<CatalogSearchResponse>("/search", { params, signal });
  }
  return queryClient.fetchQuery({
    queryKey: queryKeys.searchCatalog(query, scope, queryOptions),
    queryFn: ({ signal: querySignal }) =>
      getData<CatalogSearchResponse>("/search", { params, signal: querySignal }),
    staleTime: 30_000,
  });
};

export const searchLibrary = async (
  query: string,
  { limit, signal }: { limit?: number; signal?: AbortSignal } = {},
): Promise<LibrarySearchResponse> => {
  const params: Record<string, string | number> = { q: query };
  if (limit != null) {
    params.limit = limit;
  }
  return getData<LibrarySearchResponse>("/search/library", { params, signal });
};

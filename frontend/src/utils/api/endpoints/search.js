import { getData } from "../core.js";
import { queryClient, queryKeys } from "../../../queryClient.js";

export const searchUnified = async (
  query,
  { mode = "suggest", limit } = {},
) => {
  const params = { q: query, mode };
  if (limit != null) {
    params.limit = limit;
  }
  const timeoutMs = mode === "full" ? 30000 : 12000;
  return queryClient.fetchQuery({
    queryKey: queryKeys.searchUnified(query, mode, limit),
    queryFn: ({ signal: querySignal }) =>
      getData("/search/unified", {
        params,
        timeout: timeoutMs,
        signal: querySignal,
      }),
    staleTime: mode === "full" ? 30_000 : 5_000,
  });
};

export const searchCatalog = async (
  query,
  scope = "artist",
  {
    limit = 24,
    offset = 0,
    releaseTypes = [],
    sort,
  } = {},
) => {
  const params = { q: query, scope, limit, offset };
  if (scope === "album") {
    if (Array.isArray(releaseTypes) && releaseTypes.length) {
      params.releaseTypes = releaseTypes.join(",");
    }
    if (sort) {
      params.sort = sort;
    }
  }
  const queryOptions = { limit, offset, releaseTypes, sort };
  return queryClient.fetchQuery({
    queryKey: queryKeys.searchCatalog(query, scope, queryOptions),
    queryFn: ({ signal: querySignal }) =>
      getData("/search", { params, signal: querySignal }),
    staleTime: 30_000,
  });
};

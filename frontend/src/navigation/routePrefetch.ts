import { matchPath, type Params } from "react-router";
import type { FetchQueryOptions, QueryKey } from "@tanstack/react-query";
import { queryClient } from "../queryClient.ts";
import {
  discoveryQueryOptions,
  editorialPlaylistQueryOptions,
  editorialShelfQueryOptions,
  playlistJobsQueryOptions,
  playlistStatusQueryOptions,
  releaseGroupDetailsQueryOptions,
  trendingChartsQueryOptions,
  trendingGenreQueryOptions,
} from "../queryOptions.ts";
import { canPrefetchInBackground } from "../utils/requestScheduling.ts";
import { resolveLinkQueryOptions } from "./resolveLinks.ts";
import { routeModules } from "./routeModules.ts";

const FAILURE_COOLDOWN_MS = 30_000;

type RouteContext = { userId: number | null; search: URLSearchParams };

const prefetchable = <TData, TKey extends QueryKey>(
  options: FetchQueryOptions<TData, Error, TData, TKey> & { enabled?: unknown },
) => ({
  queryKey: options.queryKey,
  enabled: options.enabled,
  prefetch: () => queryClient.prefetchQuery(options),
});

const libraryView = async (
  view: { albumId?: string; artistId?: string; section?: string },
  search: URLSearchParams,
) => {
  if (search.get("preview") === "1") return [];
  const { libraryListParams, libraryViewQueryOptions, resolveLibrarySection } =
    await import("../pages/libraryViewQuery.ts");
  const { albumId, artistId } = view;
  if (albumId || artistId) return [prefetchable(libraryViewQueryOptions({ albumId, artistId }))];
  const section = resolveLibrarySection(view.section);
  const { sort, direction, pageIndex } = libraryListParams(section, search);
  return [
    prefetchable(
      libraryViewQueryOptions({
        section,
        pageIndex,
        sort,
        direction,
        query: (search.get("q") || "").trim().toLocaleLowerCase(),
        genre: search.get("genre") || "",
      }),
    ),
  ];
};

const ROUTES = [
  { path: "/", module: routeModules.discover },
  {
    path: "/discover/playlists/deezer/:playlistId",
    module: routeModules.editorialPlaylist,
    queries: ({ playlistId }: Params<string>, { userId }: RouteContext) => [
      prefetchable(editorialPlaylistQueryOptions(userId, playlistId!)),
    ],
  },
  {
    path: "/discover/playlists",
    module: routeModules.discoverPlaylists,
    queries: (_params: Params<string>, { userId }: RouteContext) => [
      prefetchable(editorialShelfQueryOptions(userId)),
    ],
  },
  { path: "/discover/news", module: routeModules.news },
  {
    path: "/discover/recommended/:view?",
    module: routeModules.recommended,
    queries: (_params: Params<string>, { userId }: RouteContext) => [
      prefetchable(discoveryQueryOptions(userId)),
    ],
  },
  {
    path: "/discover/trending/genres/:genreId",
    module: routeModules.trendingGenre,
    queries: ({ genreId }: Params<string>) => [prefetchable(trendingGenreQueryOptions(genreId!))],
  },
  {
    path: "/discover/trending",
    module: routeModules.trending,
    queries: (_params: Params<string>, { userId }: RouteContext) => [
      prefetchable(trendingChartsQueryOptions(userId)),
    ],
  },
  {
    path: "/library/playlists/:playlistId",
    module: routeModules.playlist,
    queries: ({ playlistId }: Params<string>) => [
      prefetchable(playlistStatusQueryOptions()),
      prefetchable(playlistJobsQueryOptions(playlistId)),
    ],
  },
  {
    path: "/library/playlists",
    module: routeModules.playlists,
    queries: () => [prefetchable(playlistStatusQueryOptions())],
  },
  {
    path: "/library/album/:albumId",
    module: routeModules.library,
    queries: ({ albumId }: Params<string>, { search }: RouteContext) =>
      libraryView({ albumId }, search),
  },
  {
    path: "/library/artist/:artistId",
    module: routeModules.library,
    queries: ({ artistId }: Params<string>, { search }: RouteContext) =>
      libraryView({ artistId }, search),
  },
  {
    path: "/library/:section?",
    module: routeModules.library,
    queries: ({ section }: Params<string>, { search }: RouteContext) =>
      libraryView({ section }, search),
  },
  {
    path: "/flows/:flowId",
    module: routeModules.flow,
    queries: ({ flowId }: Params<string>) => [
      prefetchable(playlistStatusQueryOptions()),
      prefetchable(playlistJobsQueryOptions(flowId)),
    ],
  },
  {
    path: "/flows",
    module: routeModules.flows,
    queries: () => [prefetchable(playlistStatusQueryOptions())],
  },
  {
    path: "/artist/:mbid/release/:releaseMbid",
    module: routeModules.release,
    queries: ({ releaseMbid }: Params<string>) => [
      prefetchable(releaseGroupDetailsQueryOptions(releaseMbid)),
    ],
  },
  { path: "/artist/:mbid/albums", module: routeModules.artistReleases },
  { path: "/artist/:mbid/appears-on", module: routeModules.artistReleases },
  { path: "/artist/:mbid", module: routeModules.artist },
  { path: "/activity/:view", module: routeModules.activity },
  { path: "/search", module: routeModules.search },
  { path: "/shows/:filter", module: routeModules.shows },
  { path: "/settings/:tab?", module: routeModules.settings },
  { path: "/profile", module: routeModules.profile },
  { path: "/blocklist", module: routeModules.blocklist },
  {
    path: "/go/:kind",
    module: routeModules.resolveLink,
    queries: ({ kind }: Params<string>, { search }: RouteContext) => [
      prefetchable(resolveLinkQueryOptions(kind!, search)),
    ],
  },
];

const parseTarget = (to: unknown) => {
  if (typeof to !== "string" || !to.startsWith("/") || to.startsWith("//")) return null;
  const url = new URL(to, "http://aurral.local");
  return { pathname: url.pathname, search: url.searchParams };
};

const coolingDown = (queryKey: QueryKey) => {
  const state = queryClient.getQueryState(queryKey);
  return state?.status === "error" && Date.now() - state.errorUpdatedAt < FAILURE_COOLDOWN_MS;
};

const matchRoute = (pathname: string) => {
  for (const route of ROUTES) {
    const match = matchPath({ path: route.path, end: true }, pathname);
    if (match) return { route, match };
  }
  return null;
};

export function isRouteModuleLoaded(to: string) {
  const target = parseTarget(to);
  const matched = target ? matchRoute(target.pathname) : null;
  return Boolean(matched?.route.module.isLoaded());
}

export async function prefetchRoute(
  to: unknown,
  { userId = null }: { userId?: number | null } = {},
) {
  const target = parseTarget(to);
  if (!target || !canPrefetchInBackground()) return;
  const matched = matchRoute(target.pathname);
  if (matched) {
    const { route, match } = matched;
    const work: Promise<unknown>[] = [route.module().catch(() => null)];
    if (route.queries) {
      const options = await Promise.resolve(
        route.queries(match.params, { userId, search: target.search }),
      ).catch(() => []);
      for (const option of options) {
        if (option.enabled === false || coolingDown(option.queryKey)) continue;
        work.push(option.prefetch());
      }
    }
    await Promise.all(work);
  }
}

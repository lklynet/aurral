import { matchPath } from "react-router";
import { queryClient } from "../queryClient.js";
import {
  editorialPlaylistQueryOptions,
  editorialShelfQueryOptions,
  playlistJobsQueryOptions,
  playlistStatusQueryOptions,
  releaseGroupDetailsQueryOptions,
} from "../queryOptions.js";
import { canPrefetchInBackground } from "../utils/requestScheduling.js";
import { resolveLinkQueryOptions } from "./resolveLinks.js";
import { routeModules } from "./routeModules.js";

const FAILURE_COOLDOWN_MS = 30_000;

const libraryView = async (view, search) => {
  if (search.get("preview") === "1") return [];
  const { libraryListParams, libraryViewQueryOptions, resolveLibrarySection } = await import(
    "../pages/libraryViewQuery.js"
  );
  if (view.albumId || view.artistId) return [libraryViewQueryOptions(view)];
  const section = resolveLibrarySection(view.section);
  const { sort, direction, pageIndex } = libraryListParams(section, search);
  return [
    libraryViewQueryOptions({
      section,
      pageIndex,
      sort,
      direction,
      query: (search.get("q") || "").trim().toLocaleLowerCase(),
      genre: search.get("genre") || "",
    }),
  ];
};

const ROUTES = [
  { path: "/", module: routeModules.discover },
  {
    path: "/discover/playlists/deezer/:playlistId",
    module: routeModules.editorialPlaylist,
    queries: ({ playlistId }, { userId }) => [editorialPlaylistQueryOptions(userId, playlistId)],
  },
  {
    path: "/discover/playlists",
    module: routeModules.discoverPlaylists,
    queries: (_params, { userId }) => [editorialShelfQueryOptions(userId)],
  },
  { path: "/discover/news", module: routeModules.news },
  {
    path: "/library/playlists/:playlistId",
    module: routeModules.playlist,
    queries: ({ playlistId }) => [playlistStatusQueryOptions(), playlistJobsQueryOptions(playlistId)],
  },
  {
    path: "/library/playlists",
    module: routeModules.playlists,
    queries: () => [playlistStatusQueryOptions()],
  },
  {
    path: "/library/album/:albumId",
    module: routeModules.library,
    queries: ({ albumId }, { search }) => libraryView({ albumId }, search),
  },
  {
    path: "/library/artist/:artistId",
    module: routeModules.library,
    queries: ({ artistId }, { search }) => libraryView({ artistId }, search),
  },
  {
    path: "/library/:section?",
    module: routeModules.library,
    queries: ({ section }, { search }) => libraryView({ section }, search),
  },
  {
    path: "/flows/:flowId",
    module: routeModules.flow,
    queries: ({ flowId }) => [playlistStatusQueryOptions(), playlistJobsQueryOptions(flowId)],
  },
  { path: "/flows", module: routeModules.flows, queries: () => [playlistStatusQueryOptions()] },
  {
    path: "/artist/:mbid/release/:releaseMbid",
    module: routeModules.release,
    queries: ({ releaseMbid }) => [releaseGroupDetailsQueryOptions(releaseMbid)],
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
    queries: ({ kind }, { search }) => [resolveLinkQueryOptions(kind, search)],
  },
];

const parseTarget = (to) => {
  if (typeof to !== "string" || !to.startsWith("/") || to.startsWith("//")) return null;
  const url = new URL(to, "http://aurral.local");
  return { pathname: url.pathname, search: url.searchParams };
};

const coolingDown = (queryKey) => {
  const state = queryClient.getQueryState(queryKey);
  return state?.status === "error" && Date.now() - state.errorUpdatedAt < FAILURE_COOLDOWN_MS;
};

const matchRoute = (pathname) => {
  for (const route of ROUTES) {
    const match = matchPath({ path: route.path, end: true }, pathname);
    if (match) return { route, match };
  }
  return null;
};

export function isRouteModuleLoaded(to) {
  const target = parseTarget(to);
  const matched = target ? matchRoute(target.pathname) : null;
  return Boolean(matched?.route.module.isLoaded());
}

export async function prefetchRoute(to, { userId = null } = {}) {
  const target = parseTarget(to);
  if (!target || !canPrefetchInBackground()) return;
  const matched = matchRoute(target.pathname);
  if (matched) {
    const { route, match } = matched;
    const work = [route.module().catch(() => null)];
    if (route.queries) {
      const options = await Promise.resolve(
        route.queries(match.params, { userId, search: target.search }),
      ).catch(() => []);
      for (const option of options) {
        if (option.enabled === false || coolingDown(option.queryKey)) continue;
        work.push(queryClient.prefetchQuery(option));
      }
    }
    await Promise.all(work);
  }
}

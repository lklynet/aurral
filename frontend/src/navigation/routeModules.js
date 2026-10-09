const trackLoad = (load) => {
  let loaded = false;
  const importModule = () =>
    load().then((module) => {
      loaded = true;
      return module;
    });
  importModule.isLoaded = () => loaded;
  return importModule;
};

export const routeModules = {
  search: trackLoad(() => import("../pages/SearchResultsPage")),
  discover: trackLoad(() => import("../pages/DiscoverPage")),
  shows: trackLoad(() => import("../pages/ShowsPage")),
  library: trackLoad(() => import("../pages/LibraryPage")),
  settings: trackLoad(() => import("../pages/Settings/SettingsPage")),
  profile: trackLoad(() => import("../pages/ProfilePage")),
  blocklist: trackLoad(() => import("../pages/BlocklistPage")),
  artist: trackLoad(() => import("../pages/ArtistDetails/ArtistDetailsPage")),
  artistReleases: trackLoad(() => import("../pages/ArtistDetails/ArtistReleaseListPage")),
  release: trackLoad(() => import("../pages/ArtistDetails/ReleasePage")),
  activity: trackLoad(() => import("../pages/ActivityPage")),
  playlists: trackLoad(() => import("../pages/playlists/PlaylistsPage")),
  playlist: trackLoad(() => import("../pages/playlists/PlaylistDetailPage")),
  flows: trackLoad(() => import("../pages/playlists/FlowsPage")),
  flow: trackLoad(() => import("../pages/playlists/FlowDetailPage")),
  playlistRedirect: trackLoad(() => import("../pages/playlists/PlaylistRedirect")),
  discoverPlaylists: trackLoad(() => import("../pages/DiscoverPlaylistsPage")),
  editorialPlaylist: trackLoad(() => import("../pages/EditorialPlaylistDetailPage")),
  news: trackLoad(() => import("../pages/NewsPage")),
  resolveLink: trackLoad(() => import("../pages/ResolveLinkPage")),
};

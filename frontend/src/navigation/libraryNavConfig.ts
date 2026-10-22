export const DEFAULT_LIBRARY_VIEW = "home";

const VIEWS = [
  { id: "favorites", label: "Favorites", path: "/library/favorites" },
  { id: "albums", label: "Albums", path: "/library/albums" },
  { id: "tracks", label: "Tracks", path: "/library/tracks" },
  { id: "album-artists", label: "Album artists", path: "/library/album-artists" },
  { id: "artists", label: "Artists", path: "/library/artists" },
  { id: "genres", label: "Genres", path: "/library/genres" },
  { id: "playlists", label: "Playlists", path: "/library/playlists", permission: "accessFlow" },
] as const;

export type LibraryViewId = (typeof VIEWS)[number]["id"] | typeof DEFAULT_LIBRARY_VIEW;

type LibraryView = {
  id: LibraryViewId;
  label: string;
  path: string;
  permission?: string;
};

export const LIBRARY_VIEWS: readonly LibraryView[] = VIEWS;

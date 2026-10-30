import { Navigate, useLocation, useParams } from "react-router";
import { albumPath } from "../../../lib/albumPath.ts";
import type { RouteSeed } from "./routeSeed.ts";
import type { ReleaseFocusState } from "../utils/searchNavigation.ts";

export type AlbumRouteState = {
  artistMbid?: string | null;
  artistName?: string;
  inLibrary?: boolean;
  libraryArtist?: unknown;
  seed?: RouteSeed;
  focusReleaseGroup?: Partial<ReleaseFocusState["focusReleaseGroup"]>;
  focusTrackMbid?: string | number | null;
};

export function LegacyLibraryAlbumRedirect() {
  const { albumId } = useParams();
  const location = useLocation();
  return (
    <Navigate
      replace
      to={{ pathname: albumPath(albumId || ""), search: location.search }}
      state={location.state}
    />
  );
}

export function LegacyReleaseRedirect() {
  const { mbid, releaseMbid } = useParams();
  const location = useLocation();
  const state: AlbumRouteState = location.state || {};
  const search = new URLSearchParams(location.search);
  if (state.focusTrackMbid && !search.has("track")) {
    search.set("track", String(state.focusTrackMbid));
  }
  const query = search.toString();
  return (
    <Navigate
      replace
      to={{ pathname: albumPath(releaseMbid || ""), search: query ? `?${query}` : "" }}
      state={{ ...state, artistMbid: state.artistMbid || mbid || null }}
    />
  );
}

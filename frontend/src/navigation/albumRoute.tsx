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
};

export function LegacyAlbumRedirect() {
  const { ref, mbid } = useParams();
  const location = useLocation();
  const state: AlbumRouteState | null = location.state;
  return (
    <Navigate
      replace
      to={{ pathname: albumPath(ref || ""), search: location.search }}
      state={mbid ? { ...state, artistMbid: state?.artistMbid || mbid } : state}
    />
  );
}

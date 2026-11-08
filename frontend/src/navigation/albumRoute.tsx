import { Navigate, useLocation, useParams } from "react-router";
import { albumPath } from "../../../lib/albumPath.ts";
import { isRecord } from "../../../lib/isRecord.ts";
import { unknownList } from "../../../lib/unknownList.ts";
import { readRouteSeed, type RouteSeed } from "./routeSeed.ts";
import { routeStateOf, stateText } from "./routeState.ts";
import type { ReleaseFocusState } from "../utils/searchNavigation.ts";

export type AlbumRouteState = {
  artistMbid?: string | null;
  artistName?: string;
  inLibrary?: boolean;
  libraryArtist?: unknown;
  seed?: RouteSeed;
  focusReleaseGroup?: Partial<ReleaseFocusState["focusReleaseGroup"]>;
};

const textOrNumber = (value: unknown) =>
  typeof value === "string" || typeof value === "number" ? value : undefined;

const readFocusReleaseGroup = (value: unknown): AlbumRouteState["focusReleaseGroup"] => {
  if (!isRecord(value)) return undefined;
  const { rating } = value;
  return {
    id: textOrNumber(value.id),
    title: stateText(value.title),
    firstReleaseDate: stateText(value.firstReleaseDate),
    primaryType: stateText(value.primaryType),
    secondaryTypes: unknownList(value.secondaryTypes).filter(
      (type): type is string => typeof type === "string",
    ),
    coverUrl: stateText(value.coverUrl),
    deezerAlbumId: textOrNumber(value.deezerAlbumId),
    rating:
      isRecord(rating) && typeof rating.value === "number"
        ? { value: rating.value, count: Number(rating.count) || 0 }
        : null,
  };
};

export const readAlbumRouteState = (value: unknown): AlbumRouteState => {
  const state = routeStateOf(value);
  return {
    artistMbid: stateText(state.artistMbid),
    artistName: stateText(state.artistName),
    inLibrary: typeof state.inLibrary === "boolean" ? state.inLibrary : undefined,
    libraryArtist: state.libraryArtist,
    seed: readRouteSeed(state) ?? undefined,
    focusReleaseGroup: readFocusReleaseGroup(state.focusReleaseGroup),
  };
};

export function LegacyAlbumRedirect() {
  const { ref, mbid } = useParams();
  const location = useLocation();
  const state: unknown = location.state;
  const fields = routeStateOf(state);
  return (
    <Navigate
      replace
      to={{ pathname: albumPath(ref || ""), search: location.search }}
      state={mbid ? { ...fields, artistMbid: stateText(fields.artistMbid) || mbid } : state}
    />
  );
}

import { useLocation } from "react-router";
import { routeStateOf } from "../../../navigation/routeState.ts";

export function useArtistRouteState() {
  const state: unknown = useLocation().state;
  const fields = routeStateOf(state);
  return {
    state,
    artistName: typeof fields.artistName === "string" ? fields.artistName : undefined,
    artistImage: typeof fields.artistImage === "string" ? fields.artistImage : undefined,
    inLibrary: typeof fields.inLibrary === "boolean" ? fields.inLibrary : undefined,
  };
}

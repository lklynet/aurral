import { useMemo } from "react";
import { useLocation } from "react-router";
import { isRecord } from "../../../../../lib/isRecord.ts";
import { routeStateOf } from "../../../navigation/routeState.ts";
import type { LibraryArtistRecord } from "./useArtistDetailsStream.ts";

const isLibraryArtistRecord = (value: unknown): value is LibraryArtistRecord =>
  isRecord(value) && "id" in value;

export function useArtistRouteState() {
  const state: unknown = useLocation().state;
  const fields = routeStateOf(state);
  const existsInLibrary = typeof fields.inLibrary === "boolean" ? fields.inLibrary : undefined;
  const libraryArtist = isLibraryArtistRecord(fields.libraryArtist) ? fields.libraryArtist : null;
  const initialLibraryHint = useMemo(
    () => ({ existsInLibrary, libraryArtist }),
    [existsInLibrary, libraryArtist],
  );
  return {
    state,
    artistName: typeof fields.artistName === "string" ? fields.artistName : undefined,
    artistImage: typeof fields.artistImage === "string" ? fields.artistImage : undefined,
    initialLibraryHint,
  };
}

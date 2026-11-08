import { isRecord } from "../../../lib/isRecord.ts";
import { routeStateOf, stateText as text } from "./routeState.ts";

export type RouteSeed = {
  name?: string;
  title?: string;
  artistName?: string;
  artworkUrl?: string | null;
  coverUrl?: string | null;
  trackCount?: number;
};

export const readRouteSeed = (state: unknown): RouteSeed | null => {
  const seed = routeStateOf(state).seed;
  if (!isRecord(seed)) return null;
  return {
    name: text(seed.name),
    title: text(seed.title),
    artistName: text(seed.artistName),
    artworkUrl: text(seed.artworkUrl),
    coverUrl: text(seed.coverUrl),
    trackCount: typeof seed.trackCount === "number" ? seed.trackCount : undefined,
  };
};

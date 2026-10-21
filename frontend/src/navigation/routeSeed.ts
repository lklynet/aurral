export type RouteSeed = {
  name?: string;
  title?: string;
  artistName?: string;
  artworkUrl?: string | null;
  coverUrl?: string | null;
  trackCount?: number;
};

export const readRouteSeed = (state: { seed?: RouteSeed } | null | undefined) =>
  state?.seed && typeof state.seed === "object" && !Array.isArray(state.seed) ? state.seed : null;

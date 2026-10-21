import { UUID_REGEX } from "../../../lib/uuid.ts";

export const DISCOVERY_MANUAL_REFRESH_KEY = "aurral.discovery.manualRefreshPending";

type DiscoverRecentPageState = {
  artistName?: string;
  inLibrary?: boolean;
  libraryArtist?: unknown;
};

export function getDiscoverArtistPath(path: unknown) {
  if (!path || typeof path !== "string") return "";
  const pathname = path.split("?")[0];
  const match = pathname.match(/^\/artist\/([^/]+)/);
  return match ? `/artist/${match[1]}` : "";
}

export function shouldTrackDiscoverPath(path: unknown) {
  if (!path || typeof path !== "string") return false;
  return Boolean(getDiscoverArtistPath(path));
}

export function pickDiscoverRecentPageState(
  state: DiscoverRecentPageState | null | undefined,
): DiscoverRecentPageState {
  if (!state || typeof state !== "object") return {};
  const next: DiscoverRecentPageState = {};
  if (state.artistName) next.artistName = String(state.artistName);
  if (typeof state.inLibrary === "boolean") next.inLibrary = state.inLibrary;
  if (state.libraryArtist) next.libraryArtist = state.libraryArtist;
  return next;
}

export function getDiscoverRecentPageLinkState(
  entry: { label?: string; state?: DiscoverRecentPageState } | null | undefined,
) {
  const storedState = pickDiscoverRecentPageState(entry?.state);
  if (storedState.artistName) return storedState;
  const label = String(entry?.label || "").trim();
  if (!label || label === "Artist" || UUID_REGEX.test(label)) {
    return storedState;
  }
  return { ...storedState, artistName: label };
}

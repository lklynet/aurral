import { browsePlaylistPath, flowPath, playlistPath } from "../navigation/playlistPaths.ts";
import { albumPath } from "../../../lib/albumPath.ts";
import { resolveAlbumPath } from "../navigation/resolveLinks.ts";
import type { toNormalizedAlbum } from "../../../backend/services/providers/brainzmashMappers.ts";

type AlbumRating = NonNullable<ReturnType<typeof toNormalizedAlbum>["rating"]>;

export type SearchItem = {
  type?: string | null;
  key?: string | number | null;
  id?: string | number | null;
  name?: string | null;
  title?: string | null;
  albumTitle?: string | null;
  artistName?: string | null;
  artistMbid?: string | null;
  artistInLibrary?: boolean | null;
  albumMbid?: string | null;
  libraryAlbumId?: string | null;
  libraryId?: string | null;
  trackMbid?: string | null;
  inLibrary?: boolean | null;
  source?: string | null;
  score?: number | null;
  sortName?: string | null;
  hasMbid?: boolean | null;
  trackCount?: number | null;
  disambiguation?: string | null;
  releaseDate?: string | null;
  firstReleaseDate?: string | null;
  releaseYear?: number | string | null;
  primaryType?: string | null;
  releaseType?: string | null;
  albumType?: string | null;
  secondaryTypes?: string[] | null;
  coverUrl?: string | null;
  imageUrl?: string | null;
  image?: string | null;
  deezerAlbumId?: string | number | null;
  _deezerAlbumId?: string | number | null;
  rating?: AlbumRating | null;
  streamPath?: string | null;
  sourceFlowId?: string | null;
  trackMatch?: { title: string; count: number } | null;
  foreignArtistId?: string | null;
  mbid?: string | null;
  artistId?: string | null;
  durationMs?: number | null;
  status?: string | null;
};

type SearchBuckets<Item extends SearchItem = SearchItem> = {
  artists?: Item[] | null;
  albums?: Item[] | null;
  tracks?: Item[] | null;
  playlists?: Item[] | null;
};

type CatalogBuckets<Item extends SearchItem = SearchItem> = SearchBuckets<Item> & {
  top?: Item | null;
};

export function getSearchResultLabel(item: SearchItem | null | undefined) {
  if (!item) return "";
  if (item.type === "artist") return item.name || "";
  if (item.type === "playlist") return item.name || "";
  if (item.type === "album") {
    const title = item.title || "";
    const artist = item.artistName || "";
    return artist ? `${title} — ${artist}` : title;
  }
  if (item.type === "track") {
    const title = item.title || "";
    const artist = item.artistName || "";
    return artist ? `${title} — ${artist}` : title;
  }
  return "";
}

export function getSearchResultKey(item: SearchItem | null | undefined, index = 0) {
  if (!item) return `search-item-${index}`;
  return item.key || item.id || `${item.type}:${getSearchResultLabel(item).toLowerCase()}:${index}`;
}

type ArtistFocusState = {
  artistName?: string | null;
  inLibrary?: boolean;
};

export function buildArtistFocusState<Overrides extends object = Record<never, never>>(
  item: SearchItem | null | undefined,
  overrides: Overrides = {} as Overrides,
) {
  const state: ArtistFocusState & Overrides = { ...overrides };
  if (item?.artistName || item?.name) state.artistName = item.artistName || item.name;
  if (typeof item?.inLibrary === "boolean") state.inLibrary = item.inLibrary;
  return state;
}

export type ReleaseFocusState = {
  focusReleaseGroup: ReturnType<typeof buildReleaseFocusState>;
};

function buildReleaseFocusState(
  item: SearchItem | null | undefined,
  releaseGroupMbid: string | number,
) {
  const releaseTitle = item?.type === "album" ? item.title : item?.albumTitle;
  const releaseDate =
    item?.releaseDate ||
    item?.firstReleaseDate ||
    (item?.releaseYear ? String(item.releaseYear) : "");
  return {
    id: releaseGroupMbid,
    title: releaseTitle || "",
    firstReleaseDate: releaseDate || "",
    primaryType: item?.primaryType || item?.releaseType || "Album",
    secondaryTypes: Array.isArray(item?.secondaryTypes) ? item.secondaryTypes : [],
    coverUrl: item?.coverUrl || item?.imageUrl || item?.image || "",
    deezerAlbumId: item?._deezerAlbumId || item?.deezerAlbumId || "",
    rating: item?.rating || null,
  };
}

type ReleaseGroupInput = {
  id?: string | null;
  title?: string | null;
  "first-release-date"?: string | null;
  "primary-type"?: string | null;
  "secondary-types"?: string[] | null;
  _coverUrl?: string | null;
  coverUrl?: string | null;
  _deezerAlbumId?: string | number | null;
  rating?: AlbumRating | null;
};

type NavigationItemOptions = {
  artistMbid?: string | null;
  artistName?: string | null;
  coverUrl?: string;
};

export function buildReleaseGroupNavigationItem(
  releaseGroup: ReleaseGroupInput | null | undefined,
  { artistMbid, artistName, coverUrl = "" }: NavigationItemOptions = {},
) {
  if (!releaseGroup?.id || !artistMbid) return null;
  return {
    type: "album",
    id: releaseGroup.id,
    title: releaseGroup.title || "",
    artistMbid,
    artistName: artistName || "",
    releaseDate: releaseGroup["first-release-date"] || "",
    primaryType: releaseGroup["primary-type"] || "Album",
    secondaryTypes: Array.isArray(releaseGroup["secondary-types"])
      ? releaseGroup["secondary-types"]
      : [],
    coverUrl: coverUrl || releaseGroup._coverUrl || releaseGroup.coverUrl || "",
    deezerAlbumId: releaseGroup._deezerAlbumId || "",
    rating: releaseGroup.rating || null,
  };
}

export function getReleaseGroupLink(
  releaseGroup: ReleaseGroupInput | null | undefined,
  { artistMbid, artistName, coverUrl = "" }: NavigationItemOptions = {},
) {
  const target = getReleaseNavigationTarget(
    buildReleaseGroupNavigationItem(releaseGroup, { artistMbid, artistName, coverUrl }),
  );
  return target ? { to: target.pathname, state: target.state } : null;
}

export function getReleaseNavigationTarget(item: SearchItem | null | undefined) {
  if (!item?.artistMbid) return null;
  const releaseGroupMbid = item.type === "album" ? item.id : item.albumMbid;
  if (!releaseGroupMbid) return null;
  const state: ArtistFocusState & ReleaseFocusState & { artistMbid: string } =
    buildArtistFocusState(item, {
      artistMbid: item.artistMbid,
      focusReleaseGroup: buildReleaseFocusState(item, releaseGroupMbid),
    });
  const trackMbid = item.type === "track" ? item.trackMbid : null;
  return {
    pathname: albumPath(releaseGroupMbid, { track: trackMbid }),
    state,
  };
}

function getLibraryResultPath(item: SearchItem) {
  if (item?.source !== "library") return null;
  if (item.type === "artist" && item.libraryId) {
    return `/library/artist/${encodeURIComponent(item.libraryId)}`;
  }
  if (item.type === "album" && item.libraryId) {
    return albumPath(item.id || item.libraryId);
  }
  if (item.type === "track" && item.libraryAlbumId) {
    return albumPath(item.albumMbid || item.libraryAlbumId);
  }
  return null;
}

export function getSearchResultLink(item: SearchItem | null | undefined, { query = "" } = {}) {
  if (!item) return null;

  const libraryPath = getLibraryResultPath(item);
  if (libraryPath) return { to: libraryPath };

  if (item.type === "artist") {
    if (item.id) {
      return { to: `/artist/${item.id}`, state: buildArtistFocusState(item) };
    }
    return { to: `/search?q=${encodeURIComponent(item.name || query)}&filter=artists` };
  }

  if (item.type === "album") {
    const target = getReleaseNavigationTarget(item);
    if (target) return { to: target.pathname, state: target.state };
    return { to: `/search?q=${encodeURIComponent(item.title || query)}&filter=albums` };
  }

  if (item.type === "track") {
    if (item.source === "library" && item.streamPath && !item.albumMbid) {
      return { to: "/library" };
    }
    const target = getReleaseNavigationTarget(item);
    if (target) return { to: target.pathname, state: target.state };
    const resolved =
      item.source === "deezer"
        ? resolveAlbumPath({
            artistName: item.artistName,
            albumName: item.albumTitle,
            deezerAlbumId: item.deezerAlbumId,
            trackName: item.title,
          })
        : null;
    if (resolved) return { to: resolved };
    if (item.artistMbid) {
      return { to: `/artist/${item.artistMbid}`, state: buildArtistFocusState(item) };
    }
    return {
      to: `/search?q=${encodeURIComponent(
        [item.artistName, item.title].filter(Boolean).join(" ") || query,
      )}&filter=tracks`,
    };
  }

  if (item.type === "playlist" && item.id) {
    if (item.source === "deezer" || item.source === "mix" || item.source === "discovery") {
      return {
        to: browsePlaylistPath(item.source, String(item.id)),
        state: {
          seed: { name: item.name, artworkUrl: item.coverUrl || null, trackCount: item.trackCount },
        },
      };
    }
    return { to: item.sourceFlowId ? flowPath(item.sourceFlowId) : playlistPath(item.id) };
  }
  return null;
}

export function getPlaylistResultDetail(item: SearchItem) {
  if (item.trackMatch) {
    const more = item.trackMatch.count - 1;
    return more > 0
      ? `Has ${item.trackMatch.title} and ${more} more`
      : `Has ${item.trackMatch.title}`;
  }
  const tracks =
    item.trackCount != null ? `${item.trackCount} track${item.trackCount === 1 ? "" : "s"}` : null;
  const source =
    item.source === "deezer"
      ? "Deezer"
      : item.source === "mix" || item.source === "discovery"
        ? "Made for you"
        : null;
  return [source, tracks].filter(Boolean).join(" · ") || null;
}

export function navigateFromSearchResult(
  navigate: (to: string, options?: { state: Record<string, unknown> }) => void,
  item: SearchItem | null | undefined,
  { query = "" } = {},
) {
  if (typeof navigate !== "function") return;
  const link = getSearchResultLink(item, { query });
  if (!link) return;
  if (link.state) {
    navigate(link.to, { state: link.state });
    return;
  }
  navigate(link.to);
}

export function getReleaseTypeLabel(item: SearchItem | null | undefined) {
  return item?.primaryType === "Single" || item?.primaryType === "EP" ? item.primaryType : "Album";
}

function dedupe<Item extends SearchItem>(items: Item[], seen: Set<string>) {
  return items.filter((item) => {
    const key = item.id ? `${item.type}:${item.id}` : item.key ? String(item.key) : null;
    if (!key) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const matchText = (...parts: unknown[]) =>
  parts
    .map((part) =>
      String(part ?? "")
        .toLowerCase()
        .replace(/[([].*?[)\]]/g, "")
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim(),
    )
    .join("|");

function resultIdentities(item: SearchItem) {
  if (item.type === "track") {
    return [
      item.trackMbid ? `mbid:${item.trackMbid}` : null,
      `text:${matchText(item.artistName, item.title, item.albumTitle)}`,
    ].filter((key) => key !== null);
  }
  if (item.type === "album") {
    return [item.id ? `id:${item.id}` : `text:${matchText(item.artistName, item.title)}`];
  }
  if (item.type === "artist") {
    return [item.id ? `id:${item.id}` : `text:${matchText(item.name)}`];
  }
  return [`key:${item.key ?? item.id}`];
}

export function isSameSearchResult(left: SearchItem | null | undefined, right: SearchItem) {
  if (!left || left.type !== right.type) return false;
  const keys = new Set(resultIdentities(left));
  return resultIdentities(right).some((key) => keys.has(key));
}

function mergeLibraryFirst<Item extends SearchItem>(library: Item[], catalog: Item[]) {
  const merged: Item[] = [];
  const positions = new Map<string, number>();
  for (const item of [...library, ...catalog]) {
    const keys = resultIdentities(item);
    const position = keys.map((key) => positions.get(key)).find((found) => found !== undefined);
    if (position === undefined) {
      for (const key of keys) positions.set(key, merged.length);
      merged.push(item);
      continue;
    }
    for (const key of keys) positions.set(key, position);
    merged[position] = { ...item, ...merged[position] };
  }
  return merged;
}

export function buildSearchSections<Item extends SearchItem>({
  library,
  catalog,
  playlists = [],
}: {
  library?: SearchBuckets<Item> | null;
  catalog?: CatalogBuckets<Item> | null;
  playlists?: Item[];
}) {
  const artists = mergeLibraryFirst(library?.artists ?? [], catalog?.artists ?? []);
  const releases = mergeLibraryFirst(library?.albums ?? [], catalog?.albums ?? []);
  const songs = mergeLibraryFirst(library?.tracks ?? [], catalog?.tracks ?? []);
  const catalogTop = catalog?.top ?? null;
  const owned = catalogTop
    ? [...artists, ...releases, ...songs].find((item) => isSameSearchResult(catalogTop, item))
    : undefined;
  return {
    top: catalogTop && owned ? { ...catalogTop, ...owned } : catalogTop,
    artists,
    albums: releases.filter((album) => getReleaseTypeLabel(album) === "Album"),
    singles: releases.filter((album) => getReleaseTypeLabel(album) !== "Album"),
    songs,
    playlists: mergeLibraryFirst(library?.playlists ?? [], playlists),
  };
}

export function buildUnifiedSuggestionSections<Item extends SearchItem>({
  library,
  catalog,
}: {
  library?: SearchBuckets<Item> | null;
  catalog?: CatalogBuckets<Item> | null;
}) {
  const seen = new Set<string>();
  const libraryItems = [
    ...dedupe(library?.artists ?? [], new Set()),
    ...dedupe([...(library?.albums ?? []), ...(library?.tracks ?? [])], seen),
  ];
  return [
    { key: "library", label: "Your Library", items: libraryItems },
    { key: "top", label: "Search", items: dedupe(catalog?.top ? [catalog.top] : [], seen) },
    { key: "artists", label: "Artists", items: dedupe(catalog?.artists ?? [], seen) },
    { key: "tracks", label: "Songs", items: dedupe(catalog?.tracks ?? [], seen) },
    { key: "playlists", label: "Playlists", items: dedupe(library?.playlists ?? [], seen) },
    { key: "albums", label: "Albums", items: dedupe(catalog?.albums ?? [], seen) },
  ].filter((section) => section.items.length > 0);
}

export function flattenSuggestionSections<Item extends SearchItem>(
  sections: { key: string; label: string; items: Item[] }[],
) {
  const rows: (
    | { kind: "header"; key: string; label: string }
    | { kind: "item"; key: string; item: Item }
  )[] = [];
  for (const section of sections) {
    rows.push({
      kind: "header",
      key: `header:${section.key}`,
      label: section.label,
    });
    section.items.forEach((item, index) => {
      rows.push({
        kind: "item",
        key: `${section.key}:${getSearchResultKey(item, index)}`,
        item,
      });
    });
  }
  return rows;
}

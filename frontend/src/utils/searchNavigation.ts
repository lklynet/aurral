import { flowPath, playlistPath } from "../navigation/playlistPaths.ts";
import type { toNormalizedAlbum } from "../../../backend/services/providers/brainzmashMappers.ts";

type AlbumRating = NonNullable<ReturnType<typeof toNormalizedAlbum>["rating"]>;

type SearchItem = {
  type?: string | null;
  key?: string | null;
  id?: string | number | null;
  name?: string | null;
  title?: string | null;
  albumTitle?: string | null;
  artistName?: string | null;
  artistMbid?: string | null;
  artistInLibrary?: boolean | null;
  albumMbid?: string | null;
  albumCanonicalId?: string | null;
  canonicalId?: string | null;
  trackMbid?: string | null;
  inLibrary?: boolean | null;
  source?: string | null;
  score?: number | null;
  sortName?: string | null;
  hasMbid?: boolean | null;
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
  foreignArtistId?: string | null;
  mbid?: string | null;
  artistId?: string | null;
};

type SearchBuckets = {
  artists?: SearchItem[] | null;
  albums?: SearchItem[] | null;
  tracks?: SearchItem[] | null;
};

type SearchResponse = {
  query?: string | null;
  top?: SearchItem | null;
  catalog?: SearchBuckets | null;
  library?: SearchBuckets | null;
};

type LibraryFlags = {
  artistIds?: ReadonlySet<unknown>;
  albumIds?: ReadonlySet<unknown>;
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
  focusReleaseGroupMbid: string | number;
  focusReleaseGroup: ReturnType<typeof buildReleaseFocusState>;
  focusTrackMbid?: string | number;
  focusTrackTitle?: string;
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

type LibraryAlbumInput = {
  releaseGroupMbid?: string | null;
  mbid?: string | null;
  foreignAlbumId?: string | null;
  albumName?: string | null;
  title?: string | null;
  artistName?: string | null;
  releaseDate?: string | null;
  albumType?: string | null;
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

export function buildLibraryAlbumNavigationItem(
  libraryAlbum: LibraryAlbumInput | null | undefined,
  { artistMbid, artistName, coverUrl = "" }: NavigationItemOptions = {},
) {
  const releaseGroupMbid =
    libraryAlbum?.releaseGroupMbid || libraryAlbum?.mbid || libraryAlbum?.foreignAlbumId || null;
  if (!releaseGroupMbid || !artistMbid) return null;
  return {
    type: "album",
    id: releaseGroupMbid,
    title: libraryAlbum!.albumName || libraryAlbum!.title || "",
    artistMbid,
    artistName: artistName || libraryAlbum!.artistName || "",
    releaseDate: libraryAlbum!.releaseDate || "",
    primaryType: libraryAlbum!.albumType || "Album",
    coverUrl,
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

export function getLibraryAlbumLink(
  libraryAlbum: LibraryAlbumInput | null | undefined,
  { artistMbid, artistName, coverUrl = "" }: NavigationItemOptions = {},
) {
  const target = getReleaseNavigationTarget(
    buildLibraryAlbumNavigationItem(libraryAlbum, { artistMbid, artistName, coverUrl }),
  );
  return target ? { to: target.pathname, state: target.state } : null;
}

export function getReleaseNavigationTarget(item: SearchItem | null | undefined) {
  if (!item?.artistMbid) return null;
  const releaseGroupMbid = item.type === "album" ? item.id : item.albumMbid;
  if (!releaseGroupMbid) return null;
  const state: ArtistFocusState & ReleaseFocusState = buildArtistFocusState(item, {
    focusReleaseGroupMbid: releaseGroupMbid,
    focusReleaseGroup: buildReleaseFocusState(item, releaseGroupMbid),
  });
  if (item.type === "track") {
    const trackMbid = item.id || item.trackMbid;
    if (trackMbid) state.focusTrackMbid = trackMbid;
    if (item.title) state.focusTrackTitle = item.title;
  }
  return {
    pathname: `/artist/${item.artistMbid}/release/${releaseGroupMbid}`,
    state,
  };
}

function getLibraryResultPath(item: SearchItem) {
  if (item?.source !== "library") return null;
  if (item.type === "artist" && item.canonicalId) {
    return `/library/artist/${encodeURIComponent(item.canonicalId)}`;
  }
  if (item.type === "album" && item.canonicalId) {
    return `/library/album/${encodeURIComponent(item.canonicalId)}`;
  }
  if (item.type === "track" && item.albumCanonicalId) {
    return `/library/album/${encodeURIComponent(item.albumCanonicalId)}`;
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
    return { to: item.sourceFlowId ? flowPath(item.sourceFlowId) : playlistPath(item.id) };
  }
  return null;
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

function normalizeSearchText(value: unknown) {
  return String(value || "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function applyLibraryFlags(item: SearchItem, libraryFlags: LibraryFlags = {}) {
  if (!item || item.inLibrary) return item;
  const artistIds = libraryFlags.artistIds;
  const albumIds = libraryFlags.albumIds;
  if (item.type === "artist" && item.id && artistIds?.has(item.id)) {
    return { ...item, inLibrary: true };
  }
  if (item.type === "album" && item.id && albumIds?.has(item.id)) {
    return { ...item, inLibrary: true };
  }
  if (item.type === "track" && item.albumMbid && albumIds?.has(item.albumMbid)) {
    return { ...item, inLibrary: true };
  }
  return item;
}

function prepareSearchCandidates(items: SearchItem[], libraryFlags: LibraryFlags) {
  return items.filter(Boolean).map((item) => applyLibraryFlags(item, libraryFlags));
}

function getResultIdentity(item: SearchItem | null | undefined) {
  if (!item) return null;
  if (item.id) return `${item.type}:${item.id}`;
  if (item.key) return String(item.key);
  return null;
}

function dedupeItems(
  items: SearchItem[],
  seen: Set<string>,
  seenArtistNames: Set<string> | null = null,
) {
  const unique: SearchItem[] = [];
  for (const item of items) {
    if (item.type === "artist" && seenArtistNames) {
      const nameKey = normalizeSearchText(item.name);
      if (nameKey) {
        if (seenArtistNames.has(nameKey)) continue;
        seenArtistNames.add(nameKey);
      }
    }
    const identity = getResultIdentity(item);
    if (identity) {
      if (seen.has(identity)) continue;
      seen.add(identity);
    }
    unique.push(item);
  }
  return unique;
}

export function dedupeArtistsByName<T extends SearchItem>(artists: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const artist of artists) {
    const key = normalizeSearchText(artist?.name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(artist);
  }
  return result;
}

function findArtistMatch(
  artists: SearchItem[],
  { id, name }: { id?: string | number | null; name?: string | null },
) {
  if (id) {
    const byId = artists.find((artist) => artist?.id === id || artist?.key === id);
    if (byId) return byId;
  }
  if (name) {
    const normalizedName = normalizeSearchText(name);
    return artists.find((artist) => normalizeSearchText(artist?.name) === normalizedName);
  }
  return null;
}

function compactSearchText(value: unknown) {
  return normalizeSearchText(value).replace(/\s+/g, "");
}

function queryMatchesArtistName(query: string, artistName: unknown) {
  const normalizedQuery = normalizeSearchText(query);
  const normalizedName = normalizeSearchText(artistName);
  if (!normalizedQuery || !normalizedName) return false;
  if (normalizedQuery === normalizedName) return true;
  return compactSearchText(normalizedQuery) === compactSearchText(normalizedName);
}

function findQueryArtist(allArtists: SearchItem[], query: string) {
  const exact = findArtistMatch(allArtists, { name: query });
  if (exact) return exact;

  const compactQuery = compactSearchText(query);
  if (!compactQuery) return null;
  return allArtists.find((artist) => compactSearchText(artist?.name) === compactQuery) || null;
}

function artistFromAlbumTop(album: SearchItem) {
  if (!album?.artistName) return null;
  return {
    type: "artist",
    source: album.source,
    id: album.artistMbid || null,
    key: album.artistMbid || album.artistName,
    name: album.artistName,
    sortName: album.artistName,
    inLibrary: Boolean(album.inLibrary),
    hasMbid: Boolean(album.artistMbid),
    score: album.score,
  };
}

function artistFromPerformerFields(item: SearchItem) {
  if (!item?.artistName && !item?.artistMbid) return null;
  return {
    type: "artist",
    id: item.artistMbid || null,
    key: item.artistMbid || item.artistName,
    name: item.artistName,
    sortName: item.artistName,
    inLibrary: Boolean(item.artistInLibrary || item.inLibrary),
    score: item.score,
  };
}

export function resolveSearchTopResult(
  data: SearchResponse | null | undefined,
  libraryFlags: LibraryFlags = {},
) {
  if (!data) return null;

  const query = String(data.query || "").trim();
  const top = data.top;
  const catalogArtists = data.catalog?.artists || [];
  const queryArtist = findQueryArtist(catalogArtists, query);

  if (top?.type === "artist" && top.name) {
    return prepareSearchCandidates([top], libraryFlags)[0];
  }

  if (top?.type === "album" && queryMatchesArtistName(query, top.artistName)) {
    const artist =
      findArtistMatch(catalogArtists, {
        id: top.artistMbid,
        name: top.artistName,
      }) || artistFromAlbumTop(top);
    if (artist?.name) {
      return prepareSearchCandidates([artist], libraryFlags)[0];
    }
  }

  if (queryArtist && (top?.type === "album" || top?.type === "track" || !top)) {
    return prepareSearchCandidates([queryArtist], libraryFlags)[0];
  }

  if (top?.type && (top.name || top.title)) {
    return prepareSearchCandidates([top], libraryFlags)[0];
  }

  const fallback =
    queryArtist || catalogArtists[0] || data.catalog?.albums?.[0] || data.catalog?.tracks?.[0];
  if (!fallback) return null;
  return prepareSearchCandidates([fallback], libraryFlags)[0];
}

export function resolveSearchTopArtist(
  data: SearchResponse | null | undefined,
  libraryFlags: LibraryFlags = {},
) {
  const top = resolveSearchTopResult(data, libraryFlags);
  if (!top) return null;
  if (top.type === "artist") return top;

  const catalogArtists = data!.catalog?.artists || [];
  const matched =
    findArtistMatch(catalogArtists, {
      id: top.artistMbid,
      name: top.artistName,
    }) || artistFromPerformerFields(top);
  if (matched?.name) {
    return prepareSearchCandidates([matched], libraryFlags)[0];
  }

  return catalogArtists[0] || null;
}

export function buildSearchArtistResults(
  data: SearchResponse | null | undefined,
  libraryFlags: LibraryFlags = {},
) {
  if (!data) return [];

  const candidates = [...(data.catalog?.artists || [])];
  const topArtist = resolveSearchTopArtist(data, libraryFlags);
  if (topArtist?.name) {
    const topId = topArtist.id || topArtist.mbid;
    const alreadyListed =
      topId && candidates.some((artist) => (artist?.id || artist?.mbid) === topId);
    if (!alreadyListed) {
      candidates.push(topArtist);
    }
  }

  return dedupeArtistsByName(
    prepareSearchCandidates(candidates, libraryFlags).filter(
      (artist) => artist?.id || artist?.mbid || artist?.foreignArtistId,
    ),
  );
}

function getSearchResultBuckets(data: SearchResponse) {
  return [
    ...(data.catalog?.artists || []),
    ...(data.catalog?.albums || []),
    ...(data.catalog?.tracks || []),
  ];
}

export function buildMixedSearchPageItems(
  data: SearchResponse | null | undefined,
  {
    limit = 24,
    excludeArtist = null,
    excludeItem = null,
    libraryFlags = {},
  }: {
    limit?: number;
    excludeArtist?: SearchItem | null;
    excludeItem?: SearchItem | null;
    libraryFlags?: LibraryFlags;
  } = {},
) {
  if (!data) return [];

  const excluded = excludeItem || excludeArtist;
  const excludeName = excluded?.type === "artist" ? normalizeSearchText(excluded.name) : "";
  const excludeId = excluded?.id || null;
  const excludeIdentity = getResultIdentity(excluded);

  const candidates = prepareSearchCandidates(getSearchResultBuckets(data), libraryFlags).filter(
    (item) => {
      if (!excluded) return true;
      if (excludeIdentity && getResultIdentity(item) === excludeIdentity) {
        return false;
      }
      if (excludeId && item.id === excludeId && item.type === excluded.type) {
        return false;
      }
      if (item.type !== "artist") return true;
      if (excludeName && normalizeSearchText(item.name) === excludeName) {
        return false;
      }
      return true;
    },
  );

  const seen = new Set<string>();
  const seenArtistNames = new Set<string>();
  if (excludeName) seenArtistNames.add(excludeName);
  return dedupeItems(candidates, seen, seenArtistNames).slice(0, limit);
}

export function buildUnifiedSuggestionSections(data: SearchResponse | null | undefined) {
  if (!data) return [];

  const seen = new Set<string>();
  const seenArtistNames = new Set<string>();
  const sections: { key: string; label: string; items: SearchItem[] }[] = [];

  const libraryArtists = dedupeItems(data.library?.artists || [], seen, seenArtistNames);
  const libraryAlbums = dedupeItems(data.library?.albums || [], seen, seenArtistNames);
  const libraryTracks = dedupeItems(data.library?.tracks || [], seen, seenArtistNames);
  const libraryItems = [...libraryArtists, ...libraryAlbums, ...libraryTracks];
  if (libraryItems.length > 0) {
    sections.push({ key: "library", label: "Your Library", items: libraryItems });
  }

  if (data.top) {
    const identity = getResultIdentity(data.top);
    const nameKey = data.top.type === "artist" ? normalizeSearchText(data.top.name) : null;
    const alreadyListed =
      (identity && seen.has(identity)) || (nameKey && seenArtistNames.has(nameKey));

    if (identity) seen.add(identity);
    if (nameKey) seenArtistNames.add(nameKey);

    if (!alreadyListed) {
      sections.push({ key: "top", label: "Search", items: [data.top] });
    }
  }

  const artists = dedupeItems(data.catalog?.artists || [], seen, seenArtistNames);
  if (artists.length > 0) {
    sections.push({
      key: "artists",
      label: "Artists",
      items: artists,
    });
  }

  const albums = dedupeItems(data.catalog?.albums || [], seen, seenArtistNames);
  if (albums.length > 0) {
    sections.push({
      key: "albums",
      label: "Albums",
      items: albums,
    });
  }

  const tracks = dedupeItems(data.catalog?.tracks || [], seen, seenArtistNames);
  if (tracks.length > 0) {
    sections.push({
      key: "tracks",
      label: "Songs",
      items: tracks,
    });
  }

  return sections;
}

export function flattenSuggestionSections(
  sections: { key: string; label: string; items: SearchItem[] }[],
) {
  const rows = [];
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

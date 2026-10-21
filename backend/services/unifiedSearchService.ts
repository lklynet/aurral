import createCache from "./apiClients/simpleCache.ts";
import { getNormalizedText, scoreTextMatch } from "./providers/brainzmashRanking.ts";
import { getMetadataBaseUrl } from "./providers/brainzmashProvider.ts";
import { searchAlbums, searchArtists } from "./providers/brainzmashProvider.ts";
import { flowPlaylistConfig } from "./playlists/flowPlaylistConfig.ts";
import { getCachedArtists } from "./libraryManager.ts";
import { getLibrarySearchPage } from "./libraryQueryService.ts";
import { compareSearchResults, getLocalMatchThreshold } from "./searchRanking.ts";
import { parsePositiveInt } from "./searchService.ts";
import type { RequestUser } from "../middleware/requestUser.ts";

type BrainzmashArtistItem = Awaited<ReturnType<typeof searchArtists>>["items"][number];
type BrainzmashAlbumItem = Awaited<ReturnType<typeof searchAlbums>>["items"][number];

const unifiedSearchCache = createCache(60);
const catalogSearchCache = createCache(60);

const SUGGEST_LIMIT = 5;
const FULL_LIMIT = 20;
const SEARCH_CONTEXT_TTL_SECONDS = 300;
const CONTEXT_BOOST = {
  LIBRARY_TRACK: 420,
  PLAYLIST_TRACK: 360,
  PLAYLIST_TRACK_FUZZY: 220,
  PLAYLIST_ALBUM: 150,
  LIBRARY_ARTIST: 80,
  PLAYLIST_ARTIST: 48,
  EXACT_TITLE_WITH_LIBRARY_ARTIST: 36,
};

const searchContextCache = createCache(SEARCH_CONTEXT_TTL_SECONDS);

type SearchContextAnnotations = {
  primaryMatchScore?: number;
  contextBoost?: number;
  contextReasons?: string[];
  inPlaylist?: boolean;
  playlistMatchCount?: number;
  artistInLibrary?: boolean;
  artistInPlaylist?: boolean;
};

export type ArtistSearchResult = SearchContextAnnotations & {
  type: "artist";
  source: "brainzmash" | "library";
  id: string;
  key: string;
  name: string;
  sortName: string;
  canonicalId?: string | null;
  inLibrary: boolean;
  hasMbid: boolean;
  score: number;
  libraryBoostEligible?: boolean;
};

type AlbumSearchResult = SearchContextAnnotations & {
  type: "album";
  source: "brainzmash" | "library";
  id: string | null;
  key: string;
  title: string;
  artistName: string;
  artistMbid: string | null;
  canonicalId?: string;
  albumMbid?: string | null;
  releaseDate?: string | null;
  status?: "available";
  primaryType?: string | null;
  secondaryTypes?: string[];
  coverUrl?: string | null;
  inLibrary: boolean;
  score: number;
};

export type TrackSearchResult = SearchContextAnnotations & {
  type: "track";
  source: "library";
  id: string;
  key: string;
  title: string;
  artistName: string;
  albumTitle: string | null;
  albumMbid: string | null;
  albumCanonicalId: string | null;
  streamPath: string | null;
  trackMbid?: string | null;
  artistMbid?: string | null;
  inLibrary: boolean;
  score: number;
};

export type UnifiedSearchItem = ArtistSearchResult | AlbumSearchResult | TrackSearchResult;

type UnifiedSearchResponse = {
  query: string;
  mode: "suggest" | "full";
  top: UnifiedSearchItem | null;
  catalog: BrainzmashCatalog;
  localSearchConfigured: boolean;
  filters: string[];
};

type SearchContextIndex = {
  libraryArtistIds: Set<string>;
  libraryArtistNames: Set<string>;
  libraryTrackCoreKeys: Set<string>;
  libraryTrackFullKeys: Set<string>;
  playlistArtistIds: Map<string, number>;
  playlistArtistNames: Map<string, number>;
  playlistAlbumIds: Map<string, number>;
  playlistAlbumKeys: Map<string, number>;
  playlistTrackIds: Map<string, number>;
  playlistTrackCoreKeys: Map<string, number>;
  playlistTrackFullKeys: Map<string, number>;
};

type SearchItemLike = {
  type?: string;
  id?: string | number | null;
  mbid?: string | null;
  foreignArtistId?: string | null;
  artistMbid?: string | null;
  artistId?: string | null;
  artistName?: string | null;
  artist?: string | null;
  name?: string | null;
  canonicalId?: string | null;
  identityKey?: string | null;
  title?: string | null;
  trackName?: string | null;
  trackMbid?: string | null;
  recordingMbid?: string | null;
  album?: string | null;
  albumName?: string | null;
  albumTitle?: string | null;
  albumMbid?: string | null;
  albumId?: string | null;
  albumCanonicalId?: string | null;
  albumArtist?: string | null;
  releaseGroupMbid?: string | null;
  releaseDate?: string | null;
  streamPath?: string | null;
};

type PlaylistLike = { tracks?: SearchItemLike[] };

type SearchContext = {
  playlists: PlaylistLike[];
  artists: SearchItemLike[];
  tracks: SearchItemLike[];
  index: SearchContextIndex;
};

type SearchUser = RequestUser | null;

type BrainzmashCatalog = {
  artists: ArtistSearchResult[];
  albums: AlbumSearchResult[];
  tracks: TrackSearchResult[];
};

const EMPTY_SEARCH_CONTEXT: SearchContext = {
  playlists: [],
  artists: [],
  tracks: [],
  index: {
    libraryArtistIds: new Set(),
    libraryArtistNames: new Set(),
    libraryTrackCoreKeys: new Set(),
    libraryTrackFullKeys: new Set(),
    playlistArtistIds: new Map(),
    playlistArtistNames: new Map(),
    playlistAlbumIds: new Map(),
    playlistAlbumKeys: new Map(),
    playlistTrackIds: new Map(),
    playlistTrackCoreKeys: new Map(),
    playlistTrackFullKeys: new Map(),
  },
};

function scorePlaylistContentMatch(query: string, text: string | null | undefined) {
  const normalizedQuery = getNormalizedText(query);
  const normalizedText = getNormalizedText(text);
  if (!normalizedQuery || !normalizedText) return 0;
  if (normalizedQuery === normalizedText) return 100;
  if (normalizedText.includes(normalizedQuery)) return 92;
  return 0;
}

function normalizeKey(value: unknown) {
  return getNormalizedText(value);
}

function addCount(map: Map<string, number>, key: string | null | undefined, increment = 1) {
  if (!key) return;
  map.set(key, (map.get(key) || 0) + increment);
}

function hasSetValue(set: Set<string>, value: unknown) {
  const key = String(value || "").trim();
  return Boolean(key && set.has(key));
}

function getCount(map: Map<string, number>, value: unknown) {
  const key = String(value || "").trim();
  return key ? map.get(key) || 0 : 0;
}

function getNormalizedCount(map: Map<string, number>, value: unknown) {
  return getCount(map, normalizeKey(value));
}

function buildCoreTrackKey(
  artistName: string | null | undefined,
  title: string | null | undefined,
) {
  const artistKey = normalizeKey(artistName);
  const titleKey = normalizeKey(title);
  if (!artistKey || !titleKey) return "";
  return `${artistKey}\u0001${titleKey}`;
}

function buildFullTrackKey(
  artistName: string | null | undefined,
  title: string | null | undefined,
  albumTitle: string | null | undefined,
) {
  const coreKey = buildCoreTrackKey(artistName, title);
  const albumKey = normalizeKey(albumTitle);
  if (!coreKey || !albumKey) return "";
  return `${coreKey}\u0001${albumKey}`;
}

function buildAlbumKey(
  artistName: string | null | undefined,
  albumTitle: string | null | undefined,
) {
  const artistKey = normalizeKey(artistName);
  const albumKey = normalizeKey(albumTitle);
  if (!artistKey || !albumKey) return "";
  return `${artistKey}\u0001${albumKey}`;
}

function addArtistToIndex(
  index: SearchContextIndex,
  artist: SearchItemLike,
  target: "library" | "playlist" = "library",
) {
  const id = String(
    artist?.mbid || artist?.foreignArtistId || artist?.artistMbid || artist?.id || "",
  ).trim();
  const name = String(artist?.artistName || artist?.name || artist?.artist || "").trim();

  if (target === "library") {
    if (id) index.libraryArtistIds.add(id);
    const nameKey = normalizeKey(name);
    if (nameKey) index.libraryArtistNames.add(nameKey);
    return;
  }

  if (id) addCount(index.playlistArtistIds, id);
  addCount(index.playlistArtistNames, normalizeKey(name));
}

function dedupeSearchArtists<T extends SearchItemLike>(artists: T[]): T[] {
  const seen = new Set();
  return (Array.isArray(artists) ? artists : []).filter((artist) => {
    const stableField = (
      ["canonicalId", "id", "mbid", "foreignArtistId", "artistMbid", "identityKey"] as const
    ).find((field) => String(artist?.[field] ?? "").trim());
    if (!stableField) return true;
    const key = `${stableField}:${String(artist[stableField]).trim()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function addPlaylistTrackToIndex(index: SearchContextIndex, track: SearchItemLike) {
  const artistName = String(track?.artistName || track?.artist || "").trim();
  const title = String(track?.trackName || track?.title || track?.name || "").trim();
  const albumTitle = String(track?.albumName || track?.albumTitle || track?.album || "").trim();
  const artistMbid = String(track?.artistMbid || track?.artistId || "").trim();
  const albumMbid = String(
    track?.albumMbid || track?.releaseGroupMbid || track?.albumId || "",
  ).trim();
  const trackMbid = String(track?.trackMbid || track?.recordingMbid || track?.id || "").trim();

  addArtistToIndex(index, { id: artistMbid, name: artistName }, "playlist");
  if (albumMbid) addCount(index.playlistAlbumIds, albumMbid);
  addCount(index.playlistAlbumKeys, buildAlbumKey(artistName, albumTitle));
  if (trackMbid) addCount(index.playlistTrackIds, trackMbid);
  addCount(index.playlistTrackCoreKeys, buildCoreTrackKey(artistName, title));
  addCount(index.playlistTrackFullKeys, buildFullTrackKey(artistName, title, albumTitle));
}

function addLibraryTrackToIndex(index: SearchContextIndex, track: SearchItemLike) {
  const artistName = String(track?.artist || track?.artistName || "").trim();
  const title = String(track?.title || track?.trackName || "").trim();
  const albumTitle = String(track?.album || track?.albumTitle || "").trim();

  index.libraryTrackCoreKeys.add(buildCoreTrackKey(artistName, title));
  const fullKey = buildFullTrackKey(artistName, title, albumTitle);
  if (fullKey) index.libraryTrackFullKeys.add(fullKey);
}

export function buildSearchContextIndex({
  playlists = [],
  artists = [],
  tracks = [],
}: {
  playlists?: PlaylistLike[];
  artists?: SearchItemLike[];
  tracks?: SearchItemLike[];
} = {}): SearchContextIndex {
  const index: SearchContextIndex = {
    libraryArtistIds: new Set(),
    libraryArtistNames: new Set(),
    libraryTrackCoreKeys: new Set(),
    libraryTrackFullKeys: new Set(),
    playlistArtistIds: new Map(),
    playlistArtistNames: new Map(),
    playlistAlbumIds: new Map(),
    playlistAlbumKeys: new Map(),
    playlistTrackIds: new Map(),
    playlistTrackCoreKeys: new Map(),
    playlistTrackFullKeys: new Map(),
  };

  for (const artist of Array.isArray(artists) ? artists : []) {
    addArtistToIndex(index, artist, "library");
  }

  for (const track of Array.isArray(tracks) ? tracks : []) {
    addLibraryTrackToIndex(index, track);
  }

  for (const playlist of Array.isArray(playlists) ? playlists : []) {
    for (const track of Array.isArray(playlist?.tracks) ? playlist.tracks : []) {
      addPlaylistTrackToIndex(index, track);
    }
  }

  index.libraryTrackCoreKeys.delete("");
  index.libraryTrackFullKeys.delete("");
  return index;
}

function isArtistInLibrary(item: SearchItemLike | null | undefined, index: SearchContextIndex) {
  return (
    hasSetValue(index.libraryArtistIds, item?.id || item?.artistMbid) ||
    index.libraryArtistNames.has(normalizeKey(item?.name || item?.artistName))
  );
}

function getPlaylistArtistMatchCount(
  item: SearchItemLike | null | undefined,
  index: SearchContextIndex,
) {
  return (
    getCount(index.playlistArtistIds, item?.id || item?.artistMbid) +
    getNormalizedCount(index.playlistArtistNames, item?.name || item?.artistName)
  );
}

function getPrimarySearchText(item: SearchItemLike | null | undefined) {
  if (item?.type === "artist") return item.name || item.artistName || "";
  if (item?.type === "album") return item.title || "";
  if (item?.type === "track") return item.title || "";
  if (item?.type === "playlist") return item.name || "";
  return "";
}

function annotateSearchItem<T extends UnifiedSearchItem>(
  item: T,
  query: string,
  context: SearchContext = EMPTY_SEARCH_CONTEXT,
): T {
  if (!item || typeof item !== "object") return item;
  const index = context.index || EMPTY_SEARCH_CONTEXT.index;
  const next = { ...item };
  const primaryMatchScore = scoreTextMatch(query, getPrimarySearchText(next));
  if (primaryMatchScore > 0) {
    next.primaryMatchScore = Math.max(Number(next.primaryMatchScore || 0), primaryMatchScore);
  }
  const baseContextBoost = Number(next.contextBoost || 0);
  let contextBoost = Number.isFinite(baseContextBoost) ? baseContextBoost : 0;
  const contextReasons = Array.isArray(next.contextReasons) ? [...next.contextReasons] : [];

  const addBoost = (amount: number, reason: string) => {
    if (!Number.isFinite(amount) || amount <= 0) return;
    contextBoost += amount;
    if (reason && !contextReasons.includes(reason)) {
      contextReasons.push(reason);
    }
  };

  if (next.type === "artist") {
    const inLibrary = isArtistInLibrary(next, index);
    const playlistArtistCount = getPlaylistArtistMatchCount(next, index);
    const canPersonalizeArtist =
      next.libraryBoostEligible !== false ||
      scoreTextMatch(query, next.name) >= getLocalMatchThreshold(query);
    if (inLibrary) {
      next.inLibrary = true;
      if (canPersonalizeArtist) {
        addBoost(CONTEXT_BOOST.LIBRARY_ARTIST, "library_artist");
      }
    }
    if (playlistArtistCount > 0) {
      next.inPlaylist = true;
      next.playlistMatchCount = playlistArtistCount;
      if (canPersonalizeArtist) {
        addBoost(
          CONTEXT_BOOST.PLAYLIST_ARTIST + Math.min(playlistArtistCount, 8) * 4,
          "playlist_artist",
        );
      }
    }
  }

  if (next.type === "album") {
    const artistInLibrary = isArtistInLibrary(
      { id: next.artistMbid, name: next.artistName },
      index,
    );
    const playlistArtistCount = getPlaylistArtistMatchCount(
      { id: next.artistMbid, name: next.artistName },
      index,
    );
    const playlistAlbumCount =
      getCount(index.playlistAlbumIds, next.id || next.albumMbid) +
      getCount(index.playlistAlbumIds, next.albumMbid) +
      getCount(index.playlistAlbumKeys, buildAlbumKey(next.artistName, next.title));

    if (artistInLibrary) {
      next.artistInLibrary = true;
      addBoost(CONTEXT_BOOST.LIBRARY_ARTIST, "library_artist");
    }
    if (playlistArtistCount > 0) {
      next.artistInPlaylist = true;
      addBoost(CONTEXT_BOOST.PLAYLIST_ARTIST, "playlist_artist");
    }
    if (playlistAlbumCount > 0) {
      next.inPlaylist = true;
      next.playlistMatchCount = playlistAlbumCount;
      addBoost(CONTEXT_BOOST.PLAYLIST_ALBUM, "playlist_album");
    }
    if (artistInLibrary && scoreTextMatch(query, next.title) >= 92) {
      addBoost(CONTEXT_BOOST.EXACT_TITLE_WITH_LIBRARY_ARTIST, "exact_title_library_artist");
    }
  }

  if (next.type === "track") {
    const artistInLibrary = isArtistInLibrary(
      { id: next.artistMbid, name: next.artistName },
      index,
    );
    const artistPlaylistCount = getPlaylistArtistMatchCount(
      { id: next.artistMbid, name: next.artistName },
      index,
    );
    const coreTrackKey = buildCoreTrackKey(next.artistName, next.title);
    const fullTrackKey = buildFullTrackKey(next.artistName, next.title, next.albumTitle);
    const playlistTrackCount =
      getCount(index.playlistTrackIds, next.id || next.trackMbid) +
      getCount(index.playlistTrackIds, next.trackMbid) +
      getCount(index.playlistTrackFullKeys, fullTrackKey);
    const fuzzyPlaylistTrackCount = getCount(index.playlistTrackCoreKeys, coreTrackKey);
    const libraryTrackMatch =
      index.libraryTrackCoreKeys.has(coreTrackKey) ||
      (fullTrackKey && index.libraryTrackFullKeys.has(fullTrackKey));
    const playlistAlbumCount =
      getCount(index.playlistAlbumIds, next.albumMbid) +
      getCount(index.playlistAlbumKeys, buildAlbumKey(next.artistName, next.albumTitle));

    if (libraryTrackMatch) {
      next.inLibrary = true;
      addBoost(CONTEXT_BOOST.LIBRARY_TRACK, "library_track");
    }
    if (artistInLibrary) {
      next.artistInLibrary = true;
      addBoost(CONTEXT_BOOST.LIBRARY_ARTIST, "library_artist");
    }
    if (playlistTrackCount > 0 || fuzzyPlaylistTrackCount > 0) {
      const exactCount = playlistTrackCount || 0;
      const fuzzyCount = Math.max(0, fuzzyPlaylistTrackCount - exactCount);
      const totalCount = exactCount + fuzzyCount;
      next.inPlaylist = true;
      next.playlistMatchCount = totalCount;
      addBoost(
        (exactCount > 0 ? CONTEXT_BOOST.PLAYLIST_TRACK : CONTEXT_BOOST.PLAYLIST_TRACK_FUZZY) +
          Math.min(totalCount, 8) * 5,
        exactCount > 0 ? "playlist_track" : "playlist_track_fuzzy",
      );
    } else if (playlistAlbumCount > 0) {
      next.inPlaylist = true;
      next.playlistMatchCount = playlistAlbumCount;
      addBoost(CONTEXT_BOOST.PLAYLIST_ALBUM, "playlist_album");
    } else if (artistPlaylistCount > 0) {
      next.artistInPlaylist = true;
      addBoost(CONTEXT_BOOST.PLAYLIST_ARTIST, "playlist_artist");
    }
    if (artistInLibrary && scoreTextMatch(query, next.title) >= 92) {
      addBoost(CONTEXT_BOOST.EXACT_TITLE_WITH_LIBRARY_ARTIST, "exact_title_library_artist");
    }
  }

  if (contextBoost > 0) {
    next.contextBoost = contextBoost;
    next.contextReasons = contextReasons;
  }
  return next;
}

function sliceCatalogItems<T>(items: T[] | null | undefined, limit = FULL_LIMIT): T[] {
  return (Array.isArray(items) ? items : []).filter(Boolean).slice(0, limit);
}

export function applyCatalogSearchContext(
  rawCatalog: Partial<BrainzmashCatalog> | null | undefined,
  query: string,
  context: SearchContext = EMPTY_SEARCH_CONTEXT,
  limit = FULL_LIMIT,
) {
  const artists = (rawCatalog?.artists || []).map((artist) =>
    annotateSearchItem(artist, query, context),
  );
  const annotatedTracks = (rawCatalog?.tracks || []).map((track) =>
    annotateSearchItem(track, query, context),
  );
  const annotatedAlbums = (rawCatalog?.albums || []).map((album) =>
    annotateSearchItem(album, query, context),
  );

  return {
    artists: sliceCatalogItems(artists, limit),
    albums: sliceCatalogItems(annotatedAlbums, limit),
    tracks: sliceCatalogItems(annotatedTracks, limit),
  };
}

function pickCatalogTopFallback(catalog: Partial<BrainzmashCatalog> | null | undefined) {
  if (!catalog) return null;
  return catalog.artists?.[0] || catalog.albums?.[0] || catalog.tracks?.[0] || null;
}

function normalizeMode(value: unknown): "full" | "suggest" {
  return String(value || "").trim() === "full" ? "full" : "suggest";
}

function bucketLimit(mode: string, requestedLimit: unknown) {
  const fallback = mode === "full" ? FULL_LIMIT : SUGGEST_LIMIT;
  return Math.min(30, parsePositiveInt(requestedLimit, fallback));
}

function isCatalogSearchAvailable() {
  return Boolean(getMetadataBaseUrl());
}

function mapBrainzmashArtist(item: BrainzmashArtistItem & { score?: number }): ArtistSearchResult {
  return {
    type: "artist",
    source: "brainzmash",
    id: item.id,
    key: item.id,
    name: item.name,
    sortName: item.sortName || item.name,
    inLibrary: false,
    hasMbid: Boolean(item.id),
    score: item.score || 0,
  };
}

function mapBrainzmashAlbum(item: BrainzmashAlbumItem): AlbumSearchResult {
  return {
    type: "album",
    source: "brainzmash",
    id: item.id,
    key: item.id,
    title: item.title || "Untitled Release",
    artistName: item.artistName || "Unknown Artist",
    artistMbid: item.artistId || null,
    primaryType: item.type || null,
    secondaryTypes: Array.isArray(item.secondaryTypes) ? item.secondaryTypes : [],
    releaseDate: item.releaseDate || null,
    coverUrl: item.coverUrl || null,
    inLibrary: false,
    score: item.score || 0,
  };
}

async function searchBrainzmashCatalog(
  query: string,
  limit: number,
  signal: AbortSignal | undefined,
): Promise<BrainzmashCatalog> {
  const RELEVANCE_THRESHOLD = 60;
  const trimmed = String(query || "").trim();

  const [artistSettled, albumSettled] = await Promise.allSettled([
    searchArtists(trimmed, { limit, offset: 0, signal }),
    searchAlbums(trimmed, {
      limit,
      offset: 0,
      releaseTypes: [],
      sort: "relevance",
      signal,
    }),
  ]);
  signal?.throwIfAborted();

  const artistResult = artistSettled.status === "fulfilled" ? artistSettled.value : null;
  const albumResult = albumSettled.status === "fulfilled" ? albumSettled.value : null;

  if (artistSettled.status === "rejected") {
    console.warn("[UnifiedSearch] BrainzMash artist search failed:", artistSettled.reason?.message);
  }
  if (albumSettled.status === "rejected") {
    console.warn("[UnifiedSearch] BrainzMash album search failed:", albumSettled.reason?.message);
  }

  const scoredArtists = artistResult
    ? (artistResult.items || [])
        .map((artist) => ({
          artist,
          relevance: scoreTextMatch(trimmed, artist.name || ""),
        }))
        .filter((entry) => entry.relevance >= RELEVANCE_THRESHOLD)
        .sort((a, b) => b.relevance - a.relevance)
    : [];

  return {
    artists: scoredArtists.map((entry) => {
      const item = { ...entry.artist, score: entry.relevance };
      return mapBrainzmashArtist(item);
    }),
    albums: albumResult ? (albumResult.items || []).map(mapBrainzmashAlbum) : [],
    tracks: [],
  };
}

async function searchCatalog(query: string, limit: number, signal: AbortSignal | undefined) {
  const cacheKey = String(query || "")
    .trim()
    .toLowerCase();
  let catalog: BrainzmashCatalog | undefined = catalogSearchCache.get(cacheKey);
  if (!catalog) {
    catalog = await searchBrainzmashCatalog(query, 30, signal);
    catalogSearchCache.set(cacheKey, catalog);
  }
  const sliced = {
    artists: sliceCatalogItems(catalog.artists, limit),
    albums: sliceCatalogItems(catalog.albums, limit),
    tracks: sliceCatalogItems(catalog.tracks, limit),
  };
  return {
    ...sliced,
    top: pickCatalogTopFallback(sliced),
  };
}

function getVisiblePlaylistsForUser(user: SearchUser) {
  try {
    return user ? flowPlaylistConfig.getStaticPlaylistsForUser(user) : [];
  } catch (error) {
    console.warn("[UnifiedSearch] Failed to read playlists:", error.message);
    return [];
  }
}

function loadSearchContext(user: SearchUser): SearchContext {
  const playlists = getVisiblePlaylistsForUser(user);
  const artists = getCachedArtists();
  const context = {
    playlists,
    artists: Array.isArray(artists) ? artists : [],
    tracks: [],
  };
  return {
    ...context,
    index: buildSearchContextIndex(context),
  };
}

function getSearchContext(user: SearchUser): SearchContext {
  const cacheKey = user?.id || "anon";
  const cached = searchContextCache.get(cacheKey);
  if (cached) return cached;

  const context = loadSearchContext(user);
  searchContextCache.set(cacheKey, context);
  return context;
}

export function clearSearchContextCache() {
  searchContextCache.flushAll();
}

export function searchLocalFromData(
  query: string,
  {
    artists = [],
    albums = [],
    tracks = [],
  }: { artists?: SearchItemLike[]; albums?: SearchItemLike[]; tracks?: SearchItemLike[] } = {},
  limit = SUGGEST_LIMIT,
) {
  const normalizedQuery = getNormalizedText(query);
  if (!normalizedQuery) {
    return { artists: [], albums: [], tracks: [] };
  }

  const artistResults = dedupeSearchArtists(artists)
    .map((artist) => {
      const name = String(artist?.artistName || artist?.name || "").trim();
      const mbid =
        artist?.mbid || artist?.foreignArtistId || artist?.artistMbid || artist?.id || null;
      if (!name || !mbid) return null;
      const score = scorePlaylistContentMatch(query, name);
      if (score <= 0) return null;
      return {
        type: "artist" as const,
        source: "library" as const,
        id: mbid,
        canonicalId: artist?.canonicalId || null,
        key: `library-artist:${artist?.canonicalId || mbid}`,
        name,
        sortName: name,
        inLibrary: true,
        hasMbid: true,
        score,
      };
    })
    .filter(Boolean)
    .sort(compareSearchResults)
    .slice(0, limit);

  const albumResults = albums
    .map((album) => {
      const title = String(album?.title || "").trim();
      const artistName = String(album?.artistName || "").trim();
      if (!title || !album?.canonicalId) return null;
      const score = Math.max(
        scorePlaylistContentMatch(query, title),
        scorePlaylistContentMatch(query, artistName),
      );
      if (score <= 0) return null;
      return {
        type: "album" as const,
        source: "library" as const,
        id: album.releaseGroupMbid || null,
        canonicalId: album.canonicalId,
        key: `library-album:${album.canonicalId}`,
        title,
        artistName: artistName || "Unknown Artist",
        artistMbid: album.artistMbid || null,
        releaseDate: album.releaseDate || null,
        status: "available" as const,
        inLibrary: true,
        score,
      };
    })
    .filter(Boolean)
    .sort(compareSearchResults)
    .slice(0, limit);

  const trackResults = tracks
    .map((track) => {
      const title = String(track?.title || "").trim();
      const artistName = String(track?.artist || track?.artistName || "").trim();
      const albumTitle = String(track?.album || track?.albumTitle || "").trim();
      if (!title) return null;
      const score = Math.max(
        scorePlaylistContentMatch(query, artistName),
        scorePlaylistContentMatch(query, title),
        scorePlaylistContentMatch(query, `${artistName} ${title}`.trim()),
      );
      if (score <= 0) return null;
      return {
        type: "track" as const,
        source: "library" as const,
        id: track.id,
        key: track.id,
        title,
        artistName: artistName || "Unknown Artist",
        albumTitle: albumTitle || null,
        albumMbid: track.albumMbid || null,
        albumCanonicalId: track.albumCanonicalId || null,
        streamPath: track.streamPath || null,
        inLibrary: true,
        score,
      };
    })
    .filter(Boolean)
    .sort(compareSearchResults)
    .slice(0, limit);

  return {
    artists: artistResults,
    albums: albumResults,
    tracks: trackResults,
  };
}

type LibraryAlbumRow = NonNullable<
  ReturnType<typeof getLibrarySearchPage>["albums"]
>["albums"][number];

function searchLocalLibrary(query: string, limit: number, context: SearchContext) {
  const libraryResults = getLibrarySearchPage({
    source: "all",
    availableOnly: true,
    query,
    artistLimit: limit,
    albumLimit: limit,
    songLimit: limit,
  });
  const artists = dedupeSearchArtists([
    ...context.artists,
    ...(libraryResults.artists || []),
    ...(libraryResults.albums?.artists || []),
    ...(libraryResults.tracks?.artists || []),
  ]);
  const artistsById = new Map(artists.map((artist) => [String(artist.id), artist]));
  const albumsById = new Map(
    [...(libraryResults.albums?.albums || []), ...(libraryResults.tracks?.albums || [])].map(
      (album) => [String(album.id), album],
    ),
  );
  const describeAlbum = (album: LibraryAlbumRow) => {
    const artist = artistsById.get(String(album.artistId));
    return {
      canonicalId: String(album.id),
      title: album.title,
      artistName: artist?.name || album.albumArtist || "",
      artistMbid: artist?.mbid || null,
      releaseGroupMbid: album.releaseGroupMbid || null,
      releaseDate: album.releaseDate || null,
    };
  };
  const albums = (libraryResults.albums?.albums || []).map(describeAlbum);
  const tracks = (libraryResults.tracks?.tracks || []).map((track) => {
    const album = track.albums?.map((entry) => albumsById.get(String(entry.albumId))).find(Boolean);
    const albumDetails = album ? describeAlbum(album) : null;
    return {
      id: track.id,
      title: track.title,
      artistName: albumDetails?.artistName || track.artistName,
      albumTitle: albumDetails?.title || null,
      albumMbid: albumDetails?.releaseGroupMbid || null,
      albumCanonicalId: albumDetails?.canonicalId || null,
      streamPath: album
        ? `/library/canonical-stream/${encodeURIComponent(album.id)}/${encodeURIComponent(track.id)}`
        : null,
    };
  });
  return searchLocalFromData(
    query,
    {
      artists,
      albums,
      tracks: [...context.tracks, ...tracks],
    },
    limit,
  );
}

export function searchLibrary(
  query: string,
  { limit, user = null }: { limit?: number; user?: SearchUser } = {},
) {
  const trimmed = String(query || "").trim();
  if (!trimmed) {
    return { query: "", artists: [], albums: [], tracks: [] };
  }
  const perBucketLimit = bucketLimit("full", limit);
  return {
    query: trimmed,
    ...searchLocalLibrary(trimmed, perBucketLimit, getSearchContext(user)),
  };
}

function getSearchContextOrFallback(user: SearchUser): SearchContext {
  try {
    return getSearchContext(user);
  } catch (error) {
    console.warn("[UnifiedSearch] Local search context failed:", error.message);
    const playlists = getVisiblePlaylistsForUser(user);
    return {
      playlists,
      artists: [],
      tracks: [],
      index: buildSearchContextIndex({ playlists }),
    };
  }
}

export async function searchUnified(
  query: string,
  {
    mode = "suggest",
    limit,
    user = null,
    signal,
  }: { mode?: string; limit?: number; user?: SearchUser; signal?: AbortSignal } = {},
): Promise<UnifiedSearchResponse> {
  const trimmed = String(query || "").trim();
  const normalizedMode = normalizeMode(mode);
  const perBucketLimit = bucketLimit(normalizedMode, limit);
  const catalogSearchConfigured = isCatalogSearchAvailable();

  if (!trimmed) {
    return {
      query: "",
      mode: normalizedMode,
      top: null,
      catalog: { artists: [], albums: [], tracks: [] },
      localSearchConfigured: catalogSearchConfigured,
      filters: ["all", "artists", "albums", "singles"],
    };
  }

  const cacheKey = `${normalizedMode}:${perBucketLimit}:${trimmed.toLowerCase()}:${user?.id || "anon"}`;
  const cached = unifiedSearchCache.get(cacheKey);
  if (cached) return cached;

  const fetchedCatalog = await searchCatalog(trimmed, perBucketLimit, signal);
  const context = getSearchContextOrFallback(user);
  const catalog = applyCatalogSearchContext(fetchedCatalog, trimmed, context, perBucketLimit);
  const rawTop = fetchedCatalog?.top || pickCatalogTopFallback(catalog);
  const top = rawTop ? annotateSearchItem(rawTop, trimmed, context) : null;

  const response = {
    query: trimmed,
    mode: normalizedMode,
    top: top?.type ? top : null,
    catalog,
    localSearchConfigured: catalogSearchConfigured,
    filters: ["all", "artists", "albums", "singles"],
  };

  unifiedSearchCache.set(cacheKey, response);
  return response;
}

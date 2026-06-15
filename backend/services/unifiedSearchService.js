import NodeCache from "node-cache";
import {
  getNormalizedText,
  scoreTextMatch,
} from "./providers/brainzmashRanking.js";
import { getMetadataBaseUrl } from "./providers/brainzmashProvider.js";
import { searchAlbums, searchArtists } from "./metadataProvider.js";
import {
  isRemoteSearchConfigured,
  searchRemoteCatalog,
} from "./aurralSearchClient.js";
import { flowPlaylistConfig } from "./weeklyFlowPlaylistConfig.js";
import { getCachedArtists } from "./libraryManager.js";
import { getDiscoveryCache } from "./discoveryService.js";
import { compareSearchResults, getLocalMatchThreshold } from "./searchRanking.js";

const unifiedSearchCache = new NodeCache({
  stdTTL: 60,
  checkperiod: 30,
  maxKeys: 500,
});

const SUGGEST_LIMIT = 5;
const FULL_LIMIT = 20;
const SEARCH_CONTEXT_TTL_SECONDS = 45;
const CONTEXT_BOOST = {
  LIBRARY_TRACK: 420,
  PLAYLIST_TRACK: 360,
  PLAYLIST_TRACK_FUZZY: 220,
  PLAYLIST_ALBUM: 150,
  LIBRARY_ARTIST: 80,
  PLAYLIST_ARTIST: 48,
  EXACT_TITLE_WITH_LIBRARY_ARTIST: 36,
};

const searchContextCache = new NodeCache({
  stdTTL: SEARCH_CONTEXT_TTL_SECONDS,
  checkperiod: 30,
  maxKeys: 200,
  useClones: false,
});

const EMPTY_SEARCH_CONTEXT = {
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

function isLocalMatch(score, query) {
  return Number(score) > getLocalMatchThreshold(query);
}

function scorePlaylistContentMatch(query, text) {
  const normalizedQuery = getNormalizedText(query);
  const normalizedText = getNormalizedText(text);
  if (!normalizedQuery || !normalizedText) return 0;
  if (normalizedQuery === normalizedText) return 100;
  if (normalizedText.includes(normalizedQuery)) return 92;
  return 0;
}

function scorePlaylistTrackMatch(query, track) {
  const artistName = track?.artistName || track?.artist || "";
  const trackTitle = track?.trackName || track?.title || "";
  return Math.max(
    scorePlaylistContentMatch(query, artistName),
    scorePlaylistContentMatch(query, trackTitle),
  );
}

function normalizeKey(value) {
  return getNormalizedText(value);
}

function addCount(map, key, increment = 1) {
  if (!key) return;
  map.set(key, (map.get(key) || 0) + increment);
}

function hasSetValue(set, value) {
  const key = String(value || "").trim();
  return Boolean(key && set.has(key));
}

function getCount(map, value) {
  const key = String(value || "").trim();
  return key ? map.get(key) || 0 : 0;
}

function getNormalizedCount(map, value) {
  return getCount(map, normalizeKey(value));
}

function buildCoreTrackKey(artistName, title) {
  const artistKey = normalizeKey(artistName);
  const titleKey = normalizeKey(title);
  if (!artistKey || !titleKey) return "";
  return `${artistKey}\u0001${titleKey}`;
}

function buildFullTrackKey(artistName, title, albumTitle) {
  const coreKey = buildCoreTrackKey(artistName, title);
  const albumKey = normalizeKey(albumTitle);
  if (!coreKey || !albumKey) return "";
  return `${coreKey}\u0001${albumKey}`;
}

function buildAlbumKey(artistName, albumTitle) {
  const artistKey = normalizeKey(artistName);
  const albumKey = normalizeKey(albumTitle);
  if (!artistKey || !albumKey) return "";
  return `${artistKey}\u0001${albumKey}`;
}

function addArtistToIndex(index, artist, target = "library") {
  const id = String(
    artist?.mbid || artist?.foreignArtistId || artist?.artistMbid || artist?.id || "",
  ).trim();
  const name = String(
    artist?.artistName || artist?.name || artist?.artist || "",
  ).trim();

  if (target === "library") {
    if (id) index.libraryArtistIds.add(id);
    const nameKey = normalizeKey(name);
    if (nameKey) index.libraryArtistNames.add(nameKey);
    return;
  }

  if (id) addCount(index.playlistArtistIds, id);
  addCount(index.playlistArtistNames, normalizeKey(name));
}

function addPlaylistTrackToIndex(index, track) {
  const artistName = String(track?.artistName || track?.artist || "").trim();
  const title = String(track?.trackName || track?.title || track?.name || "").trim();
  const albumTitle = String(track?.albumName || track?.albumTitle || track?.album || "").trim();
  const artistMbid = String(track?.artistMbid || track?.artistId || "").trim();
  const albumMbid = String(track?.albumMbid || track?.releaseGroupMbid || track?.albumId || "").trim();
  const trackMbid = String(track?.trackMbid || track?.recordingMbid || track?.id || "").trim();

  addArtistToIndex(index, { id: artistMbid, name: artistName }, "playlist");
  if (albumMbid) addCount(index.playlistAlbumIds, albumMbid);
  addCount(index.playlistAlbumKeys, buildAlbumKey(artistName, albumTitle));
  if (trackMbid) addCount(index.playlistTrackIds, trackMbid);
  addCount(index.playlistTrackCoreKeys, buildCoreTrackKey(artistName, title));
  addCount(index.playlistTrackFullKeys, buildFullTrackKey(artistName, title, albumTitle));
}

function addLibraryTrackToIndex(index, track) {
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
} = {}) {
  const index = {
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

function isArtistInLibrary(item, index) {
  return (
    hasSetValue(index.libraryArtistIds, item?.id || item?.artistMbid) ||
    index.libraryArtistNames.has(normalizeKey(item?.name || item?.artistName))
  );
}

function getPlaylistArtistMatchCount(item, index) {
  return (
    getCount(index.playlistArtistIds, item?.id || item?.artistMbid) +
    getNormalizedCount(index.playlistArtistNames, item?.name || item?.artistName)
  );
}

function getPrimarySearchText(item) {
  if (item?.type === "artist") return item.name || item.artistName || "";
  if (item?.type === "album") return item.title || "";
  if (item?.type === "track") return item.title || "";
  if (item?.type === "playlist") return item.name || "";
  return "";
}

function annotateSearchItem(item, query, context = EMPTY_SEARCH_CONTEXT) {
  if (!item || typeof item !== "object") return item;
  const index = context.index || EMPTY_SEARCH_CONTEXT.index;
  const next = { ...item };
  const primaryMatchScore = scoreTextMatch(query, getPrimarySearchText(next));
  if (primaryMatchScore > 0) {
    next.primaryMatchScore = Math.max(
      Number(next.primaryMatchScore || 0),
      primaryMatchScore,
    );
  }
  const baseContextBoost = Number(next.contextBoost || 0);
  let contextBoost = Number.isFinite(baseContextBoost) ? baseContextBoost : 0;
  const contextReasons = Array.isArray(next.contextReasons)
    ? [...next.contextReasons]
    : [];

  const addBoost = (amount, reason) => {
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
      addBoost(
        CONTEXT_BOOST.EXACT_TITLE_WITH_LIBRARY_ARTIST,
        "exact_title_library_artist",
      );
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
    const fullTrackKey = buildFullTrackKey(
      next.artistName,
      next.title,
      next.albumTitle,
    );
    const playlistTrackCount =
      getCount(index.playlistTrackIds, next.id || next.trackMbid) +
      getCount(index.playlistTrackIds, next.trackMbid) +
      getCount(index.playlistTrackFullKeys, fullTrackKey);
    const fuzzyPlaylistTrackCount = getCount(
      index.playlistTrackCoreKeys,
      coreTrackKey,
    );
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
        (exactCount > 0
          ? CONTEXT_BOOST.PLAYLIST_TRACK
          : CONTEXT_BOOST.PLAYLIST_TRACK_FUZZY) +
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
      addBoost(
        CONTEXT_BOOST.EXACT_TITLE_WITH_LIBRARY_ARTIST,
        "exact_title_library_artist",
      );
    }
  }

  if (contextBoost > 0) {
    next.contextBoost = contextBoost;
    next.contextReasons = contextReasons;
  }
  return next;
}

function sliceCatalogItems(items, limit = FULL_LIMIT) {
  return (Array.isArray(items) ? items : []).filter(Boolean).slice(0, limit);
}

export function applyCatalogSearchContext(
  rawCatalog,
  query,
  context = EMPTY_SEARCH_CONTEXT,
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

function pickCatalogTopFallback(catalog) {
  if (!catalog) return null;
  return catalog.artists?.[0] || catalog.albums?.[0] || catalog.tracks?.[0] || null;
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeMode(value) {
  return String(value || "").trim() === "full" ? "full" : "suggest";
}

function bucketLimit(mode, requestedLimit) {
  const fallback = mode === "full" ? FULL_LIMIT : SUGGEST_LIMIT;
  return Math.min(30, parsePositiveInt(requestedLimit, fallback));
}

function isCatalogSearchAvailable() {
  return isRemoteSearchConfigured() || Boolean(getMetadataBaseUrl());
}

function mapBrainzmashArtist(item) {
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

function mapBrainzmashAlbum(item) {
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

async function searchBrainzmashCatalog(query, limit) {
  const trimmed = String(query || "").trim();
  try {
    const [artistResult, albumResult] = await Promise.all([
      searchArtists(trimmed, { limit, offset: 0 }),
      searchAlbums(trimmed, {
        limit,
        offset: 0,
        releaseTypes: [],
        sort: "relevance",
      }),
    ]);
    return {
      artists: (artistResult.items || []).map(mapBrainzmashArtist),
      albums: (albumResult.items || []).map(mapBrainzmashAlbum),
      tracks: [],
    };
  } catch (error) {
    console.warn("[UnifiedSearch] BrainzMash catalog fallback failed:", error.message);
    return { artists: [], albums: [], tracks: [] };
  }
}

async function searchCatalog(query, { mode, limit }) {
  if (isRemoteSearchConfigured()) {
    const remoteCatalog = await searchRemoteCatalog(query, { mode, limit });
    if (remoteCatalog) {
      const hasResults =
        remoteCatalog.artists.length > 0 ||
        remoteCatalog.albums.length > 0 ||
        remoteCatalog.tracks.length > 0;
      if (hasResults) {
        return {
          top: remoteCatalog.top || null,
          artists: remoteCatalog.artists,
          albums: remoteCatalog.albums,
          tracks: remoteCatalog.tracks,
        };
      }
    }
  }
  const catalog = await searchBrainzmashCatalog(query, limit);
  return {
    ...catalog,
    top: pickCatalogTopFallback(catalog),
  };
}

function getDiscoverPlaylistsForSearch(user) {
  try {
    const cache = user ? getDiscoveryCache(user) : getDiscoveryCache();
    return (Array.isArray(cache?.discoverPlaylists) ? cache.discoverPlaylists : [])
      .map((playlist) => {
        const presetId = String(playlist?.presetId || playlist?.id || "").trim();
        const name = String(playlist?.name || "").trim();
        if (!presetId || !name) return null;
        const tracks = Array.isArray(playlist?.tracks) ? playlist.tracks : [];
        return {
          id: playlist.adoptedPlaylistId || `discover:${presetId}`,
          name,
          tracks,
          trackCount: tracks.length,
          discoverPresetId: presetId,
          sourceFlowId: playlist.adoptedFlowId || null,
          isDiscoverPlaylist: !playlist.adoptedPlaylistId,
        };
      })
      .filter(Boolean);
  } catch (error) {
    console.warn(
      "[UnifiedSearch] Failed to read discover playlists:",
      error.message,
    );
    return [];
  }
}

function getAllPlaylistsForSearch(user) {
  const shared = getVisiblePlaylistsForUser(user);
  const discover = getDiscoverPlaylistsForSearch(user);
  const seen = new Set(shared.map((playlist) => playlist.id));
  return [
    ...shared,
    ...discover.filter((playlist) => !seen.has(playlist.id)),
  ];
}

function getVisiblePlaylistsForUser(user) {
  try {
    return user ? flowPlaylistConfig.getSharedPlaylistsForUser(user) : [];
  } catch (error) {
    console.warn("[UnifiedSearch] Failed to read playlists:", error.message);
    return [];
  }
}

function loadSearchContext(user) {
  const playlists = getAllPlaylistsForSearch(user);
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

function getSearchContext(user) {
  const cacheKey = user?.id || "anon";
  const cached = searchContextCache.get(cacheKey);
  if (cached) return cached;

  const context = loadSearchContext(user);
  searchContextCache.set(cacheKey, context);
  return context;
}

export function searchLocalFromData(
  query,
  { playlists = [], artists = [], tracks = [] } = {},
  limit = SUGGEST_LIMIT,
) {
  const normalizedQuery = getNormalizedText(query);
  if (!normalizedQuery) {
    return { artists: [], tracks: [], playlists: [] };
  }

  const playlistResults = playlists
    .map((playlist) => {
      const name = String(playlist?.name || "").trim();
      if (!name) return null;
      const trackScores = (Array.isArray(playlist?.tracks) ? playlist.tracks : [])
        .map((track) => scorePlaylistTrackMatch(query, track))
        .filter((score) => score > 0);
      const bestTrackScore = trackScores.length > 0 ? Math.max(...trackScores) : 0;
      const score = bestTrackScore;
      if (bestTrackScore <= 0) return null;
      if (!isLocalMatch(score, query)) return null;
      return {
        type: "playlist",
        source: playlist.isDiscoverPlaylist ? "discover" : "library",
        id: playlist.id,
        key: `playlist:${playlist.id}`,
        name,
        trackCount: Number(playlist?.trackCount || playlist?.tracks?.length || 0),
        discoverPresetId: playlist.discoverPresetId || null,
        sourceFlowId: playlist.sourceFlowId || null,
        score,
        inLibrary: !playlist.isDiscoverPlaylist,
      };
    })
    .filter(Boolean)
    .sort(compareSearchResults)
    .slice(0, limit);

  const artistResults = artists
    .map((artist) => {
      const name = String(artist?.artistName || artist?.name || "").trim();
      const mbid = artist?.mbid || artist?.foreignArtistId || null;
      if (!name || !mbid) return null;
      const score = scorePlaylistContentMatch(query, name);
      if (score <= 0) return null;
      return {
        type: "artist",
        source: "library",
        id: mbid,
        key: `library-artist:${mbid}`,
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
        type: "track",
        source: "library",
        id: track.id,
        key: track.id,
        title,
        artistName: artistName || "Unknown Artist",
        albumTitle: albumTitle || null,
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
    tracks: trackResults,
    playlists: playlistResults,
  };
}

async function searchLocalLibrary(query, limit, user) {
  try {
    const context = getSearchContext(user);
    return {
      context,
      library: searchLocalFromData(
        query,
        {
          playlists: context.playlists,
          artists: context.artists,
          tracks: context.tracks,
        },
        limit,
      ),
    };
  } catch (error) {
    console.warn("[UnifiedSearch] Local search context failed:", error.message);
    const playlists = getAllPlaylistsForSearch(user);
    const fallbackContext = {
      playlists,
      artists: [],
      tracks: [],
      index: buildSearchContextIndex({ playlists }),
    };
    return {
      context: fallbackContext,
      library: searchLocalFromData(query, { playlists }, limit),
    };
  }
}

export async function searchUnified(
  query,
  { mode = "suggest", limit, user = null } = {},
) {
  const trimmed = String(query || "").trim();
  const normalizedMode = normalizeMode(mode);
  const perBucketLimit = bucketLimit(normalizedMode, limit);
  const catalogSearchConfigured = isCatalogSearchAvailable();

  if (!trimmed) {
    return {
      query: "",
      mode: normalizedMode,
      top: null,
      library: { artists: [], tracks: [], playlists: [] },
      catalog: { artists: [], albums: [], tracks: [] },
      localSearchConfigured: catalogSearchConfigured,
      filters: ["all", "artists", "albums", "tracks", "playlists"],
    };
  }

  const cacheKey = `${normalizedMode}:${perBucketLimit}:${trimmed.toLowerCase()}:${user?.id || "anon"}`;
  const cached = unifiedSearchCache.get(cacheKey);
  if (cached) return cached;

  const [fetchedCatalog, local] = await Promise.all([
    searchCatalog(trimmed, {
      mode: normalizedMode,
      limit: perBucketLimit,
    }),
    searchLocalLibrary(trimmed, perBucketLimit, user),
  ]);
  const library = local?.library || { artists: [], tracks: [], playlists: [] };
  const context = local?.context || EMPTY_SEARCH_CONTEXT;
  const catalog = applyCatalogSearchContext(
    fetchedCatalog,
    trimmed,
    context,
    perBucketLimit,
  );
  const rawTop = fetchedCatalog?.top || pickCatalogTopFallback(catalog);
  const top = rawTop ? annotateSearchItem(rawTop, trimmed, context) : null;

  const response = {
    query: trimmed,
    mode: normalizedMode,
    top: top?.type ? top : null,
    library: {
      artists: [],
      tracks: library.tracks,
      playlists: library.playlists,
    },
    catalog,
    localSearchConfigured: catalogSearchConfigured,
    filters: ["all", "artists", "albums", "tracks", "playlists"],
  };

  unifiedSearchCache.set(cacheKey, response);
  return response;
}

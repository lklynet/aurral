import { hasPermission } from "../middleware/auth.ts";
import type { RequestUser } from "../middleware/requestUser.ts";
import createCache from "./apiClients/simpleCache.ts";
import { searchDeezerTracks } from "./apiClients/deezer.ts";
import { searchEditorialPlaylists } from "./importLists/deezerPlaylists.ts";
import { flowPlaylistConfig, type StaticPlaylist } from "./playlists/flowPlaylistConfig.ts";
import { buildCustomArtworkUrl, getCustomArtworkMap } from "./customArtworkService.ts";
import { selectBestArtistImage } from "./imageService.ts";
import { buildLibraryArtworkUrl, getLibraryArtworkVersions } from "./libraryArtwork.ts";
import { getLibraryArtistMbids, getLibrarySearchPage } from "./libraryQueryService.ts";
import { logger, safeLogDiagnostic } from "./logger.ts";
import { searchAlbums, searchArtists } from "./providers/brainzmashProvider.ts";
import { parsePositiveInt } from "./searchService.ts";
import {
  MATCH,
  albumSearchTexts,
  bestMatch,
  matchQuality,
  parseSearchQuery,
  searchDocument,
  searchKey,
  type MatchQuality,
  type SearchQuery,
} from "./searchText.ts";

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 30;
const CATALOG_WINDOW = 30;
const SONG_WINDOW = 10;
const DEEZER_PLAYLIST_LIMIT = 12;

const catalogCache = createCache(60, 200);

type ProviderArtist = Awaited<ReturnType<typeof searchArtists>>["items"][number];
type ProviderAlbum = Awaited<ReturnType<typeof searchAlbums>>["items"][number];
type DeezerTrack = Awaited<ReturnType<typeof searchDeezerTracks>>[number];

export type ArtistSearchResult = {
  type: "artist";
  source: "brainzmash" | "library";
  id: string;
  key: string;
  name: string;
  sortName: string;
  canonicalId?: string | null;
  image?: string | null;
  disambiguation?: string | null;
  inLibrary: boolean;
  hasMbid: boolean;
};

export type AlbumSearchResult = {
  type: "album";
  source: "brainzmash" | "library";
  id: string | null;
  key: string;
  title: string;
  artistName: string;
  artistMbid: string | null;
  canonicalId?: string;
  releaseDate?: string | null;
  status?: "available";
  primaryType?: string | null;
  secondaryTypes?: string[];
  coverUrl?: string | null;
  inLibrary: boolean;
};

export type TrackSearchResult = {
  type: "track";
  source: "library" | "deezer";
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
  releaseYear?: string | null;
  durationMs?: number | null;
  coverUrl?: string | null;
  deezerAlbumId?: string | null;
  inLibrary: boolean;
};

export type PlaylistSearchResult = {
  type: "playlist";
  source: "library" | "deezer";
  id: string;
  key: string;
  name: string;
  trackCount: number | null;
  sourceFlowId: string | null;
  coverUrl: string | null;
  trackMatch: { title: string; count: number } | null;
};

export type UnifiedSearchItem = ArtistSearchResult | AlbumSearchResult | TrackSearchResult;

type Ranked<T> = { item: T; quality: MatchQuality; popularity: number };

type Catalog = {
  top: UnifiedSearchItem | null;
  artists: ArtistSearchResult[];
  albums: AlbumSearchResult[];
  tracks: TrackSearchResult[];
};

const bucketLimit = (limit: unknown) => Math.min(MAX_LIMIT, parsePositiveInt(limit, DEFAULT_LIMIT));

const providerQuery = (query: string) => query.trim().replace(/\s+/g, " ").toLowerCase();

const releaseKey = (title: unknown) => searchKey(String(title ?? "").replace(/[([].*?[)\]]/g, ""));

function toArtist(item: ProviderArtist): ArtistSearchResult {
  return {
    type: "artist",
    source: "brainzmash",
    id: item.id,
    key: item.id,
    name: item.name,
    sortName: item.sortName || item.name,
    image: selectBestArtistImage(item.images)?.url || null,
    disambiguation: item.disambiguation || null,
    inLibrary: false,
    hasMbid: Boolean(item.id),
  };
}

function toAlbum(item: ProviderAlbum): AlbumSearchResult {
  return {
    type: "album",
    source: "brainzmash",
    id: item.id ?? null,
    key: item.id ?? "",
    title: item.title,
    artistName: item.artistName,
    artistMbid: item.artistId,
    primaryType: item.type || null,
    secondaryTypes: item.secondaryTypes,
    releaseDate: item.releaseDate,
    coverUrl: item.coverUrl,
    inLibrary: false,
  };
}

function toSong(
  track: DeezerTrack,
  artists: ArtistSearchResult[],
  albums: AlbumSearchResult[],
): TrackSearchResult {
  const artistName = track.artist?.name || "Unknown Artist";
  const artistKey = searchKey(artistName);
  const songKey = releaseKey(track.title_short || track.title);
  const albumKey = releaseKey(track.album?.title);
  const album = albums.find(
    (entry) =>
      entry.id &&
      searchKey(entry.artistName) === artistKey &&
      [albumKey, songKey].includes(releaseKey(entry.title)),
  );
  const artist = artists.find((entry) => searchKey(entry.name) === artistKey);
  return {
    type: "track",
    source: "deezer",
    id: `deezer:${track.id}`,
    key: `deezer:${track.id}`,
    title: track.title_short || track.title,
    artistName,
    albumTitle: track.album?.title || null,
    albumMbid: album?.id ?? null,
    albumCanonicalId: null,
    streamPath: null,
    artistMbid: album?.artistMbid || artist?.id || null,
    durationMs: track.duration ? track.duration * 1000 : null,
    coverUrl: track.album?.cover_medium || track.album?.cover_xl || null,
    deezerAlbumId: track.album?.id ? String(track.album.id) : null,
    inLibrary: false,
  };
}

const byRank = <T>(left: Ranked<T>, right: Ranked<T>) =>
  Number(right.quality >= MATCH.prefix) - Number(left.quality >= MATCH.prefix) ||
  Number(right.popularity > 0) - Number(left.popularity > 0) ||
  right.quality - left.quality;

function rankArtists(
  query: SearchQuery,
  artists: ProviderArtist[],
  popularity: Map<string, number>,
) {
  const names = new Set<string>();
  return artists
    .filter((artist) => !names.has(searchKey(artist.name)) && names.add(searchKey(artist.name)))
    .map((artist) => ({
      item: toArtist(artist),
      quality: bestMatch(query, artist.name, ...artist.aliases),
      popularity: popularity.get(searchKey(artist.name)) ?? 0,
    }))
    .filter(({ quality }) => quality > MATCH.none)
    .sort(byRank);
}

function rankAlbums(query: SearchQuery, albums: ProviderAlbum[], popularity: Map<string, number>) {
  return albums
    .map((album) => ({
      item: toAlbum(album),
      quality: bestMatch(query, ...albumSearchTexts(album)),
      popularity: popularity.get(searchKey(album.artistName)) ?? 0,
    }))
    .sort(
      (left, right) =>
        right.quality - left.quality || Number(right.popularity > 0) - Number(left.popularity > 0),
    );
}

function pickTop(
  query: SearchQuery,
  artists: Ranked<ArtistSearchResult>[],
  albums: Ranked<AlbumSearchResult>[],
  songs: Ranked<TrackSearchResult>[] | null,
): UnifiedSearchItem | null {
  const [artist] = artists;
  const [album] = albums;
  const [song] = songs ?? [];
  if (
    artist &&
    artist.quality >= MATCH.prefix &&
    (artist.popularity > 0 || (!songs && artist.quality === MATCH.exact))
  ) {
    return artist.item;
  }
  const exactAlbum = album?.quality === MATCH.exact ? album : null;
  if (song?.quality === MATCH.exact) {
    const albumIsBigger =
      exactAlbum &&
      exactAlbum.popularity > song.popularity &&
      searchKey(exactAlbum.item.artistName) !== searchKey(song.item.artistName);
    return albumIsBigger ? exactAlbum.item : song.item;
  }
  if (exactAlbum) return exactAlbum.item;
  if (artist && artist.quality >= MATCH.prefix) return artist.item;
  return artist?.item ?? album?.item ?? song?.item ?? null;
}

async function settle<T>(source: string, request: Promise<T>, signal: AbortSignal | undefined) {
  try {
    return await request;
  } catch (error) {
    signal?.throwIfAborted();
    logger.info("search", `${source} search failed`, { reason: safeLogDiagnostic(error) });
    return null;
  }
}

async function searchCatalog(text: string, signal: AbortSignal | undefined) {
  const query = parseSearchQuery(text);
  if (!query) return null;
  const [artistResult, albumResult, songResult] = await Promise.all([
    settle(
      "Artist",
      searchArtists(text, { limit: CATALOG_WINDOW, signal, throwOnFailure: true }),
      signal,
    ),
    settle(
      "Album",
      searchAlbums(text, {
        limit: CATALOG_WINDOW,
        signal,
        throwOnFailure: true,
        musicbrainzFallback: false,
      }),
      signal,
    ),
    settle("Song", searchDeezerTracks(text, { limit: SONG_WINDOW, signal }), signal),
  ]);
  const popularity = new Map<string, number>();
  for (const track of songResult ?? []) {
    const key = searchKey(track.artist?.name);
    popularity.set(key, Math.max(popularity.get(key) ?? 0, track.rank ?? 1));
  }
  const artists = rankArtists(query, artistResult?.items ?? [], popularity);
  const albums = rankAlbums(query, albumResult?.items ?? [], popularity);
  const songs = songResult
    ? songResult.map((track) => {
        const item = toSong(
          track,
          artists.map((entry) => entry.item),
          albums.map((entry) => entry.item),
        );
        return {
          item,
          quality: bestMatch(query, ...albumSearchTexts(item)),
          popularity: track.rank ?? 0,
        };
      })
    : null;
  const top = pickTop(query, artists, albums, songs);
  const [lead] = artists;
  const clearArtist = top === lead?.item && lead.quality === MATCH.exact && lead.popularity > 0;
  const catalog: Catalog = {
    top,
    artists: artists
      .filter((entry) => !clearArtist || entry.quality === MATCH.exact || entry.popularity > 0)
      .map(({ item }) => item),
    albums: albums.map(({ item }) => item),
    tracks: songs?.map(({ item }) => item) ?? [],
  };
  return {
    catalog,
    complete: Boolean(artistResult && albumResult && songResult),
    available: Boolean(artistResult && albumResult),
  };
}

function withLibraryArtists(catalog: Catalog, limit: number): Catalog {
  const artists = catalog.artists.slice(0, limit);
  const owned = getLibraryArtistMbids({
    source: "all",
    availableOnly: false,
    mbids: [...artists, catalog.top].flatMap((item) => (item?.type === "artist" ? [item.id] : [])),
  });
  const mark = <T extends UnifiedSearchItem | null>(item: T): T =>
    item?.type === "artist" && owned.has(item.id) ? { ...item, inLibrary: true } : item;
  return {
    top: mark(catalog.top),
    artists: artists.map(mark),
    albums: catalog.albums.slice(0, limit),
    tracks: catalog.tracks.slice(0, limit),
  };
}

export async function searchUnified(
  rawQuery: unknown,
  { limit, signal }: { limit?: unknown; signal?: AbortSignal } = {},
) {
  const query = providerQuery(String(rawQuery ?? ""));
  const perBucket = bucketLimit(limit);
  const respond = (catalog: Catalog, status: "ok" | "unavailable" = "ok") => ({
    query,
    status,
    ...withLibraryArtists(catalog, perBucket),
  });
  const cached: Catalog | undefined = catalogCache.get(query);
  if (cached) return respond(cached);
  const result = query ? await searchCatalog(query, signal) : null;
  if (!result) return respond({ top: null, artists: [], albums: [], tracks: [] });
  if (result.complete) catalogCache.set(query, result.catalog);
  return respond(result.catalog, result.available ? "ok" : "unavailable");
}

type LibraryPage = ReturnType<typeof getLibrarySearchPage>;
type LibraryAlbum = LibraryPage["albums"]["albums"][number];

const playlistTrackKeys = new WeakMap<StaticPlaylist, string[]>();

function findTrackMatch(query: SearchQuery, playlist: StaticPlaylist) {
  let keys = playlistTrackKeys.get(playlist);
  if (!keys) {
    keys = playlist.tracks.map((track) => searchDocument(track.artistName, track.trackName));
    playlistTrackKeys.set(playlist, keys);
  }
  let title: string | null = null;
  let count = 0;
  for (const [index, key] of keys.entries()) {
    if (!query.terms.every((term) => key.includes(term))) continue;
    title ??= playlist.tracks[index]?.trackName ?? null;
    count += 1;
  }
  return title ? { title, count } : null;
}

function searchPlaylists(
  text: string,
  user: RequestUser | undefined,
  limit: number,
): PlaylistSearchResult[] {
  const query = parseSearchQuery(text);
  if (!query || !hasPermission(user, "accessFlow")) return [];
  const minimum = query.key.length < 3 ? MATCH.prefix : MATCH.words;
  const hits: { quality: MatchQuality; item: PlaylistSearchResult }[] = [];
  for (const flow of flowPlaylistConfig.getFlowsForUser(user)) {
    const quality = matchQuality(query, flow.name);
    if (quality < minimum) continue;
    hits.push({
      quality,
      item: {
        type: "playlist",
        source: "library",
        id: flow.id,
        key: `flow:${flow.id}`,
        name: flow.name,
        trackCount: null,
        sourceFlowId: flow.id,
        coverUrl: null,
        trackMatch: null,
      },
    });
  }
  for (const playlist of flowPlaylistConfig.getStaticPlaylistsForUser(user)) {
    const quality = matchQuality(query, playlist.name);
    const nameMatches = quality >= minimum;
    const trackMatch =
      nameMatches || minimum === MATCH.prefix ? null : findTrackMatch(query, playlist);
    if (!nameMatches && !trackMatch) continue;
    hits.push({
      quality: nameMatches ? quality : MATCH.none,
      item: {
        type: "playlist",
        source: "library",
        id: playlist.id,
        key: `playlist:${playlist.id}`,
        name: playlist.name,
        trackCount: playlist.tracks.length,
        sourceFlowId: null,
        coverUrl: null,
        trackMatch,
      },
    });
  }
  return hits
    .sort((left, right) => right.quality - left.quality)
    .slice(0, limit)
    .map(({ item }) => item);
}

export async function searchDeezerPlaylists(rawQuery: unknown): Promise<PlaylistSearchResult[]> {
  const text = providerQuery(String(rawQuery ?? ""));
  const query = parseSearchQuery(text);
  if (!query) return [];
  return (await searchEditorialPlaylists(text))
    .map((playlist) => ({ playlist, quality: matchQuality(query, playlist.name) }))
    .filter(({ quality }) => quality > MATCH.none)
    .sort((left, right) => right.quality - left.quality)
    .slice(0, DEEZER_PLAYLIST_LIMIT)
    .map(({ playlist }) => ({
      type: "playlist",
      source: "deezer",
      id: playlist.id,
      key: `deezer-playlist:${playlist.id}`,
      name: playlist.name,
      trackCount: playlist.trackCount,
      sourceFlowId: null,
      coverUrl: playlist.artworkUrl,
      trackMatch: null,
    }));
}

export function searchLibrary(
  rawQuery: unknown,
  { limit, user }: { limit?: unknown; user?: RequestUser } = {},
) {
  const query = String(rawQuery ?? "").trim();
  const perBucket = bucketLimit(limit);
  if (!query) return { query, artists: [], albums: [], tracks: [], playlists: [] };
  const page = getLibrarySearchPage({
    source: "all",
    availableOnly: true,
    query,
    artistLimit: perBucket,
    albumLimit: perBucket,
    songLimit: perBucket,
  });
  const libraryArtists = new Map(
    [...page.artists, ...page.albums.artists, ...page.tracks.artists].map((artist) => [
      String(artist.id),
      artist,
    ]),
  );
  const describeAlbum = (album: LibraryAlbum) => {
    const artist = libraryArtists.get(String(album.artistId));
    return {
      canonicalId: String(album.id),
      title: album.title,
      artistName: artist?.name || album.albumArtist || "Unknown Artist",
      artistMbid: artist?.mbid || null,
      releaseGroupMbid: album.releaseGroupMbid || null,
      releaseDate: album.releaseDate || null,
    };
  };
  const albumsById = new Map(
    [...page.albums.albums, ...page.tracks.albums].map((album) => [String(album.id), album]),
  );
  const albumIds = [...albumsById.keys()];
  const albumVersions = getLibraryArtworkVersions("album", albumIds);
  const customAlbumArtwork = getCustomArtworkMap("album", albumIds);
  const artistVersions = getLibraryArtworkVersions(
    "artist",
    page.artists.map((artist) => artist.id),
  );
  const albumCover = (id: number | string) => {
    const custom = customAlbumArtwork.get(String(id));
    return custom
      ? buildCustomArtworkUrl("album", id, custom)
      : buildLibraryArtworkUrl("album", id, albumVersions.get(String(id)));
  };
  const artists: ArtistSearchResult[] = page.artists.map((artist) => ({
    type: "artist",
    source: "library",
    id: artist.mbid || String(artist.id),
    canonicalId: String(artist.id),
    key: `library-artist:${artist.id}`,
    name: artist.name,
    sortName: artist.sortName || artist.name,
    image: buildLibraryArtworkUrl("artist", artist.id, artistVersions.get(String(artist.id))),
    inLibrary: true,
    hasMbid: Boolean(artist.mbid),
  }));
  const albums: AlbumSearchResult[] = page.albums.albums.map((album) => {
    const details = describeAlbum(album);
    return {
      type: "album",
      source: "library",
      id: details.releaseGroupMbid,
      canonicalId: details.canonicalId,
      key: `library-album:${details.canonicalId}`,
      title: details.title,
      artistName: details.artistName,
      artistMbid: details.artistMbid,
      releaseDate: details.releaseDate,
      coverUrl: albumCover(album.id),
      status: "available",
      inLibrary: true,
    };
  });
  const tracks: TrackSearchResult[] = page.tracks.tracks.map((track) => {
    const album = track.albums
      ?.map((entry) => albumsById.get(String(entry.albumId)))
      .find((entry) => entry !== undefined);
    const details = album ? describeAlbum(album) : null;
    return {
      type: "track",
      source: "library",
      id: String(track.id),
      key: `library-track:${track.id}`,
      title: track.title,
      artistName: details?.artistName || track.artistName || "Unknown Artist",
      albumTitle: details?.title || null,
      albumMbid: details?.releaseGroupMbid || null,
      albumCanonicalId: details?.canonicalId || null,
      trackMbid: track.mbid || null,
      artistMbid: details?.artistMbid || null,
      durationMs: track.files?.find((file) => Number(file.durationMs) > 0)?.durationMs ?? null,
      releaseYear: String(details?.releaseDate || "").match(/^\d{4}/)?.[0] || null,
      coverUrl: album ? albumCover(album.id) : null,
      streamPath: album
        ? `/library/canonical-stream/${encodeURIComponent(album.id)}/${encodeURIComponent(track.id)}`
        : null,
      inLibrary: true,
    };
  });
  return { query, artists, albums, tracks, playlists: searchPlaylists(query, user, perBucket) };
}

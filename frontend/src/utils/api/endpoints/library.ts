import { parseResponse, type InferRequestType, type InferResponseType } from "hono/client";
import {
  apiFetchWithin,
  buildAuthenticatedApiUrl,
  resolveAuthenticatedApiAssetUrl,
} from "../core.ts";
import { libraryClient } from "../clients/library.ts";
import { libraryAlbumsClient } from "../clients/libraryAlbums.ts";
import { libraryArtistsClient } from "../clients/libraryArtists.ts";
import type { libraryArtworkClient } from "../clients/libraryArtwork.ts";
import { libraryDownloadsClient } from "../clients/libraryDownloads.ts";
import { libraryMiscClient } from "../clients/libraryMisc.ts";
import { libraryTracksClient } from "../clients/libraryTracks.ts";
import { bumpLibraryPageGeneration, queryClient, queryKeys } from "../../../queryClient.ts";
import { getLibraryOwnerConflict } from "../../libraryDestination.ts";
import type { buildAlbumRequestPayload, buildArtistAddPayload } from "../../libraryDestination.ts";
import type { buildAurralAlbumRetryPayload } from "../../aurralAlbumStatus.ts";
import {
  addActiveDownload,
  normalizeActiveDownloads,
  type ActiveDownloads,
} from "../../activeDownloads.ts";
import type { requestLibraryTrack } from "../../../../../backend/services/libraryTrackRequests.ts";

type SignalOptions = { signal?: AbortSignal };

type KeysOfUnion<T> = T extends unknown ? keyof T : never;
type WithAbsentKeys<T, All = T> = T extends object
  ? T & { [Key in Exclude<KeysOfUnion<All>, keyof T>]?: undefined }
  : T;

type LibraryPageOptions = {
  kind?: string;
  page?: number | string;
  pageSize?: number;
  query?: string;
  genre?: string;
  sort?: string;
  direction?: string;
  artistId?: string | number;
  albumId?: string | number;
  source?: string;
  availableOnly?: boolean | null;
};

type ArtworkEntity = {
  coverUrl?: string | null;
  defaultCoverUrl?: string | null;
  artworkUrl?: string | null;
  customArtworkUrl?: string | null;
};

type ArtistMonitoringInput = NonNullable<
  NonNullable<Parameters<typeof libraryArtistsClient.artists.$post>[0]>["json"]["monitoring"]
>;

type ActiveDownloadStart = {
  albumMbid?: string | null;
  artistMbid?: string | null;
  track?: { mbid: string | null; artistName?: string | null; trackName?: string | null };
};

export type LibraryPageResponse = InferResponseType<typeof libraryClient.canonical.$get, 200>;
export type LibraryFavoritesResponse = InferResponseType<typeof libraryClient.favorites.$get, 200>;
export type ArtistsInLibrary = InferResponseType<typeof libraryMiscClient.lookup.batch.$post, 200>;

export type AurralMonitoringResult = {
  monitored: boolean;
  cancelledJobIds?: string[];
  cleanupFailed?: boolean;
};

export type CustomArtworkResult =
  | InferResponseType<(typeof libraryArtworkClient.artwork)[":kind"][":id"]["$put"], 200>
  | (InferResponseType<(typeof libraryArtworkClient.artwork)[":kind"][":id"]["$delete"], 200> & {
      updatedAt?: undefined;
    });

export const slowLibraryFetch = apiFetchWithin(90_000);

const mergeSignals = (
  callerSignal: AbortSignal | undefined,
  querySignal: AbortSignal | undefined,
) => {
  if (callerSignal && querySignal) return AbortSignal.any([callerSignal, querySignal]);
  return callerSignal || querySignal;
};

const libraryPageParams = (options: LibraryPageOptions = {}) =>
  Object.fromEntries(
    Object.entries({
      kind: options.kind,
      page: options.page,
      pageSize: options.pageSize,
      query: options.query,
      genre: options.genre,
      sort: options.sort,
      direction: options.direction,
      artistId: options.artistId,
      albumId: options.albumId,
      source: options.source || "all",
      // Tri-state: an explicit boolean forces the filter, while `undefined` omits
      // the param so the backend shows what can be played and what Aurral is fetching.
      availableOnly:
        options.availableOnly === undefined || options.availableOnly === null
          ? undefined
          : options.availableOnly === true
            ? "true"
            : "false",
    }).filter(
      (entry): entry is [string, string | number] =>
        entry[1] !== undefined && entry[1] !== null && entry[1] !== "",
    ),
  );

const asQuery = (params: Record<string, string | number>) =>
  Object.fromEntries(Object.entries(params).map(([key, value]) => [key, String(value)]));

const withAuthenticatedArtwork = <T extends object>(entity: T & ArtworkEntity): T =>
  entity && typeof entity === "object"
    ? {
        ...entity,
        ...(entity.coverUrl ? { coverUrl: resolveAuthenticatedApiAssetUrl(entity.coverUrl) } : {}),
        ...(entity.defaultCoverUrl
          ? { defaultCoverUrl: resolveAuthenticatedApiAssetUrl(entity.defaultCoverUrl) }
          : {}),
        ...(entity.artworkUrl
          ? { artworkUrl: resolveAuthenticatedApiAssetUrl(entity.artworkUrl) }
          : {}),
        ...(entity.customArtworkUrl
          ? { customArtworkUrl: resolveAuthenticatedApiAssetUrl(entity.customArtworkUrl) }
          : {}),
      }
    : entity;

const withAuthenticatedArtworkList = <T extends object>(entities: T[]) =>
  entities.map(withAuthenticatedArtwork);

const authenticatedCollections = <
  Artist extends object,
  Album extends object,
  Track extends object,
>(library: {
  artists?: Artist[];
  albums?: Album[];
  tracks?: Track[];
}) => ({
  ...(Array.isArray(library.artists)
    ? { artists: withAuthenticatedArtworkList(library.artists) }
    : {}),
  ...(Array.isArray(library.albums)
    ? { albums: withAuthenticatedArtworkList(library.albums) }
    : {}),
  ...(Array.isArray(library.tracks)
    ? { tracks: withAuthenticatedArtworkList(library.tracks) }
    : {}),
});

const withAuthenticatedLibraryArtwork = (library: LibraryPageResponse): LibraryPageResponse => {
  if (!library || typeof library !== "object") return library;
  const collections = authenticatedCollections(library);
  switch (library.kind) {
    case "artists":
      return {
        ...library,
        ...collections,
        ...(Array.isArray(library.items)
          ? { items: withAuthenticatedArtworkList(library.items) }
          : {}),
      };
    case "albums":
      return {
        ...library,
        ...collections,
        ...(Array.isArray(library.items)
          ? { items: withAuthenticatedArtworkList(library.items) }
          : {}),
      };
    case "tracks":
      return {
        ...library,
        ...collections,
        ...(Array.isArray(library.items)
          ? { items: withAuthenticatedArtworkList(library.items) }
          : {}),
      };
    case "genres":
      return {
        ...library,
        ...collections,
        ...(Array.isArray(library.items)
          ? { items: withAuthenticatedArtworkList(library.items) }
          : {}),
      };
    default:
      return library;
  }
};

type LibraryPageKind = LibraryPageResponse["kind"];
type LibraryPageOf<Kind extends LibraryPageKind> = Extract<LibraryPageResponse, { kind: Kind }>;

export function fetchLibraryPage<Kind extends LibraryPageKind>(
  options: LibraryPageOptions & { kind: Kind },
  io?: SignalOptions,
): Promise<LibraryPageOf<Kind>>;
export function fetchLibraryPage(
  options?: LibraryPageOptions,
  io?: SignalOptions,
): Promise<LibraryPageResponse>;
export function fetchLibraryPage(
  options: LibraryPageOptions = {},
  { signal }: SignalOptions = {},
): Promise<LibraryPageResponse> {
  return parseResponse(
    libraryClient.canonical.$get(
      { query: asQuery(libraryPageParams(options)) },
      { init: { signal } },
    ),
  ).then(withAuthenticatedLibraryArtwork);
}

export function getLibraryPage<Kind extends LibraryPageKind>(
  options: LibraryPageOptions & { kind: Kind },
  io?: SignalOptions,
): Promise<LibraryPageOf<Kind>>;
export function getLibraryPage(
  options?: LibraryPageOptions,
  io?: SignalOptions,
): Promise<LibraryPageResponse>;
export function getLibraryPage(
  options: LibraryPageOptions = {},
  { signal }: SignalOptions = {},
): Promise<LibraryPageResponse> {
  const params = libraryPageParams(options);
  return queryClient.fetchQuery({
    queryKey: queryKeys.libraryPage(params),
    queryFn: ({ signal: querySignal }) =>
      fetchLibraryPage(options, { signal: mergeSignals(signal, querySignal) }),
    staleTime: 15_000,
  });
}

export const clearLibraryPageCache = () => {
  bumpLibraryPageGeneration();
  return queryClient.removeQueries({
    queryKey: queryKeys.libraryPagePrefix,
    predicate: (query) => query.state.fetchStatus !== "fetching",
  });
};

export const settleLibraryOwnerConflict = (error: unknown) => {
  const conflict = getLibraryOwnerConflict(error);
  if (!conflict) return null;
  clearLibraryPageCache();
  queryClient.invalidateQueries({ queryKey: queryKeys.libraryPrefix });
  return conflict;
};

export const updateLibraryArtistMbid = async (artistId: number, mbid: string | null) => {
  const result = await parseResponse(
    libraryArtistsClient.canonical.artists[":id"].mbid.$put({
      param: { id: encodeURIComponent(artistId) },
      json: { mbid },
    }),
  );
  clearLibraryPageCache();
  void queryClient.invalidateQueries({ queryKey: queryKeys.libraryPrefix });
  return result;
};

export const getLibraryCustomArtworkUrl = (
  kind: "album" | "track",
  id: string | number,
  version: string | number = "current",
) =>
  buildAuthenticatedApiUrl(
    `/library/artwork/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`,
    { v: version },
  );

let libraryFavoritesGeneration = 0;
let latestLibraryFavorites: LibraryFavoritesResponse | null = null;
let libraryFavoritesRefresh: Promise<unknown> | null = null;
let libraryFavoritesWrite: Promise<unknown> = Promise.resolve();

const fetchLibraryFavorites = ({ signal }: SignalOptions = {}) =>
  parseResponse(libraryClient.favorites.$get(undefined, { init: { signal } })).then((favorites) =>
    favorites?.library
      ? {
          ...favorites,
          library: { ...favorites.library, ...authenticatedCollections(favorites.library) },
        }
      : favorites,
  );

const waitForLibraryFavoritesRefresh = async () => {
  let waited = false;
  while (libraryFavoritesRefresh) {
    waited = true;
    const pending = libraryFavoritesRefresh;
    await pending;
  }
  return waited;
};

export const getLibraryFavorites = async ({ signal }: SignalOptions = {}) => {
  const generation = libraryFavoritesGeneration;
  const data = await queryClient.fetchQuery({
    queryKey: queryKeys.libraryFavorites,
    queryFn: ({ signal: querySignal }) =>
      fetchLibraryFavorites({ signal: mergeSignals(signal, querySignal) }),
    staleTime: 30_000,
  });
  const waitedForRefresh = await waitForLibraryFavoritesRefresh();
  if (generation === libraryFavoritesGeneration && !waitedForRefresh) return data;
  const repaired =
    latestLibraryFavorites || queryClient.getQueryData(queryKeys.libraryFavorites) || data;
  queryClient.setQueryData(queryKeys.libraryFavorites, repaired);
  return repaired;
};

export const clearLibraryFavoritesCache = () => {
  libraryFavoritesGeneration += 1;
  latestLibraryFavorites = null;
};

const writeLibraryFavorites = <T>(send: () => Promise<T>): Promise<T> => {
  const generation = ++libraryFavoritesGeneration;
  const write = libraryFavoritesWrite.then(async () => {
    try {
      const data = await send();
      if (generation !== libraryFavoritesGeneration) return data;
      try {
        const refreshed = await fetchLibraryFavorites();
        if (generation !== libraryFavoritesGeneration) return data;
        latestLibraryFavorites = refreshed;
        queryClient.setQueryData(queryKeys.libraryFavorites, refreshed);
      } catch {
        if (generation === libraryFavoritesGeneration) {
          latestLibraryFavorites = null;
          queryClient.invalidateQueries({ queryKey: queryKeys.libraryFavorites });
        }
      }
      return data;
    } finally {
      clearLibraryPageCache();
    }
  });
  const pending = write.catch(() => {});
  libraryFavoritesWrite = pending;
  libraryFavoritesRefresh = pending;
  pending.then(() => {
    if (libraryFavoritesRefresh === pending) libraryFavoritesRefresh = null;
  });
  return write;
};

const postLibraryFavorites = (ids: string[], starred: boolean) =>
  parseResponse(libraryClient.favorites.$post({ json: { ids, starred } }));

export const updateLibraryFavorites = (
  ids: string[],
  starred: boolean,
): Promise<WithAbsentKeys<Awaited<ReturnType<typeof postLibraryFavorites>>>> =>
  writeLibraryFavorites(() => postLibraryFavorites(ids, starred));

export const restoreLibraryFavorites = (
  favorites: NonNullable<
    InferRequestType<typeof libraryClient.favorites.restore.$post>["json"]["favorites"]
  >,
) =>
  writeLibraryFavorites(() =>
    parseResponse(libraryClient.favorites.restore.$post({ json: { favorites } })),
  );

const fetchLibraryArtist = async (mbid: string | null, { signal }: SignalOptions = {}) => {
  const artist = await parseResponse(
    libraryArtistsClient.artists[":mbid"].$get(
      { param: { mbid: encodeURIComponent(String(mbid)) } },
      { init: { signal } },
    ),
  );
  return artist && !artist.foreignArtistId ? { ...artist, foreignArtistId: artist.mbid } : artist;
};

export type LibraryArtist = Awaited<ReturnType<typeof fetchLibraryArtist>>;

export const getLibraryArtist = (
  mbid: string | null,
  { signal, bypassCache = false }: SignalOptions & { bypassCache?: boolean } = {},
) => {
  if (signal && !bypassCache) return fetchLibraryArtist(mbid, { signal });
  return queryClient.fetchQuery({
    queryKey: queryKeys.libraryArtist(mbid),
    queryFn: ({ signal: querySignal }) => fetchLibraryArtist(mbid, { signal: querySignal }),
    staleTime: bypassCache ? 0 : 15_000,
  });
};

const fetchLibraryArtistLookup = (
  mbid: string | null | undefined,
  { signal }: SignalOptions = {},
) =>
  parseResponse(
    libraryMiscClient.lookup[":mbid"].$get(
      { param: { mbid: encodeURIComponent(String(mbid)) } },
      { init: { signal } },
    ),
  );

export const lookupArtistInLibrary = (
  mbid: string | null | undefined,
  { signal, bypassCache = false }: SignalOptions & { bypassCache?: boolean } = {},
) => {
  if (signal && !bypassCache) return fetchLibraryArtistLookup(mbid, { signal });
  return queryClient.fetchQuery({
    queryKey: queryKeys.libraryLookupDetails(mbid),
    queryFn: ({ signal: querySignal }) => fetchLibraryArtistLookup(mbid, { signal: querySignal }),
    staleTime: bypassCache ? 0 : 15_000,
  });
};

export const readLibraryLookupCache = (mbids: string[] | null | undefined) => {
  const result: ArtistsInLibrary = {};
  if (!Array.isArray(mbids)) return result;
  mbids.forEach((id) => {
    const value = queryClient.getQueryData<boolean>(queryKeys.libraryLookup(id));
    if (value !== undefined) result[id] = value;
  });
  return result;
};

const writeLibraryLookupCache = (lookup: ArtistsInLibrary) => {
  if (!lookup || typeof lookup !== "object") return;
  Object.entries(lookup).forEach(([id, value]) => {
    queryClient.setQueryData(queryKeys.libraryLookup(id), value);
  });
};

export const LIBRARY_LOOKUP_BATCH_SIZE = 100;

export const libraryLookupBatchQuery = (mbids: string[] | null | undefined) => {
  const ids = [...new Set((Array.isArray(mbids) ? mbids : []).filter(Boolean))].sort();
  return {
    queryKey: queryKeys.libraryLookupBatch(ids),
    queryFn: async ({ signal }: { signal?: AbortSignal }) => {
      const lookup: ArtistsInLibrary = {};
      for (let index = 0; index < ids.length; index += LIBRARY_LOOKUP_BATCH_SIZE) {
        Object.assign(
          lookup,
          await parseResponse(
            libraryMiscClient.lookup.batch.$post(
              { json: { mbids: ids.slice(index, index + LIBRARY_LOOKUP_BATCH_SIZE) } },
              { init: { signal } },
            ),
          ),
        );
      }
      writeLibraryLookupCache(lookup);
      return lookup;
    },
    staleTime: 60_000,
  };
};

export const lookupArtistsInLibraryBatch = async (
  mbids: string[] | null | undefined,
): Promise<ArtistsInLibrary> => {
  if (!Array.isArray(mbids) || !mbids.some(Boolean)) return {};
  return queryClient.fetchQuery(libraryLookupBatchQuery(mbids));
};

const fetchAlbumsInLibrary = (mbids: string[], signal: AbortSignal | undefined) =>
  parseResponse(
    libraryMiscClient.albums.lookup.batch.$post({ json: { mbids } }, { init: { signal } }),
  );

type AlbumsInLibrary = Awaited<ReturnType<typeof fetchAlbumsInLibrary>>;

export const lookupAlbumsInLibraryBatch = (
  mbids: (string | null | undefined)[] | null | undefined,
  { signal, bypassCache = false }: SignalOptions & { bypassCache?: boolean } = {},
) => {
  const ids = [
    ...new Set((Array.isArray(mbids) ? mbids : []).filter((mbid): mbid is string => Boolean(mbid))),
  ].sort();
  if (!ids.length) return Promise.resolve<AlbumsInLibrary>({});
  if (bypassCache) return fetchAlbumsInLibrary(ids, signal);
  return queryClient.fetchQuery({
    queryKey: queryKeys.libraryAlbumLookup(ids),
    queryFn: ({ signal: querySignal }) => fetchAlbumsInLibrary(ids, querySignal),
    staleTime: 15_000,
  });
};

export const refreshActiveDownloads = () =>
  queryClient.invalidateQueries({ queryKey: queryKeys.activeDownloads });

const markDownloadStarted = (started: ActiveDownloadStart) => {
  queryClient.setQueryData<ActiveDownloads>(queryKeys.activeDownloads, (current) =>
    addActiveDownload(current, started),
  );
  void refreshActiveDownloads();
};

const refreshActiveDownloadsAfter = async <T>(request: Promise<T>): Promise<T> => {
  try {
    return await request;
  } finally {
    void refreshActiveDownloads();
  }
};

export const addArtistToLibrary = async (artistData: ReturnType<typeof buildArtistAddPayload>) => {
  const result = await refreshActiveDownloadsAfter(
    parseResponse(libraryArtistsClient.artists.$post({ json: artistData })),
  );
  const mbid =
    result?.artist?.foreignArtistId || result?.foreignArtistId || artistData?.foreignArtistId;
  if (mbid) queryClient.setQueryData(queryKeys.libraryLookup(mbid), true);
  return result;
};

const fetchLibraryAlbums = async (
  artistId: string | number,
  { signal, managedBy = null }: SignalOptions & { managedBy?: "aurral" | "lidarr" | null } = {},
) => {
  const albums = await parseResponse(
    libraryAlbumsClient.albums.$get(
      { query: { artistId: String(artistId), ...(managedBy ? { managedBy } : {}) } },
      { init: { signal } },
    ),
  );
  return albums.map((album) => ({
    ...album,
    foreignAlbumId: album.foreignAlbumId || album.mbid,
  }));
};

export const getLibraryAlbums = (
  artistId: string | number,
  {
    signal,
    bypassCache = false,
    managedBy = null,
  }: SignalOptions & { bypassCache?: boolean; managedBy?: "aurral" | "lidarr" | null } = {},
) => {
  if (signal && !bypassCache) return fetchLibraryAlbums(artistId, { signal, managedBy });
  return queryClient.fetchQuery({
    queryKey: [...queryKeys.libraryAlbums(artistId), managedBy],
    queryFn: ({ signal: querySignal }) =>
      fetchLibraryAlbums(artistId, { signal: querySignal, managedBy }),
    staleTime: bypassCache ? 0 : 15_000,
  });
};

type AlbumRequestPayload =
  | ReturnType<typeof buildAlbumRequestPayload>
  | ReturnType<typeof buildAurralAlbumRetryPayload>;

const postAlbumRequest = (payload: AlbumRequestPayload) =>
  parseResponse(
    libraryAlbumsClient.albums.request.$post({ json: payload }, { fetch: slowLibraryFetch }),
  );

type WithAbsentAlbumKeys<T> = {
  [Key in keyof T]: Key extends "album" ? WithAbsentKeys<T[Key]> : T[Key];
};

export type AlbumRequestResult = WithAbsentKeys<
  WithAbsentAlbumKeys<Awaited<ReturnType<typeof postAlbumRequest>>>
>;

export const requestAlbumFromSearch = async (
  payload: AlbumRequestPayload,
): Promise<AlbumRequestResult> => {
  const started = { albumMbid: payload?.albumMbid, artistMbid: payload?.artistMbid };
  const previous = queryClient.getQueryData(queryKeys.activeDownloads);
  const optimistic = queryClient.setQueryData<ActiveDownloads>(
    queryKeys.activeDownloads,
    (current) => addActiveDownload(current, started),
  );
  try {
    const result = await postAlbumRequest(payload);
    if (result?.status === "available") {
      void refreshActiveDownloads();
    } else {
      markDownloadStarted(started);
    }
    return result;
  } catch (error) {
    if (queryClient.getQueryData(queryKeys.activeDownloads) === optimistic) {
      queryClient.setQueryData(
        queryKeys.activeDownloads,
        previous ?? normalizeActiveDownloads(previous),
      );
    }
    void refreshActiveDownloads();
    throw error;
  }
};

export const updateLibraryArtist = (
  mbid: string,
  data: { monitorOption?: string; monitoring?: ArtistMonitoringInput; artistName?: string },
) =>
  refreshActiveDownloadsAfter(
    parseResponse(
      libraryArtistsClient.artists[":mbid"].$put({
        param: { mbid: encodeURIComponent(mbid) },
        json: data,
      }),
    ),
  );

const postTrackDownload = (track: Parameters<typeof requestLibraryTrack>[0]) =>
  parseResponse(libraryDownloadsClient.downloads.track.$post({ json: track }));

export const downloadTrackToLibrary = async (
  track: Parameters<typeof requestLibraryTrack>[0],
): Promise<WithAbsentKeys<Awaited<ReturnType<typeof postTrackDownload>>>> => {
  const result = await postTrackDownload(track);
  if (result.queued) {
    markDownloadStarted({
      track: {
        mbid: track?.trackMbid || null,
        artistName: track?.artistName,
        trackName: track?.trackName,
      },
    });
  } else {
    void refreshActiveDownloads();
  }
  return result;
};

export const reSearchLibraryTrack = (
  trackId: string | number,
  { albumId }: { albumId?: string | number } = {},
) =>
  refreshActiveDownloadsAfter(
    parseResponse(
      libraryDownloadsClient.downloads.tracks[":trackId"].research.$post({
        param: { trackId: encodeURIComponent(trackId) },
        json: { albumId },
      }),
    ),
  );

export const triggerAlbumSearch = (albumId: string | number) =>
  refreshActiveDownloadsAfter(
    parseResponse(libraryDownloadsClient.downloads.album.search.$post({ json: { albumId } })),
  );

const fetchDownloadStatus = (ids: string[], signal: AbortSignal | undefined) =>
  parseResponse(
    libraryDownloadsClient.downloads.status.$get(
      { query: { albumIds: ids.join(",") } },
      { init: { signal } },
    ),
  );

export const getDownloadStatus = async (
  albumIds: string | null | undefined | (string | null | undefined)[],
  { signal, bypassCache = false }: SignalOptions & { bypassCache?: boolean } = {},
) => {
  const ids = [
    ...new Set(
      (Array.isArray(albumIds) ? albumIds : [albumIds]).filter((id): id is string => Boolean(id)),
    ),
  ].sort();
  if (!ids.length) return {};
  if (bypassCache) return fetchDownloadStatus(ids, signal);
  return queryClient.fetchQuery({
    queryKey: queryKeys.downloadStatus(ids),
    queryFn: ({ signal: querySignal }) => fetchDownloadStatus(ids, querySignal),
    staleTime: 4_000,
  });
};

export const cancelAurralAlbum = (canonicalId: string | number) =>
  refreshActiveDownloadsAfter(
    parseResponse(
      libraryAlbumsClient.albums.aurral[":canonicalId"].cancel.$post({
        param: { canonicalId: encodeURIComponent(canonicalId) },
      }),
    ),
  );

export const setAurralAlbumMonitoring = (
  canonicalId: string | number,
  monitored: boolean,
): Promise<AurralMonitoringResult> =>
  refreshActiveDownloadsAfter(
    parseResponse(
      libraryAlbumsClient.albums.aurral[":canonicalId"].$put({
        param: { canonicalId: encodeURIComponent(canonicalId) },
        json: { monitored },
      }),
    ),
  );

const updateAurralTrack = (
  canonicalId: string | number,
  json: { monitored?: boolean; keepFile?: boolean },
) =>
  refreshActiveDownloadsAfter(
    parseResponse(
      libraryTracksClient.tracks.aurral[":canonicalId"].$put({
        param: { canonicalId: encodeURIComponent(canonicalId) },
        json,
      }),
    ),
  );

export const setAurralTrackMonitoring = async (
  canonicalId: string | number,
  monitored: boolean,
): Promise<AurralMonitoringResult> => {
  const result = await updateAurralTrack(canonicalId, { monitored });
  if (!("monitored" in result)) throw new Error("Track monitoring did not change");
  return result;
};

export const setAurralTrackKeepFile = async (canonicalId: string | number, keepFile: boolean) => {
  const result = await updateAurralTrack(canonicalId, { keepFile });
  if (!("keepFile" in result)) throw new Error("Track upgrades did not change");
  return result;
};

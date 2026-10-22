import {
  getData,
  postData,
  putData,
  deleteData,
  buildAuthenticatedApiUrl,
  resolveAuthenticatedApiAssetUrl,
} from "../core.ts";
import { bumpLibraryPageGeneration, queryClient, queryKeys } from "../../../queryClient.ts";
import { getLibraryOwnerConflict } from "../../libraryDestination.ts";
import type { buildAlbumRequestPayload, buildArtistAddPayload } from "../../libraryDestination.ts";
import type { buildAurralAlbumRetryPayload } from "../../aurralAlbumStatus.ts";
import {
  addActiveDownload,
  normalizeActiveDownloads,
  type ActiveDownloads,
} from "../../activeDownloads.ts";
import type { GetLibraryArtistLookupResponse } from "../../../../../backend/routes/library/handlers/misc.ts";
import type {
  FetchLibraryFavoritesResponse,
  FetchLibraryPageResponse,
  GetActiveLibraryRefreshResponse,
  GetLibraryRefreshStatusResponse,
  RequestLibraryRefreshResponse,
  RestoreLibraryFavoritesResponse,
  UpdateLibraryFavoritesResponse,
} from "../../../../../backend/routes/library/handlers/libraryIndex.ts";
import type { describeReadOnlyFolders } from "../../../../../backend/services/libraryFiles/readOnlyFolders.ts";
import type {
  CheckLibraryIngestSourceResponse,
  LibraryFileOperationItemsResponse,
  LibraryFileOperationResponse,
} from "../../../../../backend/routes/library/handlers/files.ts";
import type {
  AddArtistToLibraryResponse,
  DeleteArtistFromLibraryResponse,
  FetchLibraryArtistResponse,
  GetArtistMonitoringResponse,
  RefreshLibraryArtistResponse,
  UpdateLibraryArtistMbidResponse,
  UpdateLibraryArtistResponse,
} from "../../../../../backend/routes/library/handlers/artists.ts";
import type {
  AddLibraryAlbumResponse,
  CancelAurralAlbumResponse,
  DeleteAurralAlbumFromLibraryResponse,
  DeleteLibraryAlbumResponse,
  GetAurralAlbumStatusResponse,
  GetLibraryAlbumsResponse,
  RequestAlbumFromSearchResponse,
  UpdateLibraryAlbumResponse,
} from "../../../../../backend/routes/library/handlers/albums.ts";
import type {
  DeleteLibraryTrackResponse,
  GetLibraryTrackFilesResponse,
  SetAurralTrackKeepFileResponse,
} from "../../../../../backend/routes/library/handlers/tracks.ts";
import type {
  DownloadAlbumResponse,
  DownloadTrackToLibraryResponse,
  GetActiveDownloadsResponse,
  GetDownloadStatusResponse,
  ResearchLibraryTrackResponse,
  TriggerAlbumSearchResponse,
} from "../../../../../backend/routes/library/handlers/downloads.ts";
import type {
  GetMonitoringDefaultsResponse,
  GetMonitoringExclusionsResponse,
  PreviewArtistMonitoringResponse,
  PreviewMonitoringDefaultsResponse,
  RemoveMonitoringExclusionResponse,
  SaveMonitoringDefaultsResponse,
} from "../../../../../backend/routes/library/handlers/monitoring.ts";
import type {
  DeleteLibraryCustomArtworkResponse,
  UploadLibraryCustomArtworkResponse,
} from "../../../../../backend/routes/library/handlers/artwork.ts";
import type {
  GetRecentlyAddedResponse,
  GetRecentReleasesResponse,
  LookupAlbumsInLibraryBatchResponse,
  LookupArtistsInLibraryBatchResponse,
} from "../../../../../backend/routes/library/handlers/misc.ts";
import type { libraryManager } from "../../../../../backend/services/libraryManager.ts";
import type { requestLibraryTrack } from "../../../../../backend/services/libraryTrackRequests.ts";
import type { ActivityRequest } from "../../../pages/activity/activityListUtils.ts";

type SignalOptions = { signal?: AbortSignal };

type LibraryPageOptions = {
  kind?: "artists" | "albums" | "tracks" | "genres";
  page?: number | string;
  pageSize?: number;
  query?: string;
  genre?: string;
  sort?: string;
  direction?: string;
  artistId?: string;
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

type MonitoringRulesInput = Parameters<typeof libraryManager.previewMonitoringDefaults>[0];

type ArtistMonitoringInput = {
  monitored: boolean;
  useDefault?: boolean;
  rules?: MonitoringRulesInput;
};

type LibraryTrackContext = {
  artistName?: string;
  albumTitle?: string;
  releaseType?: string;
  releaseDate?: string;
  deezerAlbumId?: string | number;
  readPath?: "canonical";
  source?: string;
};

type ActiveDownloadStart = {
  albumMbid?: string | null;
  artistMbid?: string | null;
  track?: { mbid: string | null; artistName?: string; trackName?: string };
};

export type { PreviewArtistMonitoringResponse };

export type AurralMonitoringResult = {
  monitored: boolean;
  cancelledJobIds?: string[];
  cleanupFailed?: boolean;
};

export type CustomArtworkResult =
  | UploadLibraryCustomArtworkResponse
  | (DeleteLibraryCustomArtworkResponse & { updatedAt?: undefined });

const buildStreamUrl = (path: string) => buildAuthenticatedApiUrl(path);
const SLOW_LIBRARY_REQUEST_TIMEOUT_MS = 90000;

const mergeSignals = (
  callerSignal: AbortSignal | undefined,
  querySignal: AbortSignal | undefined,
) => {
  if (callerSignal && querySignal) return AbortSignal.any([callerSignal, querySignal]);
  return callerSignal || querySignal;
};

export const getLibraryArtists = (options: SignalOptions = {}) =>
  getData("/library/artists", options);

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
    }).filter(([, value]) => value !== undefined && value !== null && value !== ""),
  );

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

const withAuthenticatedLibraryArtwork = (library: FetchLibraryPageResponse) => {
  if (!library || typeof library !== "object") return library;
  return {
    ...library,
    ...(Array.isArray(library.albums)
      ? { albums: library.albums.map(withAuthenticatedArtwork) }
      : {}),
    ...(Array.isArray(library.tracks)
      ? { tracks: library.tracks.map(withAuthenticatedArtwork) }
      : {}),
    ...(Array.isArray(library.items) ? { items: library.items.map(withAuthenticatedArtwork) } : {}),
  };
};

export const fetchLibraryPage = (
  options: LibraryPageOptions = {},
  { signal }: SignalOptions = {},
): Promise<FetchLibraryPageResponse> =>
  getData<FetchLibraryPageResponse>("/library/canonical", {
    params: libraryPageParams(options),
    signal,
  }).then(withAuthenticatedLibraryArtwork);

export const getLibraryPage = (
  options: LibraryPageOptions = {},
  { signal }: SignalOptions = {},
) => {
  const params = libraryPageParams(options);
  return queryClient.fetchQuery({
    queryKey: queryKeys.libraryPage(params),
    queryFn: ({ signal: querySignal }) =>
      fetchLibraryPage(options, { signal: mergeSignals(signal, querySignal) }),
    staleTime: 15_000,
  });
};

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

export const requestLibraryRefresh = (
  mode: "quick" | "full" = "quick",
): Promise<RequestLibraryRefreshResponse> => postData("/library/refresh", { mode });

export const updateLibraryArtistMbid = async (
  artistId: number,
  mbid: string | null,
): Promise<UpdateLibraryArtistMbidResponse> => {
  const result = await putData<UpdateLibraryArtistMbidResponse>(
    `/library/canonical/artists/${encodeURIComponent(artistId)}/mbid`,
    { mbid },
  );
  clearLibraryPageCache();
  void queryClient.invalidateQueries({ queryKey: queryKeys.libraryPrefix });
  return result;
};

export const getLibraryFiles = (): Promise<LibraryFileOperationResponse> =>
  getData("/library/files");

export const getReadOnlyFolders = (): Promise<
  Awaited<ReturnType<typeof describeReadOnlyFolders>>
> => getData("/library/files/read-only-folders");

export const addReadOnlyFolder = (folderPath: string) =>
  postData("/library/files/read-only-folders", { path: folderPath });

export const removeReadOnlyFolder = (folderPath: string | null) =>
  deleteData("/library/files/read-only-folders", { data: { path: folderPath } });

export const checkLibraryIngestSource = (
  sourcePath: string,
): Promise<CheckLibraryIngestSourceResponse> =>
  postData("/library/files/ingest/check", { sourcePath });

export const startLibraryIngest = (
  sourcePath: string,
  mode: "move" | "copy" | "hardlink",
  { monitor, fillTags }: { monitor: "none" | "tracks" | "albums"; fillTags: boolean },
): Promise<LibraryFileOperationResponse> =>
  postData("/library/files/ingest", { sourcePath, mode, monitor, fillTags });

export const startLibraryCleanup = (): Promise<LibraryFileOperationResponse> =>
  postData("/library/files/cleanup");

export const getLibraryFileOperation = (
  id: string | number,
): Promise<LibraryFileOperationResponse> =>
  getData(`/library/files/operations/${encodeURIComponent(id)}`);

export const getLibraryFileOperationItems = (
  id: string | number,
  {
    status = [],
    offset = 0,
    limit = 50,
  }: { status?: string[]; offset?: number; limit?: number } = {},
): Promise<LibraryFileOperationItemsResponse> =>
  getData(`/library/files/operations/${encodeURIComponent(id)}/items`, {
    params: { status: status.join(",") || undefined, offset, limit },
  });

export const cancelLibraryFileOperation = (
  id: string | number,
): Promise<LibraryFileOperationResponse> =>
  postData(`/library/files/operations/${encodeURIComponent(id)}/cancel`);

export const removeLibraryFileOperationSources = (
  id: string | number,
): Promise<LibraryFileOperationResponse> =>
  postData(`/library/files/operations/${encodeURIComponent(id)}/remove-sources`);

export const getLibraryTrackFiles = (
  trackId: string | number,
  options: SignalOptions = {},
): Promise<GetLibraryTrackFilesResponse> =>
  getData(`/library/tracks/${encodeURIComponent(trackId)}/files`, options);

export const getLibraryCustomArtworkUrl = (
  kind: "album" | "track",
  id: string | number,
  version: string | number = "current",
) =>
  buildAuthenticatedApiUrl(
    `/library/artwork/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`,
    { v: version },
  );

export const uploadLibraryCustomArtwork = (
  kind: "album" | "track",
  id: string | number,
  file: Blob,
): Promise<UploadLibraryCustomArtworkResponse> =>
  putData(`/library/artwork/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`, file, {
    headers: { "Content-Type": file.type || "application/octet-stream" },
  });

export const setLibraryCustomArtworkUrl = (
  kind: "album" | "track",
  id: string | number,
  url: string,
): Promise<UploadLibraryCustomArtworkResponse> =>
  putData(`/library/artwork/${encodeURIComponent(kind)}/${encodeURIComponent(id)}/url`, { url });

export const deleteLibraryCustomArtwork = (
  kind: "album" | "track",
  id: string | number,
): Promise<DeleteLibraryCustomArtworkResponse> =>
  deleteData(`/library/artwork/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`);

export const getActiveLibraryRefresh = (): Promise<GetActiveLibraryRefreshResponse> =>
  getData("/library/refresh");

export const getLibraryRefreshStatus = (jobId: number): Promise<GetLibraryRefreshStatusResponse> =>
  getData(`/library/refresh/${encodeURIComponent(jobId)}`);

let libraryFavoritesGeneration = 0;
let latestLibraryFavorites: FetchLibraryFavoritesResponse | null = null;
let libraryFavoritesRefresh: Promise<unknown> | null = null;
let libraryFavoritesWrite: Promise<unknown> = Promise.resolve();

export const fetchLibraryFavorites = ({
  signal,
}: SignalOptions = {}): Promise<FetchLibraryFavoritesResponse> =>
  getData("/library/favorites", { signal });

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

export const updateLibraryFavorites = (
  ids: string[],
  starred: boolean,
): Promise<UpdateLibraryFavoritesResponse> =>
  writeLibraryFavorites(() => postData("/library/favorites", { ids, starred }));

export const restoreLibraryFavorites = (
  favorites: NonNullable<UpdateLibraryFavoritesResponse["removed"]>,
): Promise<RestoreLibraryFavoritesResponse> =>
  writeLibraryFavorites(() => postData("/library/favorites/restore", { favorites }));

const normalizeLibraryArtist = (artist: FetchLibraryArtistResponse) =>
  artist && !artist.foreignArtistId ? { ...artist, foreignArtistId: artist.mbid } : artist;

const fetchLibraryArtist = async (
  mbid: string | null,
  { signal }: SignalOptions = {},
): Promise<FetchLibraryArtistResponse> =>
  normalizeLibraryArtist(await getData(`/library/artists/${mbid}`, { signal }));

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
): Promise<GetLibraryArtistLookupResponse> => getData(`/library/lookup/${mbid}`, { signal });

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
  const result: LookupArtistsInLibraryBatchResponse = {};
  if (!Array.isArray(mbids)) return result;
  mbids.forEach((id) => {
    const value = queryClient.getQueryData<boolean>(queryKeys.libraryLookup(id));
    if (value !== undefined) result[id] = value;
  });
  return result;
};

const writeLibraryLookupCache = (lookup: LookupArtistsInLibraryBatchResponse) => {
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
      const lookup: LookupArtistsInLibraryBatchResponse = {};
      for (let index = 0; index < ids.length; index += LIBRARY_LOOKUP_BATCH_SIZE) {
        Object.assign(
          lookup,
          await postData(
            "/library/lookup/batch",
            { mbids: ids.slice(index, index + LIBRARY_LOOKUP_BATCH_SIZE) },
            { signal },
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
): Promise<LookupArtistsInLibraryBatchResponse> => {
  if (!Array.isArray(mbids) || !mbids.some(Boolean)) return {};
  return queryClient.fetchQuery(libraryLookupBatchQuery(mbids));
};

export const lookupAlbumsInLibraryBatch = (
  mbids: (string | null | undefined)[] | null | undefined,
  { signal, bypassCache = false }: SignalOptions & { bypassCache?: boolean } = {},
): Promise<LookupAlbumsInLibraryBatchResponse> => {
  const ids = [
    ...new Set((Array.isArray(mbids) ? mbids : []).filter((mbid): mbid is string => Boolean(mbid))),
  ].sort();
  if (!ids.length) return Promise.resolve({});
  if (bypassCache) {
    return postData("/library/albums/lookup/batch", { mbids: ids }, { signal });
  }
  return queryClient.fetchQuery({
    queryKey: queryKeys.libraryAlbumLookup(ids),
    queryFn: ({ signal: querySignal }) =>
      postData("/library/albums/lookup/batch", { mbids: ids }, { signal: querySignal }),
    staleTime: 15_000,
  });
};

export const getActiveDownloads = ({
  signal,
}: SignalOptions = {}): Promise<GetActiveDownloadsResponse> =>
  getData("/library/downloads/active", { signal });

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

export const addArtistToLibrary = async (
  artistData: ReturnType<typeof buildArtistAddPayload>,
): Promise<AddArtistToLibraryResponse> => {
  const result: AddArtistToLibraryResponse = await refreshActiveDownloadsAfter(
    postData("/library/artists", artistData),
  );
  const mbid =
    result?.artist?.mbid ||
    result?.artist?.foreignArtistId ||
    result?.foreignArtistId ||
    artistData?.foreignArtistId;
  if (mbid) queryClient.setQueryData(queryKeys.libraryLookup(mbid), true);
  return result;
};

export const deleteArtistFromLibrary = (
  mbid: string,
  deleteFiles = false,
  manager: "aurral" | "lidarr" | null = null,
): Promise<DeleteArtistFromLibraryResponse> =>
  deleteData(`/library/artists/${mbid}`, {
    params: { deleteFiles, ...(manager ? { manager } : {}) },
  });

export const getArtistMonitoring = (
  mbid: string,
  { signal }: SignalOptions = {},
): Promise<GetArtistMonitoringResponse> =>
  getData(`/library/artists/${encodeURIComponent(mbid)}/monitoring`, { signal });

export const previewArtistMonitoring = (
  mbid: string,
  { monitoring, artistName }: { monitoring: ArtistMonitoringInput; artistName: string },
  { signal }: SignalOptions = {},
): Promise<PreviewArtistMonitoringResponse> =>
  postData(
    `/library/artists/${encodeURIComponent(mbid)}/monitoring/preview`,
    { monitoring, artistName },
    { signal, timeout: SLOW_LIBRARY_REQUEST_TIMEOUT_MS },
  );

export const getMonitoringDefaults = ({
  signal,
}: SignalOptions = {}): Promise<GetMonitoringDefaultsResponse> =>
  getData("/library/monitoring/defaults", { signal });

export const previewMonitoringDefaults = (
  rules: MonitoringRulesInput,
  { signal }: SignalOptions = {},
): Promise<Extract<PreviewMonitoringDefaultsResponse, { artistCount: number }>> =>
  postData(
    "/library/monitoring/defaults/preview",
    { rules },
    {
      signal,
      timeout: SLOW_LIBRARY_REQUEST_TIMEOUT_MS,
    },
  );

export const saveMonitoringDefaults = (
  rules: MonitoringRulesInput,
): Promise<SaveMonitoringDefaultsResponse> => putData("/library/monitoring/defaults", { rules });

export const getMonitoringExclusions = ({
  artistMbid = null,
  signal,
}: {
  artistMbid?: string | null;
  signal?: AbortSignal;
} = {}): Promise<GetMonitoringExclusionsResponse> =>
  getData("/library/monitoring/exclusions", {
    params: artistMbid ? { artistMbid } : {},
    signal,
  });

export const removeMonitoringExclusion = (
  id: number | string,
): Promise<RemoveMonitoringExclusionResponse> =>
  deleteData(`/library/monitoring/exclusions/${encodeURIComponent(id)}`);

export const deleteLidarrAlbumFromLibrary = (
  mbid: string,
  deleteFiles = false,
): Promise<DeleteLibraryAlbumResponse> =>
  deleteData(`/library/albums/lidarr/${encodeURIComponent(mbid)}`, {
    params: { deleteFiles },
  });

export const deleteAlbumFromLibrary = (
  id: string | number,
  deleteFiles = false,
): Promise<DeleteLibraryAlbumResponse> =>
  deleteData(`/library/albums/${id}`, {
    params: { deleteFiles },
  });

export const deleteAurralAlbumFromLibrary = (
  canonicalId: string | number,
  deleteFiles = false,
): Promise<DeleteAurralAlbumFromLibraryResponse> =>
  deleteData(`/library/albums/aurral/${encodeURIComponent(canonicalId)}`, {
    params: { deleteFiles },
  });

export const deleteTrackFromLibrary = (id: string | number): Promise<DeleteLibraryTrackResponse> =>
  deleteData(`/library/tracks/${encodeURIComponent(id)}`);

const fetchLibraryAlbums = async (
  artistId: string,
  { signal, managedBy = null }: SignalOptions & { managedBy?: "aurral" | "lidarr" | null } = {},
): Promise<GetLibraryAlbumsResponse> => {
  const data: GetLibraryAlbumsResponse = await getData("/library/albums", {
    params: { artistId, ...(managedBy ? { managedBy } : {}) },
    signal,
  });
  return data.map((album) => ({
    ...album,
    foreignAlbumId: album.foreignAlbumId || album.mbid,
  }));
};

export const getLibraryAlbums = (
  artistId: string,
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

export const addLibraryAlbum = async (
  artistId: string | number,
  releaseGroupMbid: string,
  albumName: string,
): Promise<AddLibraryAlbumResponse> =>
  postData(
    "/library/albums",
    {
      artistId,
      releaseGroupMbid,
      albumName,
    },
    {
      timeout: SLOW_LIBRARY_REQUEST_TIMEOUT_MS,
    },
  );

export const requestAlbumFromSearch = async (
  payload:
    | ReturnType<typeof buildAlbumRequestPayload>
    | ReturnType<typeof buildAurralAlbumRetryPayload>,
): Promise<RequestAlbumFromSearchResponse> => {
  const started = { albumMbid: payload?.albumMbid, artistMbid: payload?.artistMbid };
  const previous = queryClient.getQueryData(queryKeys.activeDownloads);
  const optimistic = queryClient.setQueryData<ActiveDownloads>(
    queryKeys.activeDownloads,
    (current) => addActiveDownload(current, started),
  );
  let result: RequestAlbumFromSearchResponse;
  try {
    result = await postData("/library/albums/request", payload, {
      timeout: SLOW_LIBRARY_REQUEST_TIMEOUT_MS,
    });
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
  if (result?.status === "available") {
    void refreshActiveDownloads();
  } else {
    markDownloadStarted(started);
  }
  return result;
};

export const getLibraryTracks = async (
  albumId: string | number,
  releaseGroupMbid: string | null = null,
  context: LibraryTrackContext = {},
) => {
  const params: Record<string, string | number> = { albumId };
  if (releaseGroupMbid) {
    params.releaseGroupMbid = releaseGroupMbid;
  }
  if (context.artistName) params.artistName = context.artistName;
  if (context.albumTitle) params.albumTitle = context.albumTitle;
  if (context.releaseType) params.releaseType = context.releaseType;
  if (context.releaseDate) params.releaseDate = context.releaseDate;
  if (context.deezerAlbumId) params.deezerAlbumId = context.deezerAlbumId;
  if (context.readPath) params.readPath = context.readPath;
  if (context.readPath === "canonical") params.source = context.source || "all";
  const data = await getData("/library/tracks", { params });
  const tracks = Array.isArray(data) ? data : [];
  return Promise.all(
    tracks.map(async (track) => {
      if (!track?.streamPath) return track;
      return {
        ...track,
        preview_url: await buildStreamUrl(track.streamPath),
        previewProvider: "lidarr",
      };
    }),
  );
};

export const updateLibraryAlbum = (
  id: string | number,
  data: { monitored?: boolean },
): Promise<UpdateLibraryAlbumResponse> => putData(`/library/albums/${id}`, data);

export const updateLibraryArtist = (
  mbid: string,
  data: { monitorOption?: string; monitoring?: ArtistMonitoringInput; artistName?: string },
): Promise<UpdateLibraryArtistResponse> =>
  refreshActiveDownloadsAfter(putData(`/library/artists/${mbid}`, data));

export const downloadAlbum = (
  artistId: string | number,
  albumId: string | number,
  options: { artistMbid?: string; artistName?: string } = {},
): Promise<DownloadAlbumResponse> =>
  refreshActiveDownloadsAfter(
    postData("/library/downloads/album", {
      artistId,
      albumId,
      artistMbid: options.artistMbid,
      artistName: options.artistName,
    }),
  );

export const downloadTrackToLibrary = async (
  track: Parameters<typeof requestLibraryTrack>[0],
): Promise<DownloadTrackToLibraryResponse> => {
  const result = await postData<DownloadTrackToLibraryResponse>("/library/downloads/track", track);
  if (result?.queued) {
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
): Promise<ResearchLibraryTrackResponse> =>
  refreshActiveDownloadsAfter(
    postData(`/library/downloads/tracks/${encodeURIComponent(trackId)}/research`, {
      albumId,
    }),
  );

export const triggerAlbumSearch = (albumId: string | number): Promise<TriggerAlbumSearchResponse> =>
  refreshActiveDownloadsAfter(
    postData("/library/downloads/album/search", {
      albumId,
    }),
  );

export const getDownloadStatus = async (
  albumIds: string | null | undefined | (string | null | undefined)[],
  { signal, bypassCache = false }: SignalOptions & { bypassCache?: boolean } = {},
) => {
  const ids = [
    ...new Set((Array.isArray(albumIds) ? albumIds : [albumIds]).filter(Boolean)),
  ].sort();
  if (!ids.length) return {};
  if (bypassCache) {
    return getData<GetDownloadStatusResponse>(
      `/library/downloads/status?albumIds=${ids.join(",")}`,
      {
        signal,
      },
    );
  }
  return queryClient.fetchQuery({
    queryKey: queryKeys.downloadStatus(ids),
    queryFn: ({ signal: querySignal }) =>
      getData<GetDownloadStatusResponse>(`/library/downloads/status?albumIds=${ids.join(",")}`, {
        signal: querySignal,
      }),
    staleTime: 4_000,
  });
};

export const getAurralAlbumStatus = (
  canonicalId: string | number,
  { signal }: SignalOptions = {},
): Promise<GetAurralAlbumStatusResponse> =>
  getData(`/library/albums/aurral/${encodeURIComponent(canonicalId)}/status`, { signal });

export const cancelAurralAlbum = (
  canonicalId: string | number,
): Promise<CancelAurralAlbumResponse> =>
  refreshActiveDownloadsAfter(
    postData(`/library/albums/aurral/${encodeURIComponent(canonicalId)}/cancel`),
  );

export const setAurralAlbumMonitoring = (
  canonicalId: string | number,
  monitored: boolean,
): Promise<AurralMonitoringResult> =>
  refreshActiveDownloadsAfter(
    putData(`/library/albums/aurral/${encodeURIComponent(canonicalId)}`, { monitored }),
  );

export const setAurralTrackMonitoring = (
  canonicalId: string | number,
  monitored: boolean,
): Promise<AurralMonitoringResult> =>
  refreshActiveDownloadsAfter(
    putData(`/library/tracks/aurral/${encodeURIComponent(canonicalId)}`, { monitored }),
  );

export const setAurralTrackKeepFile = (
  canonicalId: string | number,
  keepFile: boolean,
): Promise<Extract<SetAurralTrackKeepFileResponse, { keepFile: boolean }>> =>
  refreshActiveDownloadsAfter(
    putData(`/library/tracks/aurral/${encodeURIComponent(canonicalId)}`, { keepFile }),
  );

export const refreshLibraryArtist = (
  mbid: string | null | undefined,
): Promise<RefreshLibraryArtistResponse> => postData(`/library/artists/${mbid}/refresh`);

export const getRequests = ({
  refresh = false,
  signal,
}: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<ActivityRequest[]> =>
  getData("/requests", { params: refresh ? { refresh: 1 } : {}, signal });

export const getRecentlyAdded = ({
  signal,
}: SignalOptions = {}): Promise<GetRecentlyAddedResponse> => getData("/library/recent", { signal });

export const getRecentReleases = ({
  signal,
}: SignalOptions = {}): Promise<GetRecentReleasesResponse> =>
  getData("/library/recent-releases", { signal });

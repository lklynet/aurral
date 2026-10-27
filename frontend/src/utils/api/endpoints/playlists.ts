import {
  getData,
  postData,
  putData,
  deleteData,
  buildAuthenticatedApiUrl,
  resolveAuthenticatedApiAssetUrl,
} from "../core.ts";
import { queryClient, queryKeys } from "../../../queryClient.ts";
import type { CustomArtworkResult } from "./library.ts";
import type {
  createManualMissingSearch,
  getManualDownloadSources,
} from "../../../../../backend/services/manualMissingSearchService.ts";
import type { syncStaticPlaylistImport as syncStaticPlaylistImportService } from "../../../../../backend/services/importLists/importListSync.ts";
import type { spotifyClient } from "../../../../../backend/services/spotify/spotifyClient.ts";
import type { listenbrainzPlaylistClient } from "../../../../../backend/services/importLists/listenbrainzPlaylists.ts";
import type { lastfmStationClient } from "../../../../../backend/services/importLists/lastfmStations.ts";
import type {
  buildFlowFromForm,
  normalizePlaylistTrackEntry,
} from "../../../pages/playlists/flowPageUtils.ts";
import type {
  ApproveBlockedJobResponse,
  CancelDownloadJobResponse,
  DenyBlockedJobResponse,
  DownloadManualMissingSearchResultResponse,
  GetJobFilesResponse,
  ReSearchAllMissingTracksResponse,
  RetryDownloadJobResponse,
  SearchAllUpgradesResponse,
  SearchTrackUpgradeResponse,
} from "../../../../../backend/routes/playlists/handlers/jobs.ts";
import type {
  ConvertFlowToStaticPlaylistResponse,
  CreateFlowResponse,
  DeleteFlowResponse,
  GetFlowLidarrImportListUrlResponse,
  GetFlowTemplatesResponse,
  SetFlowEnabledResponse,
  StartFlowResponse,
  UpdateFlowResponse,
} from "../../../../../backend/routes/playlists/handlers/flows.ts";
import type {
  BulkPlaylistOperationResponse,
  DeleteStaticPlaylistTrackResponse,
  SetPlaylistRecordHistoryResponse,
  SetPlaylistTrackAvailabilityResponse,
  StaticPlaylistQueuedResponse,
} from "../../../../../backend/routes/playlists/handlers/staticPlaylists.ts";
import type {
  CompleteSpotifyOAuthResponse,
  DisconnectSpotifyResponse,
  GetSpotifyImportStatusResponse,
  StartSpotifyOAuthResponse,
} from "../../../../../backend/routes/playlists/handlers/spotifyImport.ts";
import type { PreviewYoutubeMusicPlaylistResponse } from "../../../../../backend/routes/playlists/handlers/youtubeMusicImport.ts";
import type {
  ImportedPlaylistPreviewResponse,
  PlaylistImportQueuedResponse,
  ResearchTrackResponse,
} from "../../../../../backend/routes/playlists/handlers/utils.ts";
import type { DeletePlaylistTrackArtworkResponse } from "../../../../../backend/routes/playlists/handlers/trackArtwork.ts";
import type {
  PlaylistArtworkOkResponse,
  PlaylistArtworkGenerateRequest,
  PlaylistArtworkPickResponse,
  PlaylistArtworkShuffleRequest,
} from "../../../../../backend/routes/playlists/handlers/artworkManagement.ts";
import type { getPlaylistStatusSnapshot } from "../../../../../backend/services/playlists/playlistStatusSnapshot.ts";
import type { PlaylistTrackStatus } from "../../../pages/playlists/trackAvailability.ts";

type SignalOptions = { signal?: AbortSignal };

type FlowFormPayload = ReturnType<typeof buildFlowFromForm>;
type FlowCreatePayload = FlowFormPayload | { templateId: string; name?: string };
type FlowUpdatePayload = Partial<FlowFormPayload> & { showInLibrary?: boolean };

type PlaylistTrackPayload = Partial<NonNullable<ReturnType<typeof normalizePlaylistTrackEntry>>>;

export type PlaylistArtworkStyle = NonNullable<PlaylistArtworkGenerateRequest["style"]>;
export type PlaylistCoverPick = NonNullable<PlaylistArtworkPickResponse["pick"]>;

type StaticPlaylistPayload = {
  name: string;
  tracks?: PlaylistTrackPayload[];
  sourceName?: string | null;
  sourceFlowId?: string | null;
};

type ImportSourcePayload = {
  syncIntervalHours?: number;
  syncEnabled?: boolean;
  keepRemovedTracks?: boolean;
};

type PlaylistImportPayload = {
  playlistId: string;
  name: string;
  externalName: string | null;
  syncEnabled: boolean;
  syncIntervalHours: number;
  keepRemovedTracks: boolean;
};

type PlaylistArtworkField = { artworkUrl?: string | null; customArtworkUrl?: string | null };

export const getPlaylistTrackStreamUrl = (jobId: string | number) =>
  buildAuthenticatedApiUrl(`/playlists/stream/${encodeURIComponent(jobId)}`);

const playlistTrackArtworkPath = (jobId: string, playlistId: string, suffix = "") =>
  `/playlists/track-artwork/${encodeURIComponent(jobId)}${suffix}?playlistId=${encodeURIComponent(playlistId)}`;

export const getPlaylistTrackArtworkUrl = (
  playlistId: string,
  jobId: string,
  version: string | number = "current",
) =>
  buildAuthenticatedApiUrl(`/playlists/track-artwork/${encodeURIComponent(jobId)}`, {
    playlistId,
    v: version,
  });

const withAuthenticatedTrackArtwork = <T extends PlaylistArtworkField>(job: T) =>
  job && typeof job === "object"
    ? {
        ...job,
        ...(job.artworkUrl ? { artworkUrl: resolveAuthenticatedApiAssetUrl(job.artworkUrl) } : {}),
        ...(job.customArtworkUrl
          ? { customArtworkUrl: resolveAuthenticatedApiAssetUrl(job.customArtworkUrl) }
          : {}),
      }
    : job;

export const uploadPlaylistTrackArtwork = (
  playlistId: string,
  jobId: string,
  file: Blob,
): Promise<CustomArtworkResult> =>
  putData(playlistTrackArtworkPath(jobId, playlistId), file, {
    headers: { "Content-Type": file.type || "application/octet-stream" },
  });

export const setPlaylistTrackArtworkUrl = (
  playlistId: string,
  jobId: string,
  url: string,
): Promise<CustomArtworkResult> =>
  putData(playlistTrackArtworkPath(jobId, playlistId, "/url"), { url });

export const deletePlaylistTrackArtwork = (
  playlistId: string,
  jobId: string,
): Promise<DeletePlaylistTrackArtworkResponse> =>
  deleteData(playlistTrackArtworkPath(jobId, playlistId));

export const getStagingStreamUrl = (jobId: string) =>
  buildAuthenticatedApiUrl(`/playlists/staging-stream/${encodeURIComponent(jobId)}`);

export const getPlaylistArtworkUrl = (playlistId: string, version: string | number = "current") =>
  buildAuthenticatedApiUrl(`/playlists/artwork/${encodeURIComponent(playlistId)}`, { v: version });

export const uploadPlaylistArtwork = (
  playlistId: string,
  file: Blob,
): Promise<PlaylistArtworkOkResponse> =>
  putData(`/playlists/artwork/${encodeURIComponent(playlistId)}`, file, {
    headers: {
      "Content-Type": file.type || "application/octet-stream",
    },
  });

export const deletePlaylistArtwork = (playlistId: string): Promise<PlaylistArtworkOkResponse> =>
  deleteData(`/playlists/artwork/${encodeURIComponent(playlistId)}`);

export const generatePlaylistArtwork = (
  playlistId: string,
  style: PlaylistArtworkStyle = "artist",
  pick?: PlaylistCoverPick,
): Promise<PlaylistArtworkOkResponse> =>
  postData(`/playlists/artwork/${encodeURIComponent(playlistId)}/generate`, {
    style,
    pick,
  } satisfies PlaylistArtworkGenerateRequest);

export const getPlaylistArtworkPick = (playlistId: string): Promise<PlaylistArtworkPickResponse> =>
  getData(`/playlists/artwork/${encodeURIComponent(playlistId)}/pick`);

export const shufflePlaylistArtwork = (
  playlistId: string,
  body: PlaylistArtworkShuffleRequest,
): Promise<PlaylistArtworkPickResponse> =>
  postData(`/playlists/artwork/${encodeURIComponent(playlistId)}/shuffle`, body);

export const getPlaylistArtworkPreviewUrl = (
  playlistId: string,
  title: string,
  pick: PlaylistCoverPick,
) =>
  buildAuthenticatedApiUrl(`/playlists/artwork/${encodeURIComponent(playlistId)}/preview`, {
    title,
    ...pick,
  });

export const restorePlaylistArtwork = (playlistId: string): Promise<PlaylistArtworkOkResponse> =>
  postData(`/playlists/artwork/${encodeURIComponent(playlistId)}/restore`);

export const getPlaylistStatus = ({
  signal,
  bypassCache = false,
}: SignalOptions & { bypassCache?: boolean } = {}): Promise<
  ReturnType<typeof getPlaylistStatusSnapshot>
> => {
  if (bypassCache) return getData("/playlists/status", { signal });
  return queryClient.fetchQuery({
    queryKey: queryKeys.playlistStatus,
    queryFn: ({ signal: querySignal }) => getData("/playlists/status", { signal: querySignal }),
    staleTime: 4_000,
  });
};

export interface PlaylistJob {
  id: string;
  artistName: string;
  trackName: string;
  albumName: string | null;
  reason: string | null;
  artistMbid: string | null;
  albumMbid: string | null;
  releaseMbid: string | null;
  trackMbid: string | null;
  releaseYear: string | null;
  durationMs: number | null;
  trackNumber: number | null;
  discNumber: number | null;
  albumTrackCount: number | null;
  albumTrackTitles: string[];
  artistAliases: string[];
  status: PlaylistTrackStatus;
  error: string | null;
  upgradeForJobId: string | null;
  qualityOwned?: boolean;
  qualityState?: string | null;
  libraryOwned?: boolean;
  artworkUrl?: string | null;
  customArtworkUrl?: string | null;
}

export const getPlaylistJobs = (
  playlistId: string | null | undefined,
  limit: number | null = null,
  options: SignalOptions & { params?: Record<string, string | number> } = {},
): Promise<PlaylistJob[]> => {
  const params = { ...(options.params || {}) };
  const parsedLimit = Number(limit);
  if (Number.isFinite(parsedLimit) && parsedLimit > 0) {
    params.limit = Math.floor(parsedLimit);
  }
  return getData<PlaylistJob[]>(`/playlists/jobs/${playlistId}`, {
    ...options,
    params,
  }).then((jobs) => (Array.isArray(jobs) ? jobs.map(withAuthenticatedTrackArtwork) : jobs));
};

export const getDownloadJobs = (options: SignalOptions = {}) =>
  getData("/playlists/jobs", options).then((jobs) =>
    Array.isArray(jobs) ? jobs.map(withAuthenticatedTrackArtwork) : jobs,
  );

export const getJobFiles = (
  jobId: string,
  options: SignalOptions = {},
): Promise<GetJobFilesResponse> =>
  getData(`/playlists/jobs/${encodeURIComponent(jobId)}/files`, options);

export const getManualMissingSearchSources = (
  jobId: string,
  {
    mode = "missing",
    playlistId = null,
    signal,
  }: SignalOptions & { mode?: "missing" | "replacement"; playlistId?: string | null } = {},
): Promise<{ sources: ReturnType<typeof getManualDownloadSources> }> =>
  getData(`/playlists/jobs/${encodeURIComponent(jobId)}/manual-search/sources`, {
    params: { mode, ...(playlistId ? { playlistId } : {}) },
    signal,
  });

export const searchMissingTrackManually = (
  jobId: string,
  sourceId: string,
  {
    mode = "missing",
    playlistId = null,
  }: { mode?: "missing" | "replacement"; playlistId?: string | null } = {},
): Promise<Awaited<ReturnType<typeof createManualMissingSearch>>> =>
  postData(
    `/playlists/jobs/${encodeURIComponent(jobId)}/manual-search`,
    { sourceId, mode, ...(playlistId ? { playlistId } : {}) },
    { timeout: 150_000 },
  );

export const downloadManualMissingSearchResult = (
  jobId: string,
  sessionId: string,
  resultId: string,
): Promise<DownloadManualMissingSearchResultResponse> =>
  postData(`/playlists/jobs/${encodeURIComponent(jobId)}/manual-search/select`, {
    sessionId,
    resultId,
  });

export const reSearchAllMissingTracks = (): Promise<ReSearchAllMissingTracksResponse> =>
  postData("/playlists/research-missing");

export const createFlow = (payload: FlowCreatePayload): Promise<CreateFlowResponse> =>
  postData("/playlists/flows", payload);

export const getFlowTemplates = (options: SignalOptions = {}): Promise<GetFlowTemplatesResponse> =>
  getData("/playlists/flow-templates", options);

export const updateFlow = (
  flowId: string,
  payload: FlowUpdatePayload,
): Promise<UpdateFlowResponse> => putData(`/playlists/flows/${flowId}`, payload);

export const deleteFlow = (flowId: string): Promise<DeleteFlowResponse> =>
  deleteData(`/playlists/flows/${flowId}`);

export const convertFlowToStaticPlaylist = (
  flowId: string,
  payload: { name?: string } = {},
): Promise<ConvertFlowToStaticPlaylistResponse> =>
  postData(`/playlists/flows/${flowId}/static-playlist`, payload);

export const createStaticPlaylist = (
  payload: StaticPlaylistPayload,
): Promise<StaticPlaylistQueuedResponse> => postData("/playlists/shared-playlists", payload);

export const setFlowEnabled = (flowId: string, enabled: boolean): Promise<SetFlowEnabledResponse> =>
  putData(`/playlists/flows/${flowId}/enabled`, {
    enabled,
  });

export const importStaticPlaylist = (payload: {
  name: string;
  sourceName: string | null;
  sourceFlowId: string | null;
  tracks: PlaylistTrackPayload[];
}): Promise<StaticPlaylistQueuedResponse> =>
  postData("/playlists/shared-playlists/import", payload);

export const updateStaticPlaylist = (
  playlistId: string,
  payload: { name?: string; tracks?: PlaylistTrackPayload[]; importSource?: ImportSourcePayload },
): Promise<StaticPlaylistQueuedResponse> =>
  putData(`/playlists/shared-playlists/${playlistId}`, payload);

export const setPlaylistTrackAvailability = (
  playlistId: string,
  enabled: boolean,
): Promise<SetPlaylistTrackAvailabilityResponse> =>
  putData(`/playlists/shared-playlists/${encodeURIComponent(playlistId)}/track-availability`, {
    enabled,
  });

export const setPlaylistRecordHistory = (
  playlistId: string,
  enabled: boolean,
): Promise<SetPlaylistRecordHistoryResponse> =>
  putData(`/playlists/shared-playlists/${encodeURIComponent(playlistId)}/record-history`, {
    enabled,
  });

export const addStaticPlaylistTracks = (
  playlistId: string,
  payload: { tracks: PlaylistTrackPayload[] },
): Promise<StaticPlaylistQueuedResponse> =>
  postData(`/playlists/shared-playlists/${playlistId}/tracks`, payload);

export const deleteStaticPlaylist = (playlistId: string): Promise<StaticPlaylistQueuedResponse> =>
  deleteData(`/playlists/shared-playlists/${playlistId}`);

export const deleteStaticPlaylistTrack = (
  playlistId: string,
  jobId: string,
): Promise<DeleteStaticPlaylistTrackResponse> =>
  deleteData(`/playlists/shared-playlists/${playlistId}/tracks/${jobId}`);

export const reSearchStaticPlaylistTrack = (
  playlistId: string,
  jobId: string,
): Promise<ResearchTrackResponse> =>
  postData(`/playlists/shared-playlists/${playlistId}/tracks/${jobId}/research`);

export const reSearchFlowTrack = (
  playlistId: string,
  jobId: string,
): Promise<ResearchTrackResponse> =>
  postData(
    `/playlists/flows/${encodeURIComponent(playlistId)}/tracks/${encodeURIComponent(jobId)}/research`,
  );

export const searchTrackUpgrade = (
  playlistId: string,
  jobId: string,
): Promise<SearchTrackUpgradeResponse> =>
  postData(
    `/playlists/quality-upgrades/${encodeURIComponent(playlistId)}/${encodeURIComponent(jobId)}`,
  );

export const searchAllUpgrades = (): Promise<SearchAllUpgradesResponse> =>
  postData("/playlists/quality-upgrades");

export const approveBlockedJob = (jobId: string): Promise<ApproveBlockedJobResponse> =>
  postData(`/playlists/jobs/${jobId}/approve`);

export const denyBlockedJob = (jobId: string): Promise<DenyBlockedJobResponse> =>
  postData(`/playlists/jobs/${jobId}/deny`);

export const cancelDownloadJob = (jobId: string): Promise<CancelDownloadJobResponse> =>
  postData(`/playlists/jobs/${encodeURIComponent(jobId)}/cancel`);

export const retryDownloadJob = (jobId: string): Promise<RetryDownloadJobResponse> =>
  postData(`/playlists/jobs/${encodeURIComponent(jobId)}/retry`);

export const startFlow = (flowId: string, limit = 30): Promise<StartFlowResponse> =>
  postData(`/playlists/start/${flowId}`, {
    limit,
  });

export const getSpotifyImportStatus = (): Promise<GetSpotifyImportStatusResponse> =>
  getData("/playlists/import/spotify/status");

export const startSpotifyOAuth = (callbackUrl: string): Promise<StartSpotifyOAuthResponse> =>
  postData("/playlists/import/spotify/oauth/start", { callbackUrl });

export const completeSpotifyOAuth = (payload: {
  accessToken: string;
  refreshToken: string;
  expiresIn?: string | number | null;
}): Promise<CompleteSpotifyOAuthResponse> =>
  postData("/playlists/import/spotify/oauth/complete", payload);

export const disconnectSpotify = (): Promise<DisconnectSpotifyResponse> =>
  deleteData("/playlists/import/spotify");

export const getSpotifyPlaylists = (): Promise<
  Awaited<ReturnType<typeof spotifyClient.listPlaylists>>
> => getData("/playlists/import/spotify/playlists");

export const previewSpotifyPlaylist = (
  playlistId: string,
): Promise<ImportedPlaylistPreviewResponse> =>
  postData("/playlists/import/spotify/preview", { playlistId });

export const importSpotifyPlaylist = (
  payload: PlaylistImportPayload,
): Promise<PlaylistImportQueuedResponse> => postData("/playlists/import/spotify", payload);

export const getListenBrainzPlaylists = (): Promise<
  Awaited<ReturnType<typeof listenbrainzPlaylistClient.listPlaylists>>
> => getData("/playlists/import/listenbrainz/playlists");

export const previewListenBrainzPlaylist = (
  playlistId: string,
  playlistType: string | null = null,
): Promise<ImportedPlaylistPreviewResponse> =>
  postData("/playlists/import/listenbrainz/preview", {
    playlistId,
    ...(playlistType ? { playlistType } : {}),
  });

export const importListenBrainzPlaylist = (
  payload: PlaylistImportPayload & { playlistType?: string | null },
): Promise<PlaylistImportQueuedResponse> => postData("/playlists/import/listenbrainz", payload);

export const getLastfmPlaylists = (
  username = "",
): Promise<Awaited<ReturnType<typeof lastfmStationClient.listPlaylists>>> =>
  getData("/playlists/import/lastfm/playlists", {
    params: username ? { username } : undefined,
  });

export const previewLastfmPlaylist = (
  playlistId: string,
  username = "",
): Promise<ImportedPlaylistPreviewResponse> =>
  postData("/playlists/import/lastfm/preview", {
    playlistId,
    username,
  });

export const importLastfmPlaylist = (
  payload: PlaylistImportPayload & { username: string },
): Promise<PlaylistImportQueuedResponse> => postData("/playlists/import/lastfm", payload);

export const previewYoutubeMusicPlaylist = (
  url: string,
): Promise<PreviewYoutubeMusicPlaylistResponse> =>
  postData("/playlists/import/youtube-music/preview", { url }, { timeout: 5 * 60 * 1000 });

export const importYoutubeMusicPlaylist = (
  payload: Omit<PlaylistImportPayload, "externalName">,
): Promise<PlaylistImportQueuedResponse> =>
  postData("/playlists/import/youtube-music", payload, { timeout: 5 * 60 * 1000 });

export const syncStaticPlaylistImport = (
  playlistId: string,
): Promise<{ success: true } & Awaited<ReturnType<typeof syncStaticPlaylistImportService>>> =>
  postData(`/playlists/shared-playlists/${encodeURIComponent(playlistId)}/sync`, undefined, {
    timeout: 5 * 60 * 1000,
  });

export const getFlowLidarrImportListUrl = (
  flowId: string,
): Promise<GetFlowLidarrImportListUrlResponse> =>
  getData(`/playlists/flows/${encodeURIComponent(flowId)}/lidarr-import-list`);

export const removeStaticPlaylistTracks = (
  playlistId: string,
  jobIds: string[],
  options?: { keepalive?: boolean },
): Promise<BulkPlaylistOperationResponse> =>
  postData(
    `/playlists/shared-playlists/${encodeURIComponent(playlistId)}/track-removals`,
    { jobIds },
    options,
  );

export const moveStaticPlaylistTracks = (
  playlistId: string,
  jobIds: string[],
  target: { name: string } | { playlistId: string },
): Promise<BulkPlaylistOperationResponse> =>
  postData(`/playlists/shared-playlists/${encodeURIComponent(playlistId)}/track-moves`, {
    jobIds,
    target,
  });

export interface StaticPlaylistOperationStatus {
  state: string;
  message?: string | null;
  targetPlaylistId?: string | null;
  outcomes?: { status?: string; message?: string | null }[];
}

export const getStaticPlaylistOperation = (
  playlistId: string,
  operationId: string,
  options?: { bypassCache?: boolean } & NonNullable<Parameters<typeof getData>[1]>,
): Promise<StaticPlaylistOperationStatus> =>
  getData(
    `/playlists/shared-playlists/${encodeURIComponent(playlistId)}/operations/${encodeURIComponent(operationId)}`,
    options,
  );

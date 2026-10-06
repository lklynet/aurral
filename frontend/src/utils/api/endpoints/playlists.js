import {
  getData,
  postData,
  putData,
  deleteData,
  buildAuthenticatedApiUrl,
} from "../core.js";
import { queryClient, queryKeys } from "../../../queryClient.js";

export const getPlaylistTrackStreamUrl = (jobId) =>
  buildAuthenticatedApiUrl(`/playlists/stream/${encodeURIComponent(jobId)}`);

export const getStagingStreamUrl = (jobId) =>
  buildAuthenticatedApiUrl(`/playlists/staging-stream/${encodeURIComponent(jobId)}`);

export const getPlaylistArtworkUrl = (playlistId, version = "current") =>
  buildAuthenticatedApiUrl(
    `/playlists/artwork/${encodeURIComponent(playlistId)}`,
    { v: version },
  );

export const uploadPlaylistArtwork = (playlistId, file) =>
  putData(
    `/playlists/artwork/${encodeURIComponent(playlistId)}`,
    file,
    {
      headers: {
        "Content-Type": file.type || "application/octet-stream",
      },
    },
  );

export const deletePlaylistArtwork = (playlistId) =>
  deleteData(
    `/playlists/artwork/${encodeURIComponent(playlistId)}`,
  );

export const generatePlaylistArtwork = (playlistId) =>
  postData(
    `/playlists/artwork/${encodeURIComponent(playlistId)}/generate`,
  );

export const getPlaylistStatus = ({ signal, bypassCache = false } = {}) => {
  if (bypassCache) return getData("/playlists/status", { signal });
  return queryClient.fetchQuery({
    queryKey: queryKeys.playlistStatus,
    queryFn: ({ signal: querySignal }) => getData("/playlists/status", { signal: querySignal }),
    staleTime: 4_000,
  });
};

export const getPlaylistJobs = (playlistId, limit = null, options = {}) => {
  const params = { ...(options.params || {}) };
  const parsedLimit = Number(limit);
  if (Number.isFinite(parsedLimit) && parsedLimit > 0) {
    params.limit = Math.floor(parsedLimit);
  }
  return getData(`/playlists/jobs/${playlistId}`, {
    ...options,
    params,
  });
};

export const getDownloadJobs = (options = {}) =>
  getData("/playlists/jobs", options);

export const getJobFiles = (jobId, options = {}) =>
  getData(`/playlists/jobs/${encodeURIComponent(jobId)}/files`, options);

export const getManualMissingSearchSources = (jobId, { mode = "missing", playlistId = null } = {}) =>
  getData(`/playlists/jobs/${encodeURIComponent(jobId)}/manual-search/sources`, {
    params: { mode, ...(playlistId ? { playlistId } : {}) },
  });

export const searchMissingTrackManually = (
  jobId,
  sourceId,
  { mode = "missing", playlistId = null } = {},
) =>
  postData(
    `/playlists/jobs/${encodeURIComponent(jobId)}/manual-search`,
    { sourceId, mode, ...(playlistId ? { playlistId } : {}) },
    { timeout: 150_000 },
  );

export const downloadManualMissingSearchResult = (jobId, sessionId, resultId) =>
  postData(
    `/playlists/jobs/${encodeURIComponent(jobId)}/manual-search/select`,
    { sessionId, resultId },
  );

export const reSearchAllMissingTracks = () =>
  postData("/playlists/research-missing");

export const createFlow = (payload) => postData("/playlists/flows", payload);

export const getFlowTemplates = (options = {}) => getData("/playlists/flow-templates", options);

export const updateFlow = (flowId, payload) =>
  putData(`/playlists/flows/${flowId}`, payload);

export const deleteFlow = (flowId) => deleteData(`/playlists/flows/${flowId}`);

export const convertFlowToStaticPlaylist = (flowId, payload = {}) =>
  postData(
    `/playlists/flows/${flowId}/static-playlist`,
    payload,
  );

export const createStaticPlaylist = (payload) =>
  postData("/playlists/static-playlists", payload);

export const setFlowEnabled = (flowId, enabled) =>
  putData(`/playlists/flows/${flowId}/enabled`, {
    enabled,
  });

export const importStaticPlaylist = (payload) =>
  postData(
    "/playlists/static-playlists/import",
    payload,
  );

export const updateStaticPlaylist = (playlistId, payload) =>
  putData(
    `/playlists/static-playlists/${playlistId}`,
    payload,
  );

export const setPlaylistTrackAvailability = (playlistId, enabled) =>
  putData(`/playlists/static-playlists/${encodeURIComponent(playlistId)}/track-availability`, { enabled });

export const setPlaylistRecordHistory = (playlistId, enabled) =>
  putData(`/playlists/static-playlists/${encodeURIComponent(playlistId)}/record-history`, { enabled });

export const addStaticPlaylistTracks = (playlistId, payload) =>
  postData(
    `/playlists/static-playlists/${playlistId}/tracks`,
    payload,
  );

export const deleteStaticPlaylist = (playlistId) =>
  deleteData(
    `/playlists/static-playlists/${playlistId}`,
  );

export const deleteStaticPlaylistTrack = (playlistId, jobId) =>
  deleteData(
    `/playlists/static-playlists/${playlistId}/tracks/${jobId}`,
  );

export const reSearchStaticPlaylistTrack = (playlistId, jobId) =>
  postData(
    `/playlists/static-playlists/${playlistId}/tracks/${jobId}/research`,
  );

export const reSearchFlowTrack = (playlistId, jobId) =>
  postData(
    `/playlists/flows/${encodeURIComponent(playlistId)}/tracks/${encodeURIComponent(jobId)}/research`,
  );

export const searchTrackUpgrade = (playlistId, jobId) =>
  postData(
    `/playlists/quality-upgrades/${encodeURIComponent(playlistId)}/${encodeURIComponent(jobId)}`,
  );

export const searchAllUpgrades = () => postData("/playlists/quality-upgrades");

export const approveBlockedJob = (jobId) =>
  postData(`/playlists/jobs/${jobId}/approve`);

export const denyBlockedJob = (jobId) =>
  postData(`/playlists/jobs/${jobId}/deny`);

export const startFlow = (flowId, limit = 30) =>
  postData(`/playlists/start/${flowId}`, {
    limit,
  });

export const getSpotifyImportStatus = () => getData("/playlists/import/spotify/status");

export const startSpotifyOAuth = (callbackUrl) =>
  postData("/playlists/import/spotify/oauth/start", { callbackUrl });

export const completeSpotifyOAuth = (payload) =>
  postData("/playlists/import/spotify/oauth/complete", payload);

export const disconnectSpotify = () => deleteData("/playlists/import/spotify");

export const getSpotifyPlaylists = () => getData("/playlists/import/spotify/playlists");

export const previewSpotifyPlaylist = (playlistId) =>
  postData("/playlists/import/spotify/preview", { playlistId });

export const importSpotifyPlaylist = (payload) =>
  postData("/playlists/import/spotify", payload);

export const getListenBrainzPlaylists = () =>
  getData("/playlists/import/listenbrainz/playlists");

export const previewListenBrainzPlaylist = (playlistId, playlistType = null) =>
  postData("/playlists/import/listenbrainz/preview", {
    playlistId,
    ...(playlistType ? { playlistType } : {}),
  });

export const importListenBrainzPlaylist = (payload) =>
  postData("/playlists/import/listenbrainz", payload);

export const getLastfmPlaylists = (username = "") =>
  getData("/playlists/import/lastfm/playlists", {
    params: username ? { username } : undefined,
  });

export const previewLastfmPlaylist = (playlistId, username = "") =>
  postData("/playlists/import/lastfm/preview", {
    playlistId,
    username,
  });

export const importLastfmPlaylist = (payload) =>
  postData("/playlists/import/lastfm", payload);

export const previewYoutubeMusicPlaylist = (url) =>
  postData("/playlists/import/youtube-music/preview", { url }, { timeout: 5 * 60 * 1000 });

export const importYoutubeMusicPlaylist = (payload) =>
  postData("/playlists/import/youtube-music", payload, { timeout: 5 * 60 * 1000 });

export const syncStaticPlaylistImport = (playlistId) =>
  postData(`/playlists/static-playlists/${encodeURIComponent(playlistId)}/sync`, undefined, {
    timeout: 5 * 60 * 1000,
  });

export const getFlowLidarrImportListUrl = (flowId) =>
  getData(`/playlists/flows/${encodeURIComponent(flowId)}/lidarr-import-list`);

export const removeStaticPlaylistTracks = (playlistId, jobIds) =>
  postData(`/playlists/static-playlists/${encodeURIComponent(playlistId)}/track-removals`, { jobIds });

export const moveStaticPlaylistTracks = (playlistId, jobIds, target) =>
  postData(`/playlists/static-playlists/${encodeURIComponent(playlistId)}/track-moves`, { jobIds, target });

export const getStaticPlaylistOperation = (playlistId, operationId, options) =>
  getData(`/playlists/static-playlists/${encodeURIComponent(playlistId)}/operations/${encodeURIComponent(operationId)}`, options);

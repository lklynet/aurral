import {
  getData,
  postData,
  putData,
  deleteData,
  buildAuthenticatedApiUrl,
} from "../core.js";
import { queryClient, queryKeys } from "../../../queryClient.js";

export const getFlowTrackStreamUrl = (jobId) =>
  buildAuthenticatedApiUrl(`/playlists/stream/${encodeURIComponent(jobId)}`);

export const getStagingStreamUrl = (jobId) =>
  buildAuthenticatedApiUrl(`/playlists/staging-stream/${encodeURIComponent(jobId)}`);

export const getFlowArtworkUrl = (playlistId, version = "current") =>
  buildAuthenticatedApiUrl(
    `/playlists/artwork/${encodeURIComponent(playlistId)}`,
    { v: version },
  );

export const uploadFlowArtwork = (playlistId, file) =>
  putData(
    `/playlists/artwork/${encodeURIComponent(playlistId)}`,
    file,
    {
      headers: {
        "Content-Type": file.type || "application/octet-stream",
      },
    },
  );

export const deleteFlowArtwork = (playlistId) =>
  deleteData(
    `/playlists/artwork/${encodeURIComponent(playlistId)}`,
  );

export const generateFlowArtwork = (playlistId) =>
  postData(
    `/playlists/artwork/${encodeURIComponent(playlistId)}/generate`,
  );

export const getFlowStatus = ({ signal, bypassCache = false } = {}) => {
  if (bypassCache) return getData("/playlists/status", { signal });
  return queryClient.fetchQuery({
    queryKey: queryKeys.playlistStatus,
    queryFn: ({ signal: querySignal }) => getData("/playlists/status", { signal: querySignal }),
    staleTime: 4_000,
  });
};

export const getFlowJobs = (flowId, limit = null, options = {}) => {
  const params = { ...(options.params || {}) };
  const parsedLimit = Number(limit);
  if (Number.isFinite(parsedLimit) && parsedLimit > 0) {
    params.limit = Math.floor(parsedLimit);
  }
  return getData(`/playlists/jobs/${flowId}`, {
    ...options,
    params,
  });
};

export const getAllFlowJobs = (options = {}) =>
  getData("/playlists/jobs", options);

export const reSearchAllMissingTracks = () =>
  postData("/playlists/research-missing");

export const createFlow = (payload) => postData("/playlists/flows", payload);

export const updateFlow = (flowId, payload) =>
  putData(`/playlists/flows/${flowId}`, payload);

export const deleteFlow = (flowId) => deleteData(`/playlists/flows/${flowId}`);

export const convertFlowToStaticPlaylist = (flowId, payload = {}) =>
  postData(
    `/playlists/flows/${flowId}/static-playlist`,
    payload,
  );

export const createSharedPlaylist = (payload) =>
  postData("/playlists/shared-playlists", payload);

export const setFlowEnabled = (flowId, enabled) =>
  putData(`/playlists/flows/${flowId}/enabled`, {
    enabled,
  });

export const importSharedPlaylist = (payload) =>
  postData(
    "/playlists/shared-playlists/import",
    payload,
  );

export const updateSharedPlaylist = (playlistId, payload) =>
  putData(
    `/playlists/shared-playlists/${playlistId}`,
    payload,
  );

export const addSharedPlaylistTracks = (playlistId, payload) =>
  postData(
    `/playlists/shared-playlists/${playlistId}/tracks`,
    payload,
  );

export const deleteSharedPlaylist = (playlistId) =>
  deleteData(
    `/playlists/shared-playlists/${playlistId}`,
  );

export const deleteSharedPlaylistTrack = (playlistId, jobId) =>
  deleteData(
    `/playlists/shared-playlists/${playlistId}/tracks/${jobId}`,
  );

export const reSearchSharedPlaylistTrack = (playlistId, jobId) =>
  postData(
    `/playlists/shared-playlists/${playlistId}/tracks/${jobId}/research`,
  );

export const reSearchFlowTrack = (playlistId, jobId) =>
  postData(
    `/playlists/flows/${encodeURIComponent(playlistId)}/tracks/${encodeURIComponent(jobId)}/research`,
  );

export const reSearchMissingSharedPlaylistTracks = (playlistId) =>
  postData(
    `/playlists/shared-playlists/${playlistId}/research-missing`,
  );

export const searchTrackUpgrade = (playlistId, jobId) =>
  postData(
    `/playlists/quality-upgrades/${encodeURIComponent(playlistId)}/${encodeURIComponent(jobId)}`,
  );

export const searchPlaylistUpgrades = (playlistId) =>
  postData(`/playlists/quality-upgrades/${encodeURIComponent(playlistId)}`);

export const searchAllUpgrades = () => postData("/playlists/quality-upgrades");

export const approveBlockedJob = (jobId) =>
  postData(`/playlists/jobs/${jobId}/approve`);

export const denyBlockedJob = (jobId) =>
  postData(`/playlists/jobs/${jobId}/deny`);

export const startFlowPlaylist = (flowId, limit = 30) =>
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

export const syncSharedPlaylistImport = (playlistId) =>
  postData(`/playlists/shared-playlists/${encodeURIComponent(playlistId)}/sync`);

export const getFlowLidarrImportListUrl = (flowId) =>
  getData(`/playlists/flows/${encodeURIComponent(flowId)}/lidarr-import-list`);

import { getData, postData, putData, patchData, deleteData, lidarrCredentialParams } from "../core.js";
import { queryClient, queryKeys } from "../../../queryClient.js";

export const checkHealth = ({ force = false, signal } = {}) =>
  queryClient.fetchQuery({
    queryKey: queryKeys.appHealth,
    queryFn: ({ signal: querySignal }) => getData("/health", { signal: signal || querySignal }),
    staleTime: force ? 0 : 5_000,
  });

export const checkHealthLive = () => getData("/health/live", { timeout: 5000 });

export const invalidateBootstrapCache = () => {
  queryClient.removeQueries({ queryKey: queryKeys.authBootstrap });
};

export const getBootstrapStatus = ({ signal } = {}) =>
  queryClient.fetchQuery({
    queryKey: queryKeys.authBootstrap,
    queryFn: ({ signal: querySignal }) =>
      getData("/health/bootstrap", { signal: signal || querySignal }),
    staleTime: 25_000,
  });

export const browseFilesystem = (pathValue) =>
  getData("/filesystem/browse", {
    params: pathValue ? { path: pathValue } : undefined,
  });

export const ensureFilesystemPath = (pathValue) =>
  postData("/filesystem/ensure", {
    path: pathValue,
  });

export const loginApi = async (username, password) => {
  const result = await postData("/auth/login", { username, password });
  invalidateBootstrapCache();
  return result;
};

export const exchangeOidcCode = (code) => postData("/auth/oidc/exchange", { code });

export const logoutApi = async () => {
  const result = await postData("/auth/logout");
  invalidateBootstrapCache();
  return result;
};

export const getMe = () => getData("/auth/me");

export const getApiKey = () => getData("/auth/api-key");

export const rotateApiKey = () => postData("/auth/api-key/rotate");

export const completeOnboarding = async (payload) => {
  const result = await postData("/onboarding/complete", payload);
  invalidateBootstrapCache();
  return result;
};

export const testLidarrOnboarding = (url, apiKey) =>
  getData("/onboarding/lidarr/test", {
    params: lidarrCredentialParams(url, apiKey, { trimUrl: true }),
  });

export const getLidarrProfilesOnboarding = (url, apiKey) =>
  getData("/onboarding/lidarr/profiles", {
    params: lidarrCredentialParams(url, apiKey),
  });

export const getLidarrMetadataProfilesOnboarding = (url, apiKey) =>
  getData("/onboarding/lidarr/metadata-profiles", {
    params: lidarrCredentialParams(url, apiKey),
  });

export const getUsers = () => getData("/users");

export const createUser = (username, password, role, permissions) =>
  postData("/users", {
    username,
    password,
    role,
    permissions,
  });

export const updateUser = (id, data) => patchData(`/users/${id}`, data);

export const deleteUser = async (id) => {
  await deleteData(`/users/${id}`);
};

export const changeMyPassword = async (currentPassword, newPassword) => {
  await postData("/users/me/password", { currentPassword, newPassword });
};

export const getMyListeningHistory = ({ signal } = {}) =>
  getData("/users/me/listening-history", { signal });

export const recordPlayEvent = (payload) => postData("/play-events", payload);

export const getScrobbleStatus = () => getData("/scrobbling/status");
export const getLastfmScrobbleLink = () => getData("/scrobbling/lastfm/link");
export const linkListenBrainz = (token) =>
  putData("/scrobbling/listenbrainz/link", { token });
export const unlinkScrobbleProvider = (provider) =>
  deleteData(`/scrobbling/${provider}/link`);
export const linkKoito = (token, url) =>
  putData("/scrobbling/koito/link", { token, url });

export const getMyLidarrPreferences = ({ signal } = {}) =>
  getData("/users/me/lidarr-preferences", { signal });

export const getMyDiscoverLayout = () => getData("/users/me/discover-layout");

export const updateMyListeningHistory = (userId, payload) =>
  patchData(`/users/${userId}`, payload);

export const updateMyLidarrPreferences = (payload) =>
  patchData("/users/me/lidarr-preferences", payload);

export const updateMyDiscoverLayout = (layout) =>
  patchData("/users/me/discover-layout", { layout });

export const getMyPlexLinkStatus = () => getData("/users/me/plex-link/status");

export const startMyPlexLinkPin = (forwardUrl) =>
  postData("/users/me/plex-link/oauth/pin", { forwardUrl });

export const completeMyPlexLink = (pinId, code, clientId) =>
  postData("/users/me/plex-link/oauth/complete", { pinId, code, clientId });

export const disconnectMyPlex = async () => {
  await deleteData("/users/me/plex-link");
};

export const getPlexHomeUsersForAdmin = () => getData("/users/plex-link/home-users");

export const linkManagedPlexUser = (userId, plexUserId, { plexUsername, plexUuid, pin } = {}) =>
  postData(`/users/${userId}/plex-link/managed`, {
    plexUserId,
    plexUsername,
    plexUuid,
    pin,
  });

export const adminUnlinkPlex = async (userId) => {
  await deleteData(`/users/${userId}/plex-link`);
};

import { getData, postData, patchData, deleteData, fetchInflightOnce, bootstrapInflight, lidarrCredentialParams } from "../core.js";

export const checkHealth = () => getData("/health");

export const checkHealthLive = () => getData("/health/live", { timeout: 5000 });

const BOOTSTRAP_CACHE_TTL_MS = 25_000;
let bootstrapCache = null;

export const invalidateBootstrapCache = () => {
  bootstrapCache = null;
};

export const getBootstrapStatus = () => {
  if (bootstrapCache && Date.now() - bootstrapCache.at < BOOTSTRAP_CACHE_TTL_MS) {
    return Promise.resolve(bootstrapCache.value);
  }
  return fetchInflightOnce(bootstrapInflight, "bootstrap", () => {
    const at = Date.now();
    return getData("/health/bootstrap").then((value) => {
      bootstrapCache = { at, value };
      return value;
    });
  });
};

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

export const exchangeGoogleCode = (code) => postData("/auth/google/exchange", { code });

export const reauthApi = (currentPassword) => postData("/auth/reauth", { currentPassword });

export const startPlexLoginPin = (forwardUrl) => postData("/auth/plex/login/pin", { forwardUrl });

export const completePlexLogin = (pinId, code, clientId) =>
  postData("/auth/plex/login/complete", { pinId, code, clientId });

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

export const getMyListeningHistory = () => getData("/users/me/listening-history");

export const getMyLidarrPreferences = () =>
  getData("/users/me/lidarr-preferences");

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

export const getMyIdentities = () => getData("/users/me/identities");

export const unlinkMyIdentity = async (identityId) => {
  await deleteData(`/users/me/identities/${identityId}`);
};

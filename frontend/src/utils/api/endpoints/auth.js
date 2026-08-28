import api, {
  getData,
  postData,
  putData,
  patchData,
  deleteData,
  lidarrCredentialParams,
  setStoredAuth,
} from "../core.js";
import { queryClient, queryKeys } from "../../../queryClient.js";

export const checkHealth = ({ force = false } = {}) =>
  queryClient.fetchQuery({
    queryKey: queryKeys.appHealth,
    queryFn: ({ signal: querySignal }) => getData("/health", { signal: querySignal }),
    staleTime: force ? 0 : 5_000,
  });

export const checkHealthLive = () => getData("/health/live", { timeout: 5000 });

export const invalidateBootstrapCache = () => {
  queryClient.removeQueries({ queryKey: queryKeys.authBootstrap });
};

export const getBootstrapStatus = () =>
  queryClient.fetchQuery({
    queryKey: queryKeys.authBootstrap,
    queryFn: ({ signal: querySignal }) =>
      getData("/health/bootstrap", { signal: querySignal }),
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

export const loginApi = async (identifier, password) => {
  const value = String(identifier || "").trim();
  const response = await api.post("/auth/sign-in/username", { username: value, password });
  const token = response.headers.get("set-auth-token");
  if (token) setStoredAuth({ token });
  invalidateBootstrapCache();
  const result = response.data;
  if (token && result && typeof result === "object" && !Array.isArray(result) && !result.token) {
    return { ...result, token };
  }
  return token && !result ? { token } : result;
};

export const startOidcLogin = async (callbackURL) => {
  const response = await api.post("/auth/sign-in/social", {
    provider: "oidc",
    callbackURL,
    disableRedirect: true,
  });
  const result = response.data;
  const url = result?.url || result?.redirectURL;
  if (!url) throw new Error("The authentication provider did not return a redirect URL");
  return url;
};

export const logoutApi = async () => {
  const response = await api.post("/auth/sign-out");
  invalidateBootstrapCache();
  return response.data;
};

export const getMe = async () => {
  const response = await api.get("/auth/get-session");
  const token = response.headers.get("set-auth-token");
  if (token) setStoredAuth({ token });
  return response.data;
};

export const getApiKey = () => getData("/aurral-auth/api-key");

export const rotateApiKey = () => postData("/aurral-auth/api-key/rotate");

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

export const createUser = ({ username, name, password, role, permissions }) =>
  postData("/users", {
    username,
    name,
    password,
    role,
    permissions,
  });

export const updateUser = async (id, data = {}) => {
  const { password, role, ...userData } = data;
  let result;
  if (Object.keys(userData).length > 0) {
    result = await postData("/auth/admin/update-user", {
      userId: String(id),
      data: userData,
    });
  }
  if (role) {
    result = await postData("/auth/admin/set-role", {
      userId: String(id),
      role,
    });
  }
  if (password) {
    result = await postData("/auth/admin/set-user-password", {
      userId: String(id),
      newPassword: password,
    });
  }
  return result;
};

export const deleteUser = async (id) => {
  await postData("/auth/admin/remove-user", { userId: String(id) });
};

export const changeMyPassword = async (currentPassword, newPassword) => {
  await postData("/auth/change-password", {
    currentPassword,
    newPassword,
    revokeOtherSessions: true,
  });
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

import { getData, postData, putData, patchData, deleteData } from "../core.ts";
import { queryClient, queryKeys } from "../../../queryClient.ts";
import type { buildOnboardingPayload } from "../../onboardingPayload.ts";
import type { listBrowseDirectory } from "../../../../../backend/services/downloadFolderConfig.ts";
import type { resolveListenHistorySettings } from "../../../../../backend/services/listeningHistory.ts";
import type { recordPlayEvent as recordPlayEventService } from "../../../../../backend/services/playEventService.ts";
import type { LidarrNamedProfile } from "../../../../../backend/services/lidarrClient.ts";
import type {
  BootstrapPayload,
  HealthLiveResponse,
  HealthResponse,
} from "../../../../../backend/routes/health.ts";
import type {
  ApiKeyResponse,
  AuthUrlResponse,
  CurrentUserResponse,
  GoogleExchangeResponse,
  LoginResponse,
  OidcExchangeResponse,
  PlexLoginCompleteResponse,
  SuccessResponse,
} from "../../../../../backend/routes/auth.ts";
import type {
  KoitoLinkResponse,
  LastfmLinkResponse,
  ListenBrainzLinkResponse,
  ScrobbleStatusResponse,
} from "../../../../../backend/routes/scrobbling.ts";
import type {
  LidarrTestResponse,
  OnboardingCompleteResponse,
} from "../../../../../backend/routes/onboarding.ts";
import type {
  CreateUserResponse,
  DiscoverLayoutItem,
  DiscoverLayoutResponse,
  LidarrPreferencesResponse,
  UnconfiguredLidarrPreferencesResponse,
  SavedDiscoverLayoutResponse,
  SavedUserThemeResponse,
  UpdateUserResponse,
  UserListResponse,
  UserThemeResponse,
} from "../../../../../backend/routes/users.ts";
import type {
  PlexCompleteResponse,
  PlexConnectedResponse,
  PlexHomeUsersResponse,
  PlexLinkStatusResponse,
  PlexPinResponse,
} from "../../../../../backend/routes/users/plexLinkHandlers.ts";
import type { UserIdentitiesResponse } from "../../../../../backend/routes/users/identityLinkHandlers.ts";

type SignalOptions = { signal?: AbortSignal };

type ListeningHistoryUpdate = {
  listenHistoryProvider: string;
  listenHistoryUsername: string | null;
  listenHistoryUrl: string | null;
};

type PlayEventPayload = {
  trackId: string;
  title: string;
  artist: string;
  album?: string | null;
  artistMbid?: string | null;
  albumMbid?: string | null;
  trackMbid?: string | null;
  durationMs?: number | null;
  playedAt?: number;
  source?: string;
};

type LidarrPreferencesUpdate = {
  rootFolderPath: string | null;
  qualityProfileId: number | null;
};

export const fetchHealth = ({ signal }: SignalOptions = {}): Promise<HealthResponse> =>
  getData("/health", { signal });

export const checkHealth = ({ force = false } = {}) =>
  queryClient.fetchQuery({
    queryKey: queryKeys.appHealth,
    queryFn: ({ signal: querySignal }) => fetchHealth({ signal: querySignal }),
    staleTime: force ? 0 : 5_000,
  });

export const checkHealthLive = (): Promise<HealthLiveResponse> =>
  getData("/health/live", { timeout: 5000 });

export const invalidateBootstrapCache = () => {
  queryClient.removeQueries({ queryKey: queryKeys.authBootstrap });
};

export const getBootstrapStatus = (): Promise<BootstrapPayload> =>
  queryClient.fetchQuery({
    queryKey: queryKeys.authBootstrap,
    queryFn: ({ signal: querySignal }) => getData("/health/bootstrap", { signal: querySignal }),
    staleTime: 25_000,
  });

export const browseFilesystem = (
  pathValue?: string,
): Promise<ReturnType<typeof listBrowseDirectory>> =>
  getData("/filesystem/browse", {
    params: pathValue ? { path: pathValue } : undefined,
  });

export const ensureFilesystemPath = (
  pathValue: string,
): Promise<ReturnType<typeof listBrowseDirectory> & { path: string; created: boolean }> =>
  postData("/filesystem/ensure", {
    path: pathValue,
  });

export const loginApi = async (
  username: string | undefined,
  password: string,
): Promise<LoginResponse> => {
  const result = await postData("/auth/login", { username, password });
  invalidateBootstrapCache();
  return result;
};

export const exchangeOidcCode = (code: string): Promise<OidcExchangeResponse> =>
  postData("/auth/oidc/exchange", { code });

export const exchangeGoogleCode = (code: string): Promise<GoogleExchangeResponse> =>
  postData("/auth/google/exchange", { code });

export const startGoogleLink = (): Promise<AuthUrlResponse> => postData("/auth/google/link/start");

export const startOidcLink = (): Promise<AuthUrlResponse> => postData("/auth/oidc/link/start");

export const reauthApi = (currentPassword: string): Promise<SuccessResponse> =>
  postData("/auth/reauth", { currentPassword });

export const startPlexLoginPin = (forwardUrl?: string): Promise<AuthUrlResponse> =>
  postData("/auth/plex/login/pin", { forwardUrl });

export const completePlexLogin = (): Promise<PlexLoginCompleteResponse> =>
  postData("/auth/plex/login/complete");

export const logoutApi = async (): Promise<SuccessResponse> => {
  const result = await postData("/auth/logout");
  invalidateBootstrapCache();
  return result;
};

export const getMe = (): Promise<CurrentUserResponse> => getData("/auth/me");

export const getApiKey = ({ signal }: SignalOptions = {}): Promise<ApiKeyResponse> =>
  getData("/auth/api-key", { signal });

export const rotateApiKey = (): Promise<ApiKeyResponse> => postData("/auth/api-key/rotate");

export const completeOnboarding = async (
  payload: ReturnType<typeof buildOnboardingPayload>,
): Promise<OnboardingCompleteResponse> => {
  const result = await postData("/onboarding/complete", payload);
  invalidateBootstrapCache();
  return result;
};

export const testLidarrOnboarding = (url: string, apiKey: string): Promise<LidarrTestResponse> =>
  postData("/onboarding/lidarr/test", { url, apiKey });

export const getLidarrProfilesOnboarding = (
  url: string,
  apiKey: string,
): Promise<LidarrNamedProfile[]> => postData("/onboarding/lidarr/profiles", { url, apiKey });

export const getLidarrMetadataProfilesOnboarding = (
  url: string,
  apiKey: string,
): Promise<LidarrNamedProfile[]> =>
  postData("/onboarding/lidarr/metadata-profiles", { url, apiKey });

export const getUsers = (): Promise<UserListResponse> => getData("/users");

export const createUser = (
  username: string,
  password: string,
  role: string,
  permissions: Record<string, boolean>,
): Promise<CreateUserResponse> =>
  postData("/users", {
    username,
    password,
    role,
    permissions,
  });

export type UserUpdate = {
  password?: string;
  currentPassword?: string;
  permissions?: Record<string, boolean>;
  role?: string;
  status?: "active" | "suspended" | "disabled";
  allowIdentityAdoption?: boolean;
  listenHistoryProvider?: string;
  listenHistoryUsername?: string | null;
  listenHistoryUrl?: string | null;
  lastfmUsername?: string;
};

export const updateUser = (id: number, data: UserUpdate): Promise<UpdateUserResponse> =>
  patchData(`/users/${id}`, data);

export const deleteUser = async (id: number) => {
  await deleteData(`/users/${id}`);
};

export const changeMyPassword = async (currentPassword: string, newPassword: string) => {
  await postData("/users/me/password", { currentPassword, newPassword });
};

export const getMyListeningHistory = ({ signal }: SignalOptions = {}): Promise<
  ReturnType<typeof resolveListenHistorySettings>
> => getData("/users/me/listening-history", { signal });

export const recordPlayEvent = (
  payload: PlayEventPayload,
): Promise<{ event: ReturnType<typeof recordPlayEventService> }> =>
  postData("/play-events", payload);

export const getScrobbleStatus = ({
  signal,
}: SignalOptions = {}): Promise<ScrobbleStatusResponse> =>
  getData("/scrobbling/status", { signal });
export const getLastfmScrobbleLink = (): Promise<LastfmLinkResponse> =>
  getData("/scrobbling/lastfm/link");
export const linkListenBrainz = (token: string): Promise<ListenBrainzLinkResponse> =>
  putData("/scrobbling/listenbrainz/link", { token });
export const unlinkScrobbleProvider = (provider: "lastfm" | "listenbrainz" | "koito") =>
  deleteData(`/scrobbling/${provider}/link`);
export const linkKoito = (token: string, url: string): Promise<KoitoLinkResponse> =>
  putData("/scrobbling/koito/link", { token, url });

export const getMyLidarrPreferences = ({
  signal,
}: SignalOptions = {}): Promise<LidarrPreferencesResponse> =>
  getData("/users/me/lidarr-preferences", { signal });

export const getMyDiscoverLayout = (): Promise<DiscoverLayoutResponse> =>
  getData("/users/me/discover-layout");

export const getMyTheme = (): Promise<UserThemeResponse> => getData("/users/me/theme");

export const saveMyTheme = (theme: unknown): Promise<SavedUserThemeResponse> =>
  putData("/users/me/theme", { theme });

export const updateMyListeningHistory = (
  userId: number | undefined,
  payload: ListeningHistoryUpdate,
): Promise<UpdateUserResponse> => patchData(`/users/${userId}`, payload);

export const updateMyLidarrPreferences = (
  payload: LidarrPreferencesUpdate,
): Promise<LidarrPreferencesResponse | UnconfiguredLidarrPreferencesResponse> =>
  patchData("/users/me/lidarr-preferences", payload);

export const updateMyDiscoverLayout = (
  layout: DiscoverLayoutItem[],
): Promise<SavedDiscoverLayoutResponse> => patchData("/users/me/discover-layout", { layout });

export const getMyPlexLinkStatus = ({
  signal,
}: SignalOptions = {}): Promise<PlexLinkStatusResponse> =>
  getData("/users/me/plex-link/status", { signal });

export const startMyPlexLinkPin = (forwardUrl?: string): Promise<PlexPinResponse> =>
  postData("/users/me/plex-link/oauth/pin", { forwardUrl });

export const completeMyPlexLink = (
  pinId: string | number,
  code: string,
  clientId: string,
): Promise<PlexCompleteResponse> =>
  postData("/users/me/plex-link/oauth/complete", { pinId, code, clientId });

export const disconnectMyPlex = async () => {
  await deleteData("/users/me/plex-link");
};

export const getPlexHomeUsersForAdmin = ({
  signal,
}: SignalOptions = {}): Promise<PlexHomeUsersResponse> =>
  getData("/users/plex-link/home-users", { signal });

export const linkManagedPlexUser = (
  userId: number,
  plexUserId: string | number,
  {
    plexUsername,
    plexUuid,
    pin,
  }: { plexUsername?: string | null; plexUuid?: string | null; pin?: string } = {},
): Promise<PlexConnectedResponse> =>
  postData(`/users/${userId}/plex-link/managed`, {
    plexUserId,
    plexUsername,
    plexUuid,
    pin,
  });

export const adminUnlinkPlex = async (userId: number, { force = false } = {}) => {
  await deleteData(`/users/${userId}/plex-link`, force ? { params: { force: true } } : undefined);
};

export const getMyIdentities = (): Promise<UserIdentitiesResponse> =>
  getData("/users/me/identities");

export const unlinkMyIdentity = async (identityId: number) => {
  await deleteData(`/users/me/identities/${identityId}`);
};

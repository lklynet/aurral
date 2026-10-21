import { getData, postData, lidarrCredentialParams } from "../core.ts";
import { queryClient, queryKeys } from "../../../queryClient.ts";
import type { AppSettings } from "../../../../../backend/db/helpers/settings.ts";
import type { computeLibraryRootOverlaps } from "../../../../../backend/services/downloadFolderConfig.ts";
import type { PlexClient } from "../../../../../backend/services/plex.ts";
import type { getPlaybackDestinationSettings } from "../../../../../backend/services/playback/playbackDestinationSettings.ts";
import type { getDownloadClientSettings as getDownloadClientSettingsRecord } from "../../../../../backend/services/download/downloadClientSettings.ts";
import type { ConnectionTestResponse } from "../../../../../backend/routes/settings/handlers/downloadClients.ts";
import type { LidarrConnectionTestResponse } from "../../../../../backend/routes/settings/handlers/lidarr.ts";
import type { prowlarrClient } from "../../../../../backend/services/prowlarrClient.ts";
import type {
  clearStaleHonkerJobs,
  getHonkerTaskStatus,
} from "../../../../../backend/services/honkerTaskStatus.ts";
import type {
  checkUpgradeReadiness,
  queueUpgradeReadinessRecheck,
} from "../../../../../backend/services/upgradeReadiness.ts";
import type { getStorageHealthSnapshot } from "../../../../../backend/services/storageHealthService.ts";
import type {
  applyCommunityGuide,
  fetchMetadataProfiles,
  fetchQualityProfiles,
  fetchRootFolders,
  fetchTags,
  testLidarrLibraryAccess as testLidarrLibraryAccessRecord,
} from "../../../../../backend/services/lidarrSettingsService.ts";

export type AppSettingsResponse = AppSettings & {
  rootWarnings: ReturnType<typeof computeLibraryRootOverlaps>;
};

type PlexPin = { id: number; code: string };
type PlexIdentity = { machineIdentifier: string; version: string };
type PlexLibrary = { key: string; title: string };
type LidarrLibraryAccessTest = Awaited<ReturnType<typeof testLidarrLibraryAccessRecord>>;
type StorageHealthSnapshot = NonNullable<ReturnType<typeof getStorageHealthSnapshot>>;
type HonkerTasks = Awaited<ReturnType<typeof getHonkerTaskStatus>>;
type SuccessMessage = { success: true; message: string };

export const startPlexAuth = (
  forwardUrl?: string,
): Promise<{ pinId: PlexPin["id"]; code: PlexPin["code"]; clientId: string; authUrl: string }> =>
  postData("/settings/plex/auth/pin", { forwardUrl });

export const checkPlexAuth = (
  pinId: PlexPin["id"],
  code: PlexPin["code"],
): Promise<
  | { pending: true; token?: undefined; plexUsername?: undefined }
  | { token: string; plexUsername: string | null; pending?: undefined }
> => postData("/settings/plex/auth/check", { pinId, code });

export const getPlexResources = (
  token: string,
): Promise<Awaited<ReturnType<typeof PlexClient.getResources>>> =>
  postData("/settings/plex/resources", { token });

export const testPlexConnection = (
  url: string,
  token: string,
): Promise<
  SuccessMessage & {
    machineIdentifier: PlexIdentity["machineIdentifier"];
    version: PlexIdentity["version"];
  }
> =>
  postData("/settings/plex/test", {
    url: url?.replace(/\/+$/, ""),
    token,
  });

export const testNavidromeConnection = (
  url: string,
  username: string,
  password: string,
): Promise<SuccessMessage> =>
  postData("/settings/navidrome/test", {
    url: url?.replace(/\/+$/, ""),
    username,
    password,
  });

export const syncPlexNow = (): Promise<{
  success: true;
  configured: true;
  indexedTracks: number;
  scanInProgress: boolean;
  playlists: { title: string; count: number | null }[];
}> => postData("/settings/plex/sync");

export const getPlexLibraries = (): Promise<{
  libraries: { key: PlexLibrary["key"]; title: PlexLibrary["title"] }[];
}> => getData("/settings/plex/libraries");

export const checkPlexLibraryAccess = (
  sectionId: string,
): Promise<
  { checked: false; reason: string } | { checked: true; accessible: boolean; reportedPath: string }
> => getData(`/settings/plex/libraries/${encodeURIComponent(sectionId)}/access-check`);

export const fetchAppSettings = ({
  signal,
}: { signal?: AbortSignal } = {}): Promise<AppSettingsResponse> => getData("/settings", { signal });

export const getAppSettings = () =>
  queryClient.fetchQuery({
    queryKey: queryKeys.appSettings,
    queryFn: ({ signal }) => fetchAppSettings({ signal }),
    staleTime: 30_000,
  });

export const fetchPlaybackSettings = ({ signal }: { signal?: AbortSignal } = {}): Promise<{
  destinations: ReturnType<typeof getPlaybackDestinationSettings>;
}> => getData("/settings/playback", { signal });

export const getPlaybackSettings = () =>
  queryClient.fetchQuery({
    queryKey: queryKeys.playbackSettings,
    queryFn: ({ signal }) => fetchPlaybackSettings({ signal }),
    staleTime: 30_000,
  });
export const testPlaybackConnection = (key: string, config: unknown): Promise<{ success: true }> =>
  postData(`/settings/playback/${encodeURIComponent(key)}/test`, config);

export const fetchDownloadClientSettings = ({ signal }: { signal?: AbortSignal } = {}): Promise<{
  clients: ReturnType<typeof getDownloadClientSettingsRecord>;
}> => getData("/settings/download-clients", { signal });

export const getDownloadClientSettings = () =>
  queryClient.fetchQuery({
    queryKey: queryKeys.downloadClientSettings,
    queryFn: ({ signal }) => fetchDownloadClientSettings({ signal }),
    staleTime: 30_000,
  });

export const testDownloadClientConnection = (
  key: string,
  config: unknown,
): Promise<ConnectionTestResponse> =>
  postData(`/settings/download-clients/${encodeURIComponent(key)}/test`, config);

export const updateAppSettings = (settings: Partial<AppSettings>): Promise<AppSettingsResponse> =>
  postData("/settings", settings);

export const getLidarrRootFolders = (
  url: string | undefined,
  apiKey: string | undefined,
  { signal }: { signal?: AbortSignal } = {},
): Promise<Awaited<ReturnType<typeof fetchRootFolders>>> =>
  getData("/settings/lidarr/root-folders", {
    params: lidarrCredentialParams(url, apiKey),
    signal,
  });

export const getLidarrProfiles = (
  url: string | undefined,
  apiKey: string | undefined,
  { signal }: { signal?: AbortSignal } = {},
): Promise<Awaited<ReturnType<typeof fetchQualityProfiles>>> =>
  getData("/settings/lidarr/profiles", {
    params: lidarrCredentialParams(url, apiKey),
    signal,
  });

export const getLidarrMetadataProfiles = (
  url: string | undefined,
  apiKey: string | undefined,
  { signal }: { signal?: AbortSignal } = {},
): Promise<Awaited<ReturnType<typeof fetchMetadataProfiles>>> =>
  getData("/settings/lidarr/metadata-profiles", {
    params: lidarrCredentialParams(url, apiKey),
    signal,
  });

export const getLidarrTags = (
  url: string | undefined,
  apiKey: string | undefined,
  { signal }: { signal?: AbortSignal } = {},
): Promise<Awaited<ReturnType<typeof fetchTags>>> =>
  getData("/settings/lidarr/tags", {
    params: lidarrCredentialParams(url, apiKey),
    signal,
  });

export const testSlskdConnection = (): Promise<ConnectionTestResponse> =>
  postData("/settings/slskd/test");

export const testProwlarrConnection = (): Promise<
  ConnectionTestResponse & ProwlarrIndexersResponse
> => postData("/settings/prowlarr/test");

type ProwlarrIndexersResponse = {
  indexers: Awaited<ReturnType<typeof prowlarrClient.listUsenetIndexers>>;
};

export const getProwlarrIndexers = ({
  signal,
}: { signal?: AbortSignal } = {}): Promise<ProwlarrIndexersResponse> =>
  getData("/settings/prowlarr/indexers", { signal });

export const testNzbgetConnection = (): Promise<ConnectionTestResponse> =>
  postData("/settings/nzbget/test");

export const testSabnzbdConnection = (): Promise<ConnectionTestResponse> =>
  postData("/settings/sabnzbd/test");

export const testYtdlpConnection = (): Promise<ConnectionTestResponse> =>
  postData("/settings/ytdlp/test");

export const testLidarrConnection = (
  url: string | undefined,
  apiKey: string | undefined,
): Promise<LidarrConnectionTestResponse> =>
  getData("/settings/lidarr/test", {
    params: lidarrCredentialParams(url, apiKey),
  });

export const testLidarrLibraryAccess = (
  url: string | undefined,
  apiKey: string | undefined,
): Promise<
  { success: boolean; ok: boolean; partial: boolean } & Pick<
    LidarrLibraryAccessTest,
    "steps" | "sample"
  >
> =>
  getData("/settings/lidarr/test-library-access", {
    params: lidarrCredentialParams(url, apiKey),
  });

export const getStorageHealth = ({ signal }: { signal?: AbortSignal } = {}): Promise<
  { success: boolean } & (
    | StorageHealthSnapshot
    | { ok: null; partial: false; checkedAt: null; sections: never[]; unavailable: true }
  )
> => getData("/settings/storage-health", { signal });

export const runStorageHealthCheck = ({ signal }: { signal?: AbortSignal } = {}): Promise<
  { success: boolean } & NonNullable<ReturnType<typeof getStorageHealthSnapshot>>
> => postData("/settings/storage-health/check", {}, { signal });

export const getSettingsTasks = ({ signal }: { signal?: AbortSignal } = {}): Promise<HonkerTasks> =>
  getData("/settings/tasks", { signal });

export const clearSettingsStaleTasks = (): Promise<
  Awaited<ReturnType<typeof clearStaleHonkerJobs>> & { tasks: HonkerTasks }
> => postData("/settings/tasks/clear-stale");

export const testGotifyConnection = (url: string, token: string): Promise<SuccessMessage> =>
  postData("/settings/gotify/test", { url, token });

export const testWebhookConnection = (webhook: unknown): Promise<SuccessMessage> =>
  postData("/settings/webhook/test", webhook);

export const applyLidarrCommunityGuide = (): Promise<
  SuccessMessage & { results: Awaited<ReturnType<typeof applyCommunityGuide>> }
> => postData("/settings/lidarr/apply-community-guide");

export const getUpgradeReadiness = ({ signal }: { signal?: AbortSignal } = {}): Promise<
  ReturnType<typeof checkUpgradeReadiness>
> => getData("/settings/upgrade-readiness", { signal });

export const recheckUpgradeReadiness = (): Promise<{
  queued: ReturnType<typeof queueUpgradeReadinessRecheck>;
}> => postData("/settings/upgrade-readiness/recheck");

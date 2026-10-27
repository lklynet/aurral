import { Hono } from "hono";
import type { RequestUser } from "../middleware/requestUser.ts";
import type { AppSettings } from "../db/helpers/settings.ts";
import fs from "fs/promises";
import os from "os";
import path from "path";
import {
  getLastfmApiKey,
  getNewsSettings,
  getTicketmasterApiKey,
  getMetadataProviderHealthSnapshot,
} from "../services/apiClients/index.ts";
import { API_CONTRACT } from "../config/apiContract.ts";
import { APP_VERSION } from "../config/constants.ts";
import {
  resolveRequestUser,
  isAuthRequiredByConfig,
  isProxyAuthEnabled,
  issueProxySession,
  issueStreamToken,
  getLocalNetworkBypassStatus,
} from "../middleware/auth.ts";
import { getOidcBootstrapInfo } from "../services/oidcAuth.ts";
import { isGoogleLoginEnabled } from "../services/googleAuth.ts";
import { isPlexLoginEnabled } from "./users/plexLinkHandlers.ts";
import { lidarrClient } from "../services/lidarrClient.ts";
import { getDiscoveryCache } from "../services/discovery/index.ts";
import { getDiscoveryStatus } from "../services/discovery/userDiscovery.ts";
import { getCachedArtistCount } from "../services/libraryManager.ts";
import { logger } from "../services/logger.ts";
import { resolveDownloadRoot } from "../services/downloadPaths.ts";
import { getFilesystemBrowseRoots } from "../services/downloadFolderConfig.ts";
import { dbOps } from "../db/helpers/index.ts";
import { db } from "../config/db-sqlite.ts";
import { resolveAurralDataDir } from "../config/data-dir.ts";
import { websocketService } from "../services/websocketService.ts";
import { noCache } from "../middleware/cacheHeaders.ts";
import { requireAuth } from "../middleware/guards.ts";
import type { CredentialRequest } from "../middleware/auth.ts";
import type { AppEnv } from "../middleware/requestUser.ts";
import { requestCredentials } from "./shared/requestCredentials.ts";
import { getImageProxyCacheSizeBytes } from "../services/imageProxyService.ts";
import { getDownloadSourceStatus } from "../services/downloadSourceService.ts";
import { getMatcherStatus } from "../services/trackMatching/index.ts";
import { getMusicDataSourceName } from "../services/musicDataSource/index.ts";
import { asAppError } from "../../lib/errors.ts";

const STARTED_AT = Date.now();

function formatRuntimeMode() {
  return process.env.NODE_ENV || "production";
}

async function isRunningInDocker() {
  try {
    await fs.access("/.dockerenv");
    return true;
  } catch {}
  try {
    const cgroup = await fs.readFile("/proc/1/cgroup", "utf8");
    return /docker|kubepods|containerd|podman/i.test(cgroup);
  } catch {
    return false;
  }
}

function resolveDatabasePath() {
  const dataDir = resolveAurralDataDir();
  return process.env.AURRAL_DB_PATH
    ? path.resolve(process.env.AURRAL_DB_PATH)
    : path.join(dataDir, "aurral.db");
}

async function resolveExistingFilesystemPath(targetPath: string) {
  let current = path.resolve(String(targetPath || ""));
  while (current && current !== path.dirname(current)) {
    try {
      await fs.stat(current);
      return current;
    } catch {
      current = path.dirname(current);
    }
  }
  try {
    await fs.stat(current || path.sep);
    return current || path.sep;
  } catch {
    return null;
  }
}

async function getDiskSpaceEntry(location: string, role: string | null = null) {
  const displayLocation = String(location || "").trim();
  if (!displayLocation) return null;
  const statTarget = await resolveExistingFilesystemPath(displayLocation);
  if (!statTarget || typeof fs.statfs !== "function") {
    return {
      location: displayLocation,
      role,
      available: false,
      error: "Disk stats unavailable",
    };
  }

  try {
    const stats = await fs.statfs(statTarget);
    const blockSize = Number(stats.bsize || stats.frsize || 0);
    const availableBlocks = Number(stats.bavail ?? stats.bfree ?? 0);
    const totalBlocks = Number(stats.blocks || 0);
    if (!Number.isFinite(blockSize) || blockSize <= 0 || totalBlocks <= 0) {
      throw new Error("Filesystem did not report usable block counts");
    }
    const freeBytes = availableBlocks * blockSize;
    const totalBytes = totalBlocks * blockSize;
    return {
      location: displayLocation,
      role,
      statTarget,
      available: true,
      freeBytes,
      totalBytes,
      usedPercent: Math.min(
        100,
        Math.max(0, Math.round(((totalBytes - freeBytes) / totalBytes) * 100)),
      ),
    };
  } catch (error) {
    const failure = asAppError(error);
    return {
      location: displayLocation,
      role,
      statTarget,
      available: false,
      error: failure?.message || "Disk stats unavailable",
    };
  }
}

const DISK_SNAPSHOT_TTL_MS = 60_000;
type DiskSpacePayload = Awaited<ReturnType<typeof computeDiskSpacePayload>>;
let diskSnapshotCache: { at: number; payload: DiskSpacePayload | null } = { at: 0, payload: null };

async function buildDiskSpacePayload(settings: AppSettings) {
  if (diskSnapshotCache.payload && Date.now() - diskSnapshotCache.at < DISK_SNAPSHOT_TTL_MS) {
    return diskSnapshotCache.payload;
  }
  const payload = await computeDiskSpacePayload(settings);
  diskSnapshotCache = { at: Date.now(), payload };
  return payload;
}

async function computeDiskSpacePayload(settings: AppSettings) {
  const dataDir = resolveAurralDataDir();
  const dbPath = resolveDatabasePath();
  const downloadRoot = resolveDownloadRoot();
  const candidates = [
    { location: dataDir, role: "App data" },
    { location: path.dirname(dbPath), role: "Database" },
    { location: downloadRoot, role: "Downloads" },
    ...getFilesystemBrowseRoots().map((location) => ({
      location,
      role: "Browse root",
    })),
    ...(settings.rootFolderPath && path.isAbsolute(settings.rootFolderPath)
      ? [{ location: settings.rootFolderPath, role: "Lidarr root" }]
      : []),
    ...(Array.isArray(settings.pathMappings)
      ? settings.pathMappings.map((mapping) => ({
          location: mapping.local,
          role: `${mapping.source || "Path"} mapping`,
        }))
      : []),
  ];

  const seen = new Set();
  const unique = [];
  for (const candidate of candidates) {
    const location = String(candidate.location || "").trim();
    if (!location) continue;
    const key = path.resolve(location).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(candidate);
  }

  return (
    await Promise.all(
      unique.map((candidate) => getDiskSpaceEntry(candidate.location, candidate.role)),
    )
  ).filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
}

function readSqliteVersion() {
  try {
    return (
      db.prepare<[], { version: string }>("SELECT sqlite_version() AS version").get()?.version ||
      null
    );
  } catch {
    return null;
  }
}

async function buildSystemPayload(settings: AppSettings) {
  const dataDir = resolveAurralDataDir();
  const dbPath = resolveDatabasePath();
  const sqliteVersion = readSqliteVersion();
  return {
    startedAt: new Date(STARTED_AT).toISOString(),
    uptimeSeconds: Math.max(0, Math.floor((Date.now() - STARTED_AT) / 1000)),
    version: APP_VERSION,
    nodeVersion: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    mode: formatRuntimeMode(),
    docker: await isRunningInDocker(),
    dataDir,
    databasePath: dbPath,
    startupDirectory: process.cwd(),
    hostname: os.hostname(),
    database: {
      engine: "SQLite",
      version: sqliteVersion,
      label: sqliteVersion ? `SQLite ${sqliteVersion}` : "SQLite",
    },
    diskSpace: await buildDiskSpacePayload(settings),
    links: [
      { label: "Home page", value: "aurral.org", url: "https://aurral.org" },
      { label: "Documentation", value: "docs.aurral.org", url: "https://docs.aurral.org/" },
      {
        label: "Source",
        value: "github.com/lklynet/Aurral",
        url: "https://github.com/lklynet/Aurral",
      },
      {
        label: "Issues",
        value: "github.com/lklynet/Aurral/issues",
        url: "https://github.com/lklynet/Aurral/issues",
      },
    ],
  };
}

type HealthResponse = BootstrapPayload & {
  library?: { artistCount: number; lastScan: null };
  discovery?: ReturnType<typeof getDiscoveryStatus> & {
    provider: string;
    recommendationsCount: number;
    globalTopCount: number;
    artworkLinkCount: number;
    nativeImageCacheSizeBytes: number;
    cachedImagesCount: number;
    cachedImagesSizeBytes: number;
  };
  websocket?: {
    clients: number;
    channels: ReturnType<typeof websocketService.getStats>["channels"];
  };
  system?: Awaited<ReturnType<typeof buildSystemPayload>>;
};

type BootstrapPayload = {
  status: string;
  timestamp: string;
  appVersion: string;
  api: typeof API_CONTRACT;
  matcher: {
    available: boolean;
    checked: boolean;
    policyVersion: string | null;
    error: { code: string } | null;
  };
  authRequired: boolean;
  proxyAuthEnabled: boolean;
  oidcEnabled: boolean;
  oidcLogoutUrl: string | null;
  googleLoginEnabled: boolean;
  plexLoginEnabled: boolean;
  ssoOnly: boolean;
  onboardingRequired: boolean;
  dateTimeFormat: string;
  token?: string;
  user?: Pick<RequestUser, "id" | "username" | "role" | "permissions">;
  authUser?: string;
  proxyLogoutUrl?: string | null;
  rootFolderConfigured?: boolean;
  lidarr?: { configured: boolean; circuitOpen: boolean };
  lidarrConfigured?: boolean;
  lastfmConfigured?: boolean;
  ticketmasterConfigured?: boolean;
  inboxEnabled?: boolean;
  newsConfigured?: boolean;
  musicbrainzConfigured?: boolean;
  metadataConfigured?: boolean;
  slskdConfigured?: boolean;
  prowlarrConfigured?: boolean;
  nzbgetConfigured?: boolean;
  sabnzbdConfigured?: boolean;
  usenetConfigured?: boolean;
  ytdlpConfigured?: boolean;
  deemixConfigured?: boolean;
  downloadSources?: ReturnType<typeof getDownloadSourceStatus>;
  metadataProviders?: {
    brainzmash: {
      configuredProvider: string;
      activeBaseUrl: string;
      failoverActive: boolean;
      lastCheckedAt: string | null;
      lastSuccessAt: string | null;
      lastFailureAt: string | null;
      lastFailureReason: string;
    };
  };
  localNetworkBypass?: {
    enabled: boolean;
    eligible: boolean;
    active: boolean;
    reason: string | null;
  };
};

function serializeBootstrapMatcherStatus(
  status: BootstrapPayload["matcher"],
  authenticated: boolean,
) {
  if (authenticated) return status;
  return {
    available: Boolean(status.available),
    checked: Boolean(status.checked),
    policyVersion: status.policyVersion || null,
    error: status.error ? { code: status.error.code || "matcher_error" } : null,
  };
}

function buildBootstrapPayload(req: CredentialRequest) {
  lidarrClient.updateConfig();
  const settings = dbOps.getSettings();
  const onboardingDone = settings.onboardingComplete;
  const authRequired = isAuthRequiredByConfig();
  const currentUser = resolveRequestUser(req);
  const lidarrConfigured = lidarrClient.isConfigured();

  const oidcInfo = getOidcBootstrapInfo();
  const payload: BootstrapPayload = {
    status: "ok",
    authRequired,
    proxyAuthEnabled: isProxyAuthEnabled(),
    oidcEnabled: oidcInfo.oidcEnabled,
    oidcLogoutUrl: oidcInfo.oidcLogoutUrl,
    googleLoginEnabled: isGoogleLoginEnabled(),
    plexLoginEnabled: isPlexLoginEnabled(),
    ssoOnly: settings?.security?.ssoOnly === true,
    onboardingRequired: !onboardingDone,
    dateTimeFormat: settings.dateTimeFormat,
    timestamp: new Date().toISOString(),
    appVersion: APP_VERSION,
    api: API_CONTRACT,
    matcher: serializeBootstrapMatcherStatus(getMatcherStatus(), Boolean(currentUser)),
  };

  if (currentUser) {
    const downloadSources = getDownloadSourceStatus();
    payload.user = {
      id: currentUser.id,
      username: currentUser.username,
      role: currentUser.role,
      permissions: currentUser.permissions,
    };
    payload.authUser = currentUser.username;
    payload.rootFolderConfigured = lidarrConfigured || Boolean(resolveDownloadRoot());
    payload.lidarr = {
      configured: lidarrConfigured,
      circuitOpen: lidarrConfigured && lidarrClient.isCircuitOpen(),
    };
    payload.lidarrConfigured = lidarrConfigured;
    payload.lastfmConfigured = !!getLastfmApiKey();
    payload.ticketmasterConfigured = !!getTicketmasterApiKey();
    payload.inboxEnabled = settings.inbox?.enabled !== false;
    const newsSettings = getNewsSettings();
    payload.newsConfigured =
      newsSettings.enabled &&
      newsSettings.feeds.some(
        (feed) =>
          feed.enabled && (feed.group === "custom" || newsSettings.groups[feed.group] !== false),
      );
    payload.musicbrainzConfigured = !!settings.integrations?.metadata?.baseUrl;
    payload.metadataConfigured = !!settings.integrations?.metadata?.baseUrl;
    payload.slskdConfigured = downloadSources.slskd.configured;
    payload.prowlarrConfigured = downloadSources.usenet.prowlarrConfigured;
    payload.nzbgetConfigured = downloadSources.usenet.nzbgetConfigured;
    payload.sabnzbdConfigured = downloadSources.usenet.sabnzbdConfigured;
    payload.usenetConfigured = downloadSources.usenet.configured;
    payload.ytdlpConfigured = downloadSources.ytdlp.configured;
    payload.deemixConfigured = downloadSources.deemix.configured;
    payload.downloadSources = downloadSources;
    payload.metadataProviders = getMetadataProviderHealthSnapshot();
    payload.localNetworkBypass = getLocalNetworkBypassStatus(req);
    payload.proxyLogoutUrl = process.env.AUTH_PROXY_LOGOUT_URL || null;
    const proxySession = issueProxySession(req);
    if (proxySession) payload.token = proxySession.token;
  }

  return payload;
}

export default new Hono<AppEnv>()
  .basePath("/health")
  .get("/live", noCache, (c) => c.json({ status: "ok" }, 200))
  .get("/bootstrap", noCache, (c) => {
    try {
      return c.json(buildBootstrapPayload(requestCredentials(c)), 200);
    } catch (error) {
      const failure = asAppError(error);
      logger.error("health", "Bootstrap check error:", { message: failure?.message });
      return c.json({ error: "Internal server error" }, 500);
    }
  })
  .post("/stream-token", noCache, (c) => {
    const user = resolveRequestUser(requestCredentials(c));
    if (!user) {
      return c.json({ error: "Unauthorized", message: "Authentication required" }, 401);
    }
    return c.json({ token: issueStreamToken(user), expiresIn: 120 }, 200);
  })
  .get("/", noCache, async (c) => {
    try {
      const settings = dbOps.getSettings();
      const credentials = requestCredentials(c);
      const currentUser = resolveRequestUser(credentials);
      const payload: HealthResponse = buildBootstrapPayload(credentials);
      if (currentUser) {
        const discoveryCache = getDiscoveryCache();
        const wsStats = websocketService.getStats();
        const artistCount = getCachedArtistCount();
        payload.library = {
          artistCount: typeof artistCount === "number" ? artistCount : 0,
          lastScan: null,
        };
        const artworkLinkCount = dbOps.countImages();
        const nativeImageCacheSizeBytes = await getImageProxyCacheSizeBytes();
        payload.discovery = {
          provider: getMusicDataSourceName(),
          ...getDiscoveryStatus(currentUser.id),
          recommendationsCount: discoveryCache?.recommendations?.length || 0,
          globalTopCount: discoveryCache?.globalTop?.length || 0,
          artworkLinkCount,
          nativeImageCacheSizeBytes,
          cachedImagesCount: artworkLinkCount,
          cachedImagesSizeBytes: nativeImageCacheSizeBytes,
        };
        payload.websocket = {
          clients: wsStats.totalClients,
          channels: wsStats.channels,
        };
        payload.system = await buildSystemPayload(settings);
      }
      return c.json(payload, 200);
    } catch (error) {
      const failure = asAppError(error);
      logger.error("health", "Health check error:", { message: failure?.message });
      return c.json({ error: "Internal server error" }, 500);
    }
  })
  .get("/ws", requireAuth, noCache, (c) => {
    try {
      return c.json(websocketService.getStats(), 200);
    } catch {
      return c.json({ error: "Failed to get WebSocket stats" }, 500);
    }
  });

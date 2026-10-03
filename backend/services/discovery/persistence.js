import { dbOps } from "../../db/helpers/index.js";
import { websocketService } from "../websocketService.js";
import {
  DISCOVERY_PROVIDER_LASTFM,
  getDiscoveryCapabilities,
} from "../listenbrainzDiscoveryFallback.js";
import { isHonkerLockHeld } from "../honkerDb.js";

export const EMPTY_CACHE = {
  recommendations: [],
  globalTop: [],
  basedOn: [],
  topTags: [],
  topGenres: [],
  fallbackGenres: [],
  fallbackGenrePools: {},
  provider: DISCOVERY_PROVIDER_LASTFM,
  capabilities: getDiscoveryCapabilities(true),
  lastUpdated: null,
  metadata: {},
  recommendationQuality: null,
  isEnriching: false,
  discoveryRunId: null,
  enrichmentStartedAt: null,
  enrichmentCompletedAt: null,
  enrichmentProgressMessage: null,
};

let discoveryCache = { ...EMPTY_CACHE };

const dbData = dbOps.getDiscoveryCache();
if (
  dbData.lastUpdated ||
  dbData.recommendations?.length > 0 ||
  dbData.globalTop?.length > 0 ||
  dbData.topGenres?.length > 0 ||
  dbData.fallbackGenres?.length > 0 ||
  Object.keys(dbData.fallbackGenrePools || {}).length > 0
) {
  discoveryCache = {
    recommendations: dbData.recommendations || [],
    globalTop: dbData.globalTop || [],
    basedOn: dbData.basedOn || [],
    topTags: dbData.topTags || [],
    topGenres: dbData.topGenres || [],
    fallbackGenres: dbData.fallbackGenres || [],
    fallbackGenrePools: dbData.fallbackGenrePools || {},
    provider: dbData.provider || DISCOVERY_PROVIDER_LASTFM,
    capabilities: getDiscoveryCapabilities(
      (dbData.provider || DISCOVERY_PROVIDER_LASTFM) ===
        DISCOVERY_PROVIDER_LASTFM,
    ),
    lastUpdated: dbData.lastUpdated || null,
    metadata: dbData.metadata || {},
    recommendationQuality: dbData.recommendationQuality || null,
    isEnriching: dbData.isEnriching === true,
    discoveryRunId: dbData.discoveryRunId || null,
    enrichmentStartedAt: dbData.enrichmentStartedAt || null,
    enrichmentCompletedAt: dbData.enrichmentCompletedAt || null,
    enrichmentProgressMessage: dbData.enrichmentProgressMessage || null,
  };
}

export function resetDiscoveryModuleCache() {
  discoveryCache = { ...EMPTY_CACHE };
}

export function reloadDiscoveryPersistedCache() {
  const persisted = dbOps.getDiscoveryCache();
  Object.assign(discoveryCache, persisted, {
    provider: persisted.provider || DISCOVERY_PROVIDER_LASTFM,
    capabilities: getDiscoveryCapabilities(
      (persisted.provider || DISCOVERY_PROVIDER_LASTFM) === DISCOVERY_PROVIDER_LASTFM,
    ),
  });
}

export const getDiscoveryCache = () => discoveryCache;

export function synchronizeDiscoveryCacheFromWorker(update = {}) {
  if (!update || typeof update !== "object") return;
  if (update.isUpdating === false) {
    reloadDiscoveryPersistedCache();
  }
  for (const key of [
    "recommendations", "globalTop", "basedOn", "topTags", "topGenres",
    "fallbackGenres", "provider", "capabilities",
    "lastUpdated", "recommendationQuality", "isEnriching", "discoveryRunId",
    "enrichmentStartedAt", "enrichmentCompletedAt", "enrichmentProgressMessage",
  ]) {
    if (Object.hasOwn(update, key)) discoveryCache[key] = update[key];
  }
}

const REFRESH_TRACKING_WINDOW_MS = 2 * 60 * 60 * 1000;

export const getDiscoveryRefreshState = (metadata = {}, now = Date.now()) => {
  const requestedAt = Number(metadata?.refreshRequestedAt) || 0;
  const startedAt = Number(metadata?.refreshStartedAt) || 0;
  const finishedAt = Number(metadata?.refreshFinishedAt) || 0;
  const running = startedAt > finishedAt && now - startedAt < REFRESH_TRACKING_WINDOW_MS;
  return {
    running,
    pending: requestedAt > startedAt && now - requestedAt < REFRESH_TRACKING_WINDOW_MS,
    phase: running ? metadata.refreshPhase || null : null,
    progress: running && typeof metadata.refreshProgress === "number" ? metadata.refreshProgress : null,
    message: running ? metadata.refreshMessage || null : null,
    finishedAt,
    error: metadata?.refreshError || null,
  };
};

const updateRefreshMetadata = (namespace, metadata) =>
  dbOps.updateDiscoveryCache({ metadata }, namespace);

export const markDiscoveryRefreshRequested = (namespace = null, requestedAt = Date.now()) =>
  updateRefreshMetadata(namespace, { refreshRequestedAt: requestedAt });

export const markDiscoveryRefreshStarted = (namespace = null, startedAt = Date.now()) =>
  updateRefreshMetadata(namespace, {
    refreshStartedAt: startedAt,
    refreshPhase: null,
    refreshProgress: null,
    refreshMessage: null,
  });

export const markDiscoveryRefreshFinished = (namespace = null, { error = null } = {}) =>
  updateRefreshMetadata(namespace, {
    refreshFinishedAt: Date.now(),
    refreshError: error || null,
  });

export const markInterruptedDiscoveryRefresh = (error) => {
  const { metadata } = dbOps.getDiscoveryRefreshSource();
  if (!getDiscoveryRefreshState(metadata).running) return false;
  markDiscoveryRefreshFinished(null, { error });
  return true;
};

export const saveDiscoveryRefreshProgress = (namespace, phase, message, progress) => {
  const normalizedProgress = Math.max(0, Math.min(100, Math.round(Number(progress) || 0)));
  updateRefreshMetadata(namespace, {
    refreshPhase: phase || null,
    refreshProgress: normalizedProgress,
    refreshMessage: message || null,
  });
  return normalizedProgress;
};

export const recordDiscoveryUpdateProgress = (
  phase,
  progressMessage,
  progress,
  extra = {},
) => {
  websocketService.emitDiscoveryUpdate({
    phase: phase || null,
    progress: saveDiscoveryRefreshProgress(null, phase, progressMessage, progress),
    progressMessage: progressMessage || "",
    isUpdating: true,
    configured: true,
    ...extra,
  });
};

export { discoveryCache };

export const isGlobalDiscoveryRefreshInProgress = () =>
  isHonkerLockHeld("discovery-global-refresh");

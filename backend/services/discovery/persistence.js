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
  isUpdating: false,
  updatePhase: null,
  updateProgress: null,
  updateProgressMessage: null,
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
    isUpdating: false,
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
  for (const key of [
    "isUpdating", "updatePhase", "updateProgress", "updateProgressMessage",
  ]) {
    if (Object.hasOwn(update, key)) discoveryCache[key] = update[key];
  }
  if (Object.hasOwn(update, "phase")) discoveryCache.updatePhase = update.phase;
  if (Object.hasOwn(update, "progress")) discoveryCache.updateProgress = update.progress;
  if (Object.hasOwn(update, "progressMessage")) {
    discoveryCache.updateProgressMessage = update.progressMessage;
  }
}

export const recordDiscoveryUpdateProgress = (
  phase,
  progressMessage,
  progress,
  extra = {},
) => {
  const normalizedProgress = Math.max(
    0,
    Math.min(100, Math.round(Number(progress) || 0)),
  );
  discoveryCache.updatePhase = phase || null;
  discoveryCache.updateProgress = normalizedProgress;
  discoveryCache.updateProgressMessage = progressMessage || "";
  websocketService.emitDiscoveryUpdate({
    phase: discoveryCache.updatePhase,
    progress: discoveryCache.updateProgress,
    progressMessage: discoveryCache.updateProgressMessage,
    isUpdating: true,
    configured: true,
    ...extra,
  });
};

export const clearDiscoveryUpdateProgress = () => {
  discoveryCache.updatePhase = null;
  discoveryCache.updateProgress = null;
  discoveryCache.updateProgressMessage = null;
};

export const getDiscoveryUpdateStatus = () => ({
  updatePhase: discoveryCache.updatePhase || null,
  updateProgress:
    typeof discoveryCache.updateProgress === "number"
      ? discoveryCache.updateProgress
      : null,
  updateProgressMessage: discoveryCache.updateProgressMessage || null,
});

export { discoveryCache };

export const isGlobalDiscoveryRefreshInProgress = () =>
  isHonkerLockHeld("discovery-global-refresh");

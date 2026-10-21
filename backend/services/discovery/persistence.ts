import { dbOps } from "../../db/helpers/index.ts";
import type { DiscoveryCache, DiscoveryMetadata } from "../../db/helpers/discovery.ts";
import { websocketService } from "../websocketService.ts";
import { isHonkerLockHeld } from "../honkerDb.ts";

export const EMPTY_CACHE: DiscoveryCache = {
  recommendations: [],
  globalTop: [],
  basedOn: [],
  topTags: [],
  topGenres: [],
  provider: null,
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
  dbData.topGenres?.length > 0
) {
  discoveryCache = {
    recommendations: dbData.recommendations || [],
    globalTop: dbData.globalTop || [],
    basedOn: dbData.basedOn || [],
    topTags: dbData.topTags || [],
    topGenres: dbData.topGenres || [],
    provider: dbData.provider || null,
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
  Object.assign(discoveryCache, dbOps.getDiscoveryCache());
}

export const getDiscoveryCache = () => discoveryCache;

export function synchronizeDiscoveryCacheFromWorker(
  update: Partial<DiscoveryCache> & { isUpdating?: boolean; type?: string } = {},
) {
  if (!update || typeof update !== "object") return;
  if (update.isUpdating === false) {
    reloadDiscoveryPersistedCache();
  }
  for (const key of [
    "recommendations",
    "globalTop",
    "basedOn",
    "topTags",
    "topGenres",
    "provider",
    "lastUpdated",
    "recommendationQuality",
    "isEnriching",
    "discoveryRunId",
    "enrichmentStartedAt",
    "enrichmentCompletedAt",
    "enrichmentProgressMessage",
  ] as const) {
    if (Object.hasOwn(update, key))
      (discoveryCache as Partial<Record<keyof DiscoveryCache, unknown>>)[key] = update[key];
  }
}

const REFRESH_TRACKING_WINDOW_MS = 2 * 60 * 60 * 1000;

export const getDiscoveryRefreshState = (metadata: DiscoveryMetadata = {}, now = Date.now()) => {
  const requestedAt = Number(metadata?.refreshRequestedAt) || 0;
  const startedAt = Number(metadata?.refreshStartedAt) || 0;
  const finishedAt = Number(metadata?.refreshFinishedAt) || 0;
  const running = startedAt > finishedAt && now - startedAt < REFRESH_TRACKING_WINDOW_MS;
  return {
    running,
    pending: requestedAt > startedAt && now - requestedAt < REFRESH_TRACKING_WINDOW_MS,
    phase: running ? metadata.refreshPhase || null : null,
    progress:
      running && typeof metadata.refreshProgress === "number" ? metadata.refreshProgress : null,
    message: running ? metadata.refreshMessage || null : null,
    finishedAt,
    error: metadata?.refreshError || null,
  };
};

const updateRefreshMetadata = (namespace: string | null, metadata: DiscoveryMetadata) =>
  dbOps.updateDiscoveryCache({ metadata }, namespace);

export const markDiscoveryRefreshRequested = (
  namespace: string | null = null,
  requestedAt = Date.now(),
) => updateRefreshMetadata(namespace, { refreshRequestedAt: requestedAt });

export const markDiscoveryRefreshStarted = (
  namespace: string | null = null,
  startedAt = Date.now(),
) =>
  updateRefreshMetadata(namespace, {
    refreshStartedAt: startedAt,
    refreshPhase: null,
    refreshProgress: null,
    refreshMessage: null,
  });

export const markDiscoveryRefreshFinished = (
  namespace: string | null = null,
  { error = null }: { error?: string | null } = {},
) =>
  updateRefreshMetadata(namespace, {
    refreshFinishedAt: Date.now(),
    refreshError: error || null,
  });

export const markInterruptedDiscoveryRefresh = (
  error: string,
  {
    namespace = null,
    clearPending = false,
  }: { namespace?: string | null; clearPending?: boolean } = {},
) => {
  const state = getDiscoveryRefreshState(dbOps.getDiscoveryRefreshSource(namespace).metadata);
  if (!state.running && !(clearPending && state.pending)) return false;
  if (!state.running) markDiscoveryRefreshStarted(namespace);
  markDiscoveryRefreshFinished(namespace, { error });
  return true;
};

export const saveDiscoveryRefreshProgress = (
  namespace: string | null,
  phase: string,
  message: string,
  progress: number,
) => {
  const normalizedProgress = Math.max(0, Math.min(100, Math.round(Number(progress) || 0)));
  updateRefreshMetadata(namespace, {
    refreshPhase: phase || null,
    refreshProgress: normalizedProgress,
    refreshMessage: message || null,
  });
  return normalizedProgress;
};

export const recordDiscoveryUpdateProgress = (
  phase: string,
  progressMessage: string,
  progress: number,
  extra: { provider?: string } = {},
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

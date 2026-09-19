import { dbOps } from "../../db/helpers/index.js";
import { websocketService } from "../websocketService.js";
import {
  DISCOVERY_PROVIDER_LASTFM,
  getDiscoveryCapabilities,
} from "../listenbrainzDiscoveryFallback.js";
import {
  getListenHistoryCacheNamespace,
} from "../listeningHistory.js";
import { isHonkerLockHeld } from "../honkerDb.js";

export const EMPTY_CACHE = {
  recommendations: [],
  globalTop: [],
  basedOn: [],
  topTags: [],
  topGenres: [],
  fallbackGenres: [],
  fallbackGenrePools: {},
  discoverPlaylists: [],
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
  playlistsUpdating: false,
  playlistsUpdateMessage: null,
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
    discoverPlaylists: dbData.discoverPlaylists || [],
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

export const getDiscoveryCache = (listenHistoryProfile = null) => {
  const cacheNamespace =
    typeof listenHistoryProfile === "string"
      ? String(listenHistoryProfile).trim() || null
      : getListenHistoryCacheNamespace(listenHistoryProfile);
  if (cacheNamespace) {
    const userDbData = dbOps.getDiscoveryCache(cacheNamespace);
    const hasUserRecommendations = userDbData.recommendations?.length > 0;
    const hasUserBasedOn = userDbData.basedOn?.length > 0;
    if (hasUserRecommendations || hasUserBasedOn) {
      const globalDbData = dbOps.getDiscoveryCache();
      const recommendations = hasUserRecommendations
        ? userDbData.recommendations
        : globalDbData.recommendations || [];
      return {
        recommendations,
        globalTop: discoveryCache.globalTop.length
          ? discoveryCache.globalTop
          : globalDbData.globalTop || [],
        basedOn: userDbData.basedOn || [],
        topTags:
          userDbData.topTags?.length > 0
            ? userDbData.topTags
            : discoveryCache.topTags || [],
        topGenres:
          userDbData.topGenres?.length > 0
            ? userDbData.topGenres
            : discoveryCache.topGenres || [],
        fallbackGenres: discoveryCache.fallbackGenres || [],
        fallbackGenrePools: discoveryCache.fallbackGenrePools || {},
        discoverPlaylists:
          userDbData.discoverPlaylists?.length > 0
            ? userDbData.discoverPlaylists
            : discoveryCache.discoverPlaylists || [],
        provider: discoveryCache.provider || DISCOVERY_PROVIDER_LASTFM,
        capabilities:
          discoveryCache.capabilities ||
          getDiscoveryCapabilities(
            (discoveryCache.provider || DISCOVERY_PROVIDER_LASTFM) ===
              DISCOVERY_PROVIDER_LASTFM,
          ),
        lastUpdated:
          userDbData.lastUpdated || discoveryCache.lastUpdated || null,
        metadata: userDbData.metadata || discoveryCache.metadata || {},
        recommendationQuality:
          userDbData.recommendationQuality ||
          discoveryCache.recommendationQuality ||
          null,
        isEnriching:
          userDbData.isEnriching === true ||
          (!userDbData.recommendationQuality &&
            discoveryCache.isEnriching === true),
        discoveryRunId:
          userDbData.discoveryRunId || discoveryCache.discoveryRunId || null,
        enrichmentStartedAt:
          userDbData.enrichmentStartedAt ||
          discoveryCache.enrichmentStartedAt ||
          null,
        enrichmentCompletedAt:
          userDbData.enrichmentCompletedAt ||
          discoveryCache.enrichmentCompletedAt ||
          null,
        enrichmentProgressMessage:
          userDbData.enrichmentProgressMessage ||
          discoveryCache.enrichmentProgressMessage ||
          null,
        isUpdating: discoveryCache.isUpdating,
        updatePhase: discoveryCache.updatePhase || null,
        updateProgress:
          typeof discoveryCache.updateProgress === "number"
            ? discoveryCache.updateProgress
            : null,
        updateProgressMessage: discoveryCache.updateProgressMessage || null,
      };
    }
  }

  return discoveryCache;
};

export function synchronizeDiscoveryCacheFromWorker(update = {}) {
  if (!update || typeof update !== "object") return;
  if (update.isUpdating === false || update.playlistsUpdating === false) {
    Object.assign(discoveryCache, dbOps.getDiscoveryCache());
  }
  for (const key of [
    "recommendations", "globalTop", "basedOn", "topTags", "topGenres",
    "fallbackGenres", "discoverPlaylists", "provider", "capabilities",
    "lastUpdated", "recommendationQuality", "isEnriching", "discoveryRunId",
    "enrichmentStartedAt", "enrichmentCompletedAt", "enrichmentProgressMessage",
  ]) {
    if (Object.hasOwn(update, key)) discoveryCache[key] = update[key];
  }
  for (const key of [
    "isUpdating", "updatePhase", "updateProgress", "updateProgressMessage",
    "playlistsUpdating", "playlistsUpdateMessage",
  ]) {
    if (Object.hasOwn(update, key)) discoveryCache[key] = update[key];
  }
  if (Object.hasOwn(update, "phase")) discoveryCache.updatePhase = update.phase;
  if (Object.hasOwn(update, "progress")) discoveryCache.updateProgress = update.progress;
  if (Object.hasOwn(update, "progressMessage")) {
    discoveryCache.updateProgressMessage = update.progressMessage;
  }
}

export const getUserDiscoveryCacheStaleness = (cacheNamespace) => {
  const data = dbOps.getDiscoveryCache(cacheNamespace);
  if (!data.lastUpdated) return Infinity;
  return Date.now() - new Date(data.lastUpdated).getTime();
};

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

export const recordDiscoverPlaylistBuildProgress = (
  progressMessage = "Updating recommended playlists...",
  extra = {},
) => {
  discoveryCache.playlistsUpdating = true;
  discoveryCache.playlistsUpdateMessage = progressMessage || "";
  websocketService.emitDiscoveryUpdate({
    playlistsUpdating: true,
    playlistsUpdateMessage: progressMessage,
    phase: "playlists_building",
    progress: 98,
    progressMessage,
    isUpdating: false,
    configured: true,
    ...extra,
  });
};

export const clearDiscoverPlaylistBuildProgress = () => {
  discoveryCache.playlistsUpdating = false;
  discoveryCache.playlistsUpdateMessage = null;
};

const discoveryPlaylistBuildTokens = new Map();
const BUILD_TOKEN_TTL_MS = 60 * 60 * 1000;

const pruneDiscoveryPlaylistBuildTokens = () => {
  const cutoff = Date.now() - BUILD_TOKEN_TTL_MS;
  for (const [key, entry] of discoveryPlaylistBuildTokens) {
    if (entry.createdAt < cutoff) discoveryPlaylistBuildTokens.delete(key);
  }
};

export const setDiscoveryPlaylistBuildToken = (buildKey, token) => {
  pruneDiscoveryPlaylistBuildTokens();
  discoveryPlaylistBuildTokens.set(buildKey, { token, createdAt: Date.now() });
};

export const getDiscoveryPlaylistBuildToken = (buildKey) => {
  pruneDiscoveryPlaylistBuildTokens();
  return discoveryPlaylistBuildTokens.get(buildKey)?.token || null;
};

export const clearDiscoveryPlaylistBuildToken = (buildKey, token) => {
  if (discoveryPlaylistBuildTokens.get(buildKey)?.token === token) {
    discoveryPlaylistBuildTokens.delete(buildKey);
  }
};

const getDiscoveryPlaylistBuildKey = (cacheNamespace = null) =>
  String(cacheNamespace || "global");

export const getDiscoveryPlaylistBuildStatus = (cacheNamespace = null) => {
  const buildKey = getDiscoveryPlaylistBuildKey(cacheNamespace);
  const lockHeld = isHonkerLockHeld(`discovery-playlist-build:${buildKey}`);
  pruneDiscoveryPlaylistBuildTokens();
  const tokenPending = discoveryPlaylistBuildTokens.has(buildKey);
  const cacheFlag = !cacheNamespace && !!discoveryCache.playlistsUpdating;
  const updating = cacheFlag || lockHeld || tokenPending;
  const message = cacheFlag
    ? discoveryCache.playlistsUpdateMessage ||
      "Updating recommended playlists..."
    : "Updating recommended playlists...";
  return {
    playlistsUpdating: updating,
    playlistsUpdateMessage: updating ? message : null,
  };
};

export { discoveryCache, getDiscoveryPlaylistBuildKey };

export const isGlobalDiscoveryRefreshInProgress = () =>
  isHonkerLockHeld("discovery-global-refresh");

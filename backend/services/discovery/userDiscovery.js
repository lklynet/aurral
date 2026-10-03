import { dbOps } from "../../db/helpers/index.js";
import { getLastfmApiKey } from "../apiClients/index.js";
import {
  DISCOVERY_PROVIDER_LASTFM,
  DISCOVERY_PROVIDER_LISTENBRAINZ_FALLBACK,
  getDiscoveryCapabilities,
} from "../listenbrainzDiscoveryFallback.js";
import { getDiscoveryAutoRefreshHours, getDiscoveryMode } from "./helpers.js";
import {
  filterBlockedArtistsForUser,
  getBlockedArtistKeys,
  getDiscoveryFeedback,
} from "./feedback.js";
import { getDiscoveryCache, getDiscoveryUpdateStatus } from "./persistence.js";
import {
  getUserDiscoveryNamespace,
  getUserRefreshState,
  requestUserDiscoveryRefresh,
} from "./provider.js";
import { serveRecommendations, withArtistRouteId } from "./recommendationPipeline.js";
import { getLibraryArtistKeys, matchesArtistKeys } from "./artistKeys.js";

const FAILED_REFRESH_BACKOFF_MS = 15 * 60 * 1000;
const servedRecommendationsByUser = new Map();

const getServedRecommendations = ({ userId, source, feedback, discoveryMode, library, isVisible }) => {
  const key = [
    source.namespace,
    source.lastUpdated,
    source.discoveryRunId,
    discoveryMode,
    library.signature,
    feedback.map((entry) => `${entry.id}:${entry.action}`).join(","),
  ].join("|");
  const cached = servedRecommendationsByUser.get(userId);
  if (cached?.key === key) return cached.recommendations;
  const recommendations = serveRecommendations(
    (source.recommendations || []).filter(isVisible),
    { feedback, discoveryMode },
  );
  servedRecommendationsByUser.set(userId, { key, recommendations });
  return recommendations;
};

const ensureUserRefresh = (userId, userCache, refreshState) => {
  if (refreshState.pending || refreshState.running) return refreshState;
  const lastUpdatedMs = Date.parse(userCache.lastUpdated || "") || 0;
  const staleMs = getDiscoveryAutoRefreshHours() * 60 * 60 * 1000;
  const finishedAt = Number(userCache.metadata?.refreshFinishedAt) || 0;
  const needsRefresh = !lastUpdatedMs || Date.now() - lastUpdatedMs > staleMs;
  if (!needsRefresh || Date.now() - finishedAt < FAILED_REFRESH_BACKOFF_MS) return refreshState;
  const result = requestUserDiscoveryRefresh(userId, {
    reason: lastUpdatedMs ? "stale" : "missing",
  });
  return { ...refreshState, pending: refreshState.pending || result.enqueued };
};

export async function getUserDiscovery(userId, limit = 50, offset = 0) {
  const hasLastfmKey = !!getLastfmApiKey();
  const globalCache = getDiscoveryCache();
  const namespace = hasLastfmKey && userId != null ? getUserDiscoveryNamespace(userId) : null;
  const userCache = namespace ? dbOps.getDiscoveryCache(namespace) : null;
  const hasUserPool = Boolean(userCache?.lastUpdated);
  const refreshState = userCache
    ? ensureUserRefresh(userId, userCache, getUserRefreshState(userCache.metadata))
    : { running: false, pending: false };
  const source = hasUserPool
    ? { namespace, ...userCache }
    : { namespace: "global", ...globalCache };

  const feedbackUserId = userId ?? "global";
  const feedback = getDiscoveryFeedback(feedbackUserId);
  const blockedKeys = getBlockedArtistKeys(feedbackUserId, feedback);
  const library = getLibraryArtistKeys();
  const discoveryMode = getDiscoveryMode();
  const isVisible = (artist) =>
    !matchesArtistKeys(artist, library.keys) && !matchesArtistKeys(artist, blockedKeys);

  const recommendations = getServedRecommendations({
    userId: feedbackUserId,
    source,
    feedback,
    discoveryMode,
    library,
    isVisible,
  });
  const globalTop = (globalCache.globalTop || []).filter(isVisible).map(withArtistRouteId);
  const fallbackGenres = (Array.isArray(globalCache.fallbackGenres) ? globalCache.fallbackGenres : [])
    .map((section) => ({
      ...section,
      artists: filterBlockedArtistsForUser(feedbackUserId, section?.artists || [], blockedKeys),
    }));

  const userRefreshing = refreshState.running || (!hasUserPool && refreshState.pending);
  const isUpdating = Boolean(globalCache.isUpdating) || userRefreshing;
  const updateStatus = globalCache.isUpdating
    ? getDiscoveryUpdateStatus()
    : {
        updatePhase: "personalizing",
        updateProgress: null,
        updateProgressMessage: "Building your personal recommendations",
      };
  const lastUpdatedMs = Date.parse(source.lastUpdated || "");
  const staleMs = getDiscoveryAutoRefreshHours() * 60 * 60 * 1000;
  const limitClamped = Math.max(limit, 1);
  const offsetClamped = Math.max(offset, 0);

  return {
    cacheStrategy:
      recommendations.length > 0 || globalTop.length > 0
        ? "fresh"
        : isUpdating
          ? "updating"
          : "empty",
    body: {
      recommendations: limit
        ? recommendations.slice(offsetClamped, offsetClamped + limitClamped)
        : recommendations,
      recommendationCount: recommendations.length,
      globalTop,
      basedOn: source.basedOn || [],
      topTags: source.topTags || [],
      topGenres: source.topGenres || [],
      fallbackGenres,
      lastUpdated: source.lastUpdated || null,
      isUpdating,
      recommendationQuality: source.recommendationQuality || null,
      isEnriching: source.isEnriching === true,
      discoveryRunId: source.discoveryRunId || null,
      enrichmentStartedAt: source.enrichmentStartedAt || null,
      enrichmentCompletedAt: source.enrichmentCompletedAt || null,
      enrichmentProgressMessage: source.enrichmentProgressMessage || null,
      ...(isUpdating ? updateStatus : {}),
      stale: Number.isFinite(lastUpdatedMs) && lastUpdatedMs > 0 && Date.now() - lastUpdatedMs > staleMs,
      configured: true,
      provider: hasLastfmKey
        ? DISCOVERY_PROVIDER_LASTFM
        : globalCache.provider || DISCOVERY_PROVIDER_LISTENBRAINZ_FALLBACK,
      capabilities: globalCache.capabilities || getDiscoveryCapabilities(hasLastfmKey),
      discoveryMode,
    },
  };
}

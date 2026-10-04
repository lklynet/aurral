import { dbOps } from "../../db/helpers/index.js";
import { getMusicDataSourceName } from "../musicDataSource/index.js";
import { getDiscoveryAutoRefreshHours, getDiscoveryMode } from "./helpers.js";
import { getBlockedArtistKeys, getDiscoveryFeedback } from "./feedback.js";
import { getDiscoveryCache, getDiscoveryRefreshState } from "./persistence.js";
import { getUserDiscoveryNamespace, requestUserDiscoveryRefresh } from "./provider.js";
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

const ensureUserRefresh = (userId, userCache) => {
  const refreshState = getDiscoveryRefreshState(userCache.metadata);
  if (refreshState.pending || refreshState.running) return;
  const lastUpdatedMs = Date.parse(userCache.lastUpdated || "") || 0;
  const staleMs = getDiscoveryAutoRefreshHours() * 60 * 60 * 1000;
  const finishedAt = Number(userCache.metadata?.refreshFinishedAt) || 0;
  const needsRefresh = !lastUpdatedMs || Date.now() - lastUpdatedMs > staleMs;
  if (!needsRefresh || Date.now() - finishedAt < FAILED_REFRESH_BACKOFF_MS) return;
  requestUserDiscoveryRefresh(userId, {
    reason: lastUpdatedMs ? "stale" : "missing",
  });
};

const describeActiveRefresh = (global, user) => {
  if (global.running) {
    return {
      updatePhase: global.phase || "starting",
      updateProgress: global.progress,
      updateProgressMessage: global.message || "Refreshing discovery",
    };
  }
  if (global.pending) {
    return {
      updatePhase: "queued",
      updateProgress: null,
      updateProgressMessage: "Discovery refresh queued",
    };
  }
  if (user.running) {
    return {
      updatePhase: user.phase || "personalizing",
      updateProgress: user.progress,
      updateProgressMessage: user.message || "Building your recommendations",
    };
  }
  if (user.pending) {
    return {
      updatePhase: "queued",
      updateProgress: null,
      updateProgressMessage: "Waiting to build your recommendations",
    };
  }
  return null;
};

export function getDiscoveryStatus(userId) {
  const globalSource = dbOps.getDiscoveryRefreshSource();
  const userSource =
    userId != null ? dbOps.getDiscoveryRefreshSource(getUserDiscoveryNamespace(userId)) : null;
  const global = getDiscoveryRefreshState(globalSource.metadata);
  const user = getDiscoveryRefreshState(userSource?.metadata);
  const active = describeActiveRefresh(global, user);
  const latestFinished = user.finishedAt > global.finishedAt ? user : global;
  return {
    isUpdating: Boolean(active),
    updatePhase: active?.updatePhase || null,
    updateProgress: active?.updateProgress ?? null,
    updateProgressMessage: active?.updateProgressMessage || null,
    lastUpdated: userSource?.lastUpdated || globalSource.lastUpdated || null,
    error: active ? null : latestFinished.error,
  };
}

export function getUserDiscovery(userId, limit = 50, offset = 0) {
  const globalCache = getDiscoveryCache();
  const namespace = userId != null ? getUserDiscoveryNamespace(userId) : null;
  const userCache = namespace ? dbOps.getDiscoveryCache(namespace) : null;
  const hasUserPool = Boolean(userCache?.lastUpdated);
  if (userCache) ensureUserRefresh(userId, userCache);
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

  const limitClamped = Math.max(limit, 1);
  const offsetClamped = Math.max(offset, 0);

  return {
    body: {
      recommendations: limit
        ? recommendations.slice(offsetClamped, offsetClamped + limitClamped)
        : recommendations,
      recommendationCount: recommendations.length,
      globalTop,
      basedOn: source.basedOn || [],
      topTags: source.topTags || [],
      topGenres: source.topGenres || [],
      lastUpdated: source.lastUpdated || null,
      recommendationQuality: source.recommendationQuality || null,
      isEnriching: source.isEnriching === true,
      discoveryRunId: source.discoveryRunId || null,
      enrichmentStartedAt: source.enrichmentStartedAt || null,
      enrichmentCompletedAt: source.enrichmentCompletedAt || null,
      enrichmentProgressMessage: source.enrichmentProgressMessage || null,
      configured: true,
      provider: getMusicDataSourceName(),
      discoveryMode,
    },
  };
}

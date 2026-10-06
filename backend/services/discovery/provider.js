import { dbOps, userOps } from "../../db/helpers/index.js";
import {
  lastfmRequest,
  listenbrainzRequest,
  musicbrainzGetCachedArtistMbidByName,
  musicbrainzResolveArtistMbidByName,
} from "../apiClients/index.js";
import { logger } from "../logger.js";
import { getListenHistoryProfile, hasListenHistoryProfile } from "../listeningHistory.js";
import {
  getLibraryArtistKeyProjection,
  sampleLibraryArtistsForDiscovery,
} from "../libraryQueryService.js";
import {
  buildExistingArtistKeySet,
  mergeResolvedRecommendations,
  mergeRetainedRecommendationPool,
  rerankRecommendations as rerankRecs,
  selectDiscoverySeeds,
} from "./recommendationPipeline.js";
import { getMusicDataSourceName, getTrendingArtists } from "../musicDataSource/index.js";
import { enqueueDiscoveryUserRefreshJob } from "../honkerDb.js";
import { websocketService } from "../websocketService.js";
import {
  getLastfmDiscoveryPeriod,
  getListenbrainzRange,
  getDiscoveryRecommendationsPerRefresh,
  getDiscoveryMode,
  getDiscoveryRecommendationPoolLimit,
  getDiscoveryUserRefreshDelaySeconds,
  getDiscoveryNetworkConcurrency,
  getDiscoveryRecommendationSeedLimit,
  createDiscoveryRunId,
  interleaveLists,
  mapWithConcurrency,
  DISCOVERY_QUALITY_ENRICHED,
} from "./helpers.js";
import { getDiscoveryFeedback } from "./feedback.js";
import {
  discoveryCache,
  getDiscoveryRefreshState,
  markDiscoveryRefreshFinished,
  markDiscoveryRefreshRequested,
  markInterruptedDiscoveryRefresh,
  markDiscoveryRefreshStarted,
  recordDiscoveryUpdateProgress,
  saveDiscoveryRefreshProgress,
  isGlobalDiscoveryRefreshInProgress,
} from "./persistence.js";
import { buildTagProfile, collectSeedTags } from "./tasteProfile.js";
import { buildRecommendationsFromSeeds } from "./recommendations.js";
import { getTopPlayedArtists } from "../playEventService.js";

const USER_REFRESH_STAGGER_SECONDS = 15;
const GLOBAL_REFRESH_RETRY_SECONDS = 60;

export const getUserDiscoveryNamespace = (userId) => `user:${userId}`;

const emitUserDiscoveryUpdate = (userId, data) =>
  websocketService.emitDiscoveryUpdate({ configured: true, ...data }, { userId });

const enqueueUserRefreshJob = (userId, { reason, delaySeconds }) => {
  const requestedAt = Date.now();
  markDiscoveryRefreshRequested(getUserDiscoveryNamespace(userId), requestedAt);
  const operationId = enqueueDiscoveryUserRefreshJob(
    { userId, requestedAt, reason },
    { delaySeconds, priority: -10 },
  );
  emitUserDiscoveryUpdate(userId, {
    isUpdating: true,
    phase: "queued",
    progressMessage: "Waiting to build your recommendations",
  });
  return operationId;
};

export const markInterruptedUserDiscoveryRefresh = (userId, error) => {
  const namespace = getUserDiscoveryNamespace(userId);
  if (!markInterruptedDiscoveryRefresh(error, { namespace })) return false;
  emitUserDiscoveryUpdate(userId, {
    isUpdating: false,
    phase: "error",
    progressMessage: "Discovery refresh failed",
    error,
  });
  return true;
};

export const requestUserDiscoveryRefresh = (
  userId,
  { reason = "manual", delaySeconds = getDiscoveryUserRefreshDelaySeconds() } = {},
) => {
  if (userId == null) {
    return { enqueued: false, reason: "not_configured" };
  }
  const { metadata } = dbOps.getDiscoveryCache(getUserDiscoveryNamespace(userId));
  if (getDiscoveryRefreshState(metadata).pending) {
    return { enqueued: false, reason: "queued" };
  }
  const operationId = enqueueUserRefreshJob(userId, { reason, delaySeconds });
  return { enqueued: true, operationId };
};

const enqueueAllUserDiscoveryRefreshes = (reason) => {
  const users = userOps.getAllUsers().filter((user) => (user.status || "active") === "active");
  const baseDelay = getDiscoveryUserRefreshDelaySeconds();
  let queued = 0;
  users.forEach((user, index) => {
    const result = requestUserDiscoveryRefresh(user.id, {
      reason,
      delaySeconds: baseDelay + index * USER_REFRESH_STAGGER_SECONDS,
    });
    if (result.enqueued) queued += 1;
  });
  return queued;
};

const fetchListenHistoryArtists = async (listenHistoryProfile, discoveryPeriod) => {
  const profile = getListenHistoryProfile(listenHistoryProfile);
  if (!hasListenHistoryProfile(profile) || discoveryPeriod === "none") {
    return [];
  }

  if (profile.listenHistoryProvider === "listenbrainz") {
    const data = await listenbrainzRequest(
      `/1/stats/user/${encodeURIComponent(profile.listenHistoryUsername)}/artists`,
      {
        count: 50,
        range: getListenbrainzRange(discoveryPeriod),
      },
    );
    const artists = Array.isArray(data?.payload?.artists) ? data.payload.artists : [];
    return artists
      .map((artist) => {
        const mbid = Array.isArray(artist.artist_mbids)
          ? artist.artist_mbids.find(Boolean)
          : artist.artist_mbid || null;
        return {
          mbid: mbid || musicbrainzGetCachedArtistMbidByName(artist.artist_name) || null,
          artistName: artist.artist_name,
          playcount: parseInt(artist.listen_count || 0, 10) || 0,
        };
      })
      .filter((artist) => artist.artistName);
  }

  if (profile.listenHistoryProvider === "koito") {
    const { fetchKoitoTopArtists } = await import("../koitoClient.js");
    return fetchKoitoTopArtists(profile.listenHistoryUrl, {
      discoveryPeriod,
      limit: 50,
    });
  }

  const userTopArtists = await lastfmRequest(
    "user.getTopArtists",
    {
      user: profile.listenHistoryUsername,
      limit: 50,
      period: discoveryPeriod,
    },
    { timeoutMs: 12000, maxRetries: 2 },
  );

  const artists = userTopArtists?.topartists?.artist;
  if (!artists) return [];
  return (Array.isArray(artists) ? artists : [artists])
    .map((artist) => {
      const artistName = String(artist?.name || "").trim();
      if (!artistName) return null;
      return {
        mbid:
          String(artist.mbid || "").trim() ||
          musicbrainzGetCachedArtistMbidByName(artistName) ||
          null,
        artistName,
        playcount: parseInt(artist.playcount || 0, 10) || 0,
      };
    })
    .filter(Boolean);
};

export const rerankCachedRecommendations = ({
  recommendations = [],
  feedback = [],
  discoveryMode = getDiscoveryMode(),
  limit = getDiscoveryRecommendationsPerRefresh(),
} = {}) =>
  rerankRecs(recommendations, limit, {
    feedback,
    discoveryMode,
  });

const resolveArtistMbids = (items) =>
  mapWithConcurrency(items, getDiscoveryNetworkConcurrency(), async (item) => {
    if (item?.id || !item?.name) return;
    const resolved =
      musicbrainzGetCachedArtistMbidByName(item.name) ||
      (await musicbrainzResolveArtistMbidByName(item.name));
    if (!resolved) return;
    item.id = resolved;
    item.navigateTo = resolved;
  });

const resolveRecommendationCandidates = async (recommendations, existingArtistKeys) => {
  const perRefresh = getDiscoveryRecommendationsPerRefresh();
  await resolveArtistMbids(recommendations.slice(0, perRefresh));
  return mergeResolvedRecommendations(recommendations, existingArtistKeys)
    .filter((item) => item?.id || item?.navigateTo)
    .sort((left, right) => {
      const leftScore = left.scoreTotal || left.score || 0;
      const rightScore = right.scoreTotal || right.score || 0;
      if (rightScore !== leftScore) return rightScore - leftScore;
      if ((right.seedCount || 0) !== (left.seedCount || 0)) {
        return (right.seedCount || 0) - (left.seedCount || 0);
      }
      return String(left.name || "").localeCompare(String(right.name || ""));
    })
    .slice(0, Math.max(120, perRefresh * 2));
};

const fetchTrendingArtists = async (existingArtistKeys) => {
  const trendingArtists = await getTrendingArtists({ limit: 100 });
  const globalTop = mergeResolvedRecommendations(trendingArtists, existingArtistKeys).slice(0, 32);
  await resolveArtistMbids(globalTop);
  return mergeResolvedRecommendations(globalTop, existingArtistKeys)
    .filter((item) => item?.id || item?.navigateTo)
    .slice(0, 32);
};

const recordHistory = (method, ...args) =>
  import("../aurralHistoryService.js")
    .then((history) => history[method](...args))
    .catch((err) => { logger.warn('discovery', err); });

const publishGlobalDiscovery = (discoveryData) => {
  Object.assign(discoveryCache, discoveryData);
  dbOps.updateDiscoveryCache(discoveryData);
  markDiscoveryRefreshFinished();
  websocketService.emitDiscoveryUpdate({
    isUpdating: false,
    configured: true,
    provider: discoveryData.provider,
    lastUpdated: discoveryData.lastUpdated,
    phase: "completed",
    progress: 100,
    progressMessage: "Discovery refresh completed",
    discoveryMode: getDiscoveryMode(),
  });
};

export const updateDiscoveryCache = async (options = {}) => {
  const { withHonkerLock } = await import("../honkerDb.js");
  if (options.skipHonkerLock !== true) {
    return withHonkerLock(
      "discovery-global-refresh",
      () => updateDiscoveryCache({ ...options, skipHonkerLock: true }),
      {
        ttlSeconds: 3600,
        waitTimeoutMs: 30 * 60 * 1000,
        retryDelayMs: 500,
      },
    );
  }
  markDiscoveryRefreshStarted();
  logger.info('discovery', "Starting background update of discovery data...");
  recordDiscoveryUpdateProgress("starting", "Preparing discovery refresh", 5);
  recordHistory("recordDiscoveryRefreshStarted");

  try {
    const provider = getMusicDataSourceName();
    logger.info('discovery', `Fetching global trending artists from ${provider}...`);
    recordDiscoveryUpdateProgress("fetching_trending", "Fetching global trending artists", 40, {
      provider,
    });
    const runStartedAt = new Date().toISOString();
    let globalTop = discoveryCache.provider === provider ? discoveryCache.globalTop || [] : [];
    try {
      globalTop = await fetchTrendingArtists(
        buildExistingArtistKeySet(getLibraryArtistKeyProjection()),
      );
      logger.info('discovery', `Found ${globalTop.length} trending artists.`);
    } catch (error) {
      logger.error('discovery', `Failed to fetch global trending artists: ${error.message}`);
    }

    try {
      const queuedUserRefreshes = enqueueAllUserDiscoveryRefreshes("global_refresh_completed");
      logger.info(
        'discovery',
        `Queued ${queuedUserRefreshes} personal recommendation refresh${queuedUserRefreshes === 1 ? "" : "es"}.`,
      );
    } catch (error) {
      logger.warn('discovery', "Failed to queue personal recommendation refreshes:", error.message);
    }

    publishGlobalDiscovery({
      provider,
      recommendations: [],
      globalTop,
      basedOn: [],
      topTags: [],
      topGenres: [],
      lastUpdated: runStartedAt,
      recommendationQuality: DISCOVERY_QUALITY_ENRICHED,
      isEnriching: false,
      discoveryRunId: createDiscoveryRunId(),
      enrichmentStartedAt: null,
      enrichmentCompletedAt: runStartedAt,
      enrichmentProgressMessage: null,
    });

    const { notifyDiscoveryUpdated } = await import("../notificationService.js");
    notifyDiscoveryUpdated().catch((err) =>
      logger.warn('discovery', "[Discovery] Notification failed:", err.message),
    );
    recordHistory("recordDiscoveryUpdated", { recommendationCount: 0, genreCount: 0 });

    try {
      const cleaned = dbOps.cleanOldImageCache(30);
      if (cleaned?.changes > 0) {
        logger.info('discovery', `[Discovery] Cleaned ${cleaned.changes} old image cache entries`);
      }
      dbOps.cleanOldMusicbrainzArtistMbidCache(90);
    } catch (e) {
      logger.warn('discovery', "[Discovery] Failed to clean old image cache:", e.message);
    }
  } catch (error) {
    logger.error('discovery', "Failed to update discovery cache:", error.message);
    logger.error('discovery', "Stack trace:", error.stack);
    markDiscoveryRefreshFinished(null, { error: error.message });
    websocketService.emitDiscoveryUpdate({
      isUpdating: false,
      configured: true,
      phase: "error",
      progress: 100,
      progressMessage: "Discovery refresh failed",
      error: error.message,
    });
    recordHistory("recordDiscoveryRefreshFailed", error.message);
  }
};

const feedbackArtists = (feedback, action) =>
  feedback
    .filter((entry) => entry.action === action)
    .map((entry) => ({ mbid: entry.artistId, artistName: entry.artistName }));

const collectUserSeeds = async (user, feedback) => {
  let externalHistory = [];
  const profile = getListenHistoryProfile(user);
  try {
    externalHistory = (
      await fetchListenHistoryArtists(profile, getLastfmDiscoveryPeriod())
    ).map((artist) => ({ ...artist, source: profile.listenHistoryProvider }));
  } catch (error) {
    logger.error(
      'discovery',
      `[Discovery] Failed to fetch ${profile.listenHistoryProvider} artists for user ${user.id}: ${error.message}`,
    );
  }
  const localHistory = getTopPlayedArtists(user.id, { limit: 50 }).map((artist) => ({
    ...artist,
    source: "local",
  }));
  const library = sampleLibraryArtistsForDiscovery({ recentLimit: 20, randomLimit: 40 });

  return selectDiscoverySeeds({
    likedArtists: feedbackArtists(feedback, "more_like_this"),
    historyArtists: interleaveLists(externalHistory, localHistory),
    libraryArtists: interleaveLists(library.recent, library.random),
    limit: getDiscoveryRecommendationSeedLimit(),
    excludedKeys: buildExistingArtistKeySet([
      ...feedbackArtists(feedback, "less_like_this"),
      ...feedbackArtists(feedback, "block_artist"),
    ]),
  });
};

const buildUserRecommendations = async ({ userId, user, existing, startedAt }) => {
  const sourceHealth = { success: 0, failure: 0 };
  const feedback = getDiscoveryFeedback(userId);
  const progress = (phase, progressMessage, value) =>
    emitUserDiscoveryUpdate(userId, {
      isUpdating: true,
      phase,
      progress: saveDiscoveryRefreshProgress(
        getUserDiscoveryNamespace(userId),
        phase,
        progressMessage,
        value,
      ),
      progressMessage,
    });

  progress("collecting_seeds", "Collecting your seed artists", 10);
  const seeds = await collectUserSeeds(user, feedback);
  const blockedArtists = feedbackArtists(feedback, "block_artist");
  const existingArtistKeys = buildExistingArtistKeySet([
    ...getLibraryArtistKeyProjection(),
    ...blockedArtists,
  ]);
  if (seeds.length === 0) {
    return { recommendations: [], seeds, topGenres: [] };
  }

  progress("building_genres", "Building your genre and tag profile", 30);
  const { tagMap, tagWeights } = await collectSeedTags(seeds, sourceHealth);
  const { profileTagWeights, topGenres } = buildTagProfile(tagWeights);

  progress("generating_recommendations", "Finding similar artists", 50);
  const discoveryMode = getDiscoveryMode();
  const rawRecommendations = await buildRecommendationsFromSeeds({
    seeds,
    existingArtistKeys,
    bridgeExclusionKeys: buildExistingArtistKeySet([
      ...feedbackArtists(feedback, "less_like_this"),
      ...blockedArtists,
    ]),
    sourceHealth,
    profileTagWeights,
    seedTagMap: tagMap,
    discoveryMode,
  });

  progress("resolving_artists", "Matching artists to MusicBrainz", 75);
  const freshRecommendations = rerankCachedRecommendations({
    recommendations: await resolveRecommendationCandidates(rawRecommendations, existingArtistKeys),
    discoveryMode,
  });
  const recommendations = mergeRetainedRecommendationPool({
    freshRecommendations,
    existingRecommendations: existing.recommendations || [],
    existingArtistKeys,
    limit: getDiscoveryRecommendationPoolLimit(),
    runStartedAt: new Date(startedAt).toISOString(),
    discoveryMode,
    feedback,
  });
  return { recommendations, seeds, topGenres };
};

export const updateUserDiscoveryCache = async (userId, options = {}) => {
  const { withHonkerLock } = await import("../honkerDb.js");
  if (options.skipHonkerLock !== true) {
    return withHonkerLock(
      `discovery-user-refresh:${userId}`,
      () => updateUserDiscoveryCache(userId, { ...options, skipHonkerLock: true }),
      {
        ttlSeconds: 1800,
        waitTimeoutMs: 30 * 60 * 1000,
        retryDelayMs: 500,
      },
    );
  }

  const namespace = getUserDiscoveryNamespace(userId);
  const user = userOps.getUserById(userId);
  if (!user) {
    dbOps.deleteDiscoveryCacheByPrefix(`${namespace}:`);
    return { skipped: true, reason: "user_missing" };
  }
  if (isGlobalDiscoveryRefreshInProgress()) {
    enqueueUserRefreshJob(userId, {
      reason: "global_refresh_in_progress",
      delaySeconds: GLOBAL_REFRESH_RETRY_SECONDS,
    });
    return { skipped: true, reason: "global_refresh_in_progress" };
  }
  const existing = dbOps.getDiscoveryCache(namespace);
  const requestedAt = Number(options.requestedAt) || 0;
  if (requestedAt && Number(existing.metadata?.lastRunStartedAt) >= requestedAt) {
    return { skipped: true, reason: "already_refreshed" };
  }

  const startedAt = Date.now();
  markDiscoveryRefreshStarted(namespace, startedAt);
  logger.info('discovery', `[Discovery] Building personal recommendations for user ${userId}...`);

  try {
    const { recommendations, seeds, topGenres } = await buildUserRecommendations({
      userId,
      user,
      existing,
      startedAt,
    });
    dbOps.updateDiscoveryCache(
      {
        recommendations,
        basedOn: seeds.map((seed) => ({
          name: seed.artistName,
          id: seed.mbid,
          source: seed.source,
          profileBucket: seed.profileBucket || null,
        })),
        topGenres,
        recommendationQuality: DISCOVERY_QUALITY_ENRICHED,
        discoveryRunId: createDiscoveryRunId(),
        metadata: { lastRunStartedAt: startedAt },
      },
      namespace,
    );
    markDiscoveryRefreshFinished(namespace);
    logger.info(
      'discovery',
      `[Discovery] User ${userId} refresh complete: ${recommendations.length} recommendations from ${seeds.length} seeds.`,
    );
    emitUserDiscoveryUpdate(userId, {
      isUpdating: false,
      phase: "completed",
      progress: 100,
      progressMessage: "Discovery refresh completed",
    });
    return { refreshed: true, recommendationCount: recommendations.length };
  } catch (error) {
    logger.error(
      'discovery',
      `[Discovery] Failed to build recommendations for user ${userId}: ${error.message}`,
    );
    markDiscoveryRefreshFinished(namespace, { error: error.message });
    emitUserDiscoveryUpdate(userId, {
      isUpdating: false,
      phase: "error",
      progress: 100,
      progressMessage: "Discovery refresh failed",
      error: error.message,
    });
    throw error;
  }
};

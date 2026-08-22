import { randomUUID } from "crypto";
import { dbOps, userOps } from "../../db/helpers/index.js";
import {
  lastfmRequest,
  listenbrainzRequest,
  getLastfmApiKey,
  musicbrainzGetCachedArtistMbidByName,
  musicbrainzResolveArtistMbidByName,
} from "../apiClients/index.js";
import { logger } from "../logger.js";
import {
  getListenHistoryCacheNamespace,
  getListenHistoryProfile,
  hasListenHistoryProfile,
} from "../listeningHistory.js";
import {
  getCanonicalArtistKeyProjection,
  iterateCanonicalArtistProjection,
} from "../libraryQueryService.js";
import {
  buildExistingArtistKeySet,
  buildDiscoverySeedList,
  mergeResolvedRecommendations,
  filterRecommendationsForServe,
  mergeRetainedRecommendationPool,
  rerankRecommendations as rerankRecs,
} from "./recommendationPipeline.js";
import {
  buildListenbrainzFallbackDiscovery,
  getDiscoveryCapabilities,
  DISCOVERY_PROVIDER_LASTFM,
} from "../listenbrainzDiscoveryFallback.js";
import {
  enqueueDiscoveryPlaylistBuildJob,
  enqueueDiscoveryUserRefreshJob,
} from "../honkerDb.js";
import { websocketService } from "../websocketService.js";

import {
  getLastfmDiscoveryPeriod,
  getListenbrainzRange,
  getDiscoveryRecommendationsPerRefresh,
  getDiscoveryMode,
  getDiscoveryRecommendationPoolLimit,
  getDiscoveryUserRefreshDelaySeconds,
  getDiscoveryNetworkConcurrency,
  getLastfmFailureRatio,
  getDiscoveryRecommendationSeedLimit,
  createDiscoveryRunId,
  selectDiscoverySeedSample,
  buildTrendingArtistEntry,
  normalizePlaylistBuildStringList,
  mapWithConcurrency,
  DISCOVERY_QUALITY_ENRICHED,
} from "./helpers.js";
import { getDiscoveryFeedback } from "./feedback.js";
import {
  discoveryCache,
  getDiscoveryCache,
  recordDiscoveryUpdateProgress,
  clearDiscoveryUpdateProgress,
  recordDiscoverPlaylistBuildProgress,
  clearDiscoverPlaylistBuildProgress,
  setDiscoveryPlaylistBuildToken,
  getDiscoveryPlaylistBuildKey,
  isGlobalDiscoveryRefreshInProgress,
} from "./persistence.js";
import { buildTasteProfile, collectSeedTagsAndGenres } from "./tasteProfile.js";
import { buildRecommendationsFromSeeds } from "./recommendations.js";
import { getTopPlayedArtists } from "../playEventService.js";

export { DISCOVERY_QUALITY_ENRICHED };

const pendingUserDiscoveryProfiles = new Map();

const collectListeningHistoryRefreshProfiles = () => {
  const profiles = new Map();
  for (const user of userOps.getAllListeningHistoryUsers()) {
    const profile = getListenHistoryProfile(user);
    const cacheNamespace = getListenHistoryCacheNamespace(profile);
    if (!cacheNamespace || !hasListenHistoryProfile(profile)) continue;
    profiles.set(cacheNamespace, {
      profile,
      feedbackUserId: user.id || null,
    });
  }
  for (const [cacheNamespace, entry] of pendingUserDiscoveryProfiles) {
    profiles.set(
      cacheNamespace,
      entry?.profile
        ? entry
        : {
            profile: entry,
            feedbackUserId: null,
          },
    );
  }
  pendingUserDiscoveryProfiles.clear();
  return [...profiles.values()];
};

const enqueueListeningHistoryUserRefreshes = ({
  reason = "global_refresh_completed",
  delaySeconds = getDiscoveryUserRefreshDelaySeconds(),
  staggerSeconds = 30,
  onProgress,
} = {}) => {
  const profiles = collectListeningHistoryRefreshProfiles();
  if (profiles.length === 0) return 0;

  profiles.forEach((entry, index) => {
    enqueueDiscoveryUserRefreshJob(
      {
        listenHistoryProfile: entry.profile,
        feedbackUserId: entry.feedbackUserId || null,
        localOnly: entry.localOnly === true,
        requestedAt: Date.now(),
        reason,
      },
      {
        delaySeconds: delaySeconds + index * Math.max(0, staggerSeconds),
        priority: -10,
      },
    );
    onProgress?.({ completed: index + 1, total: profiles.length });
  });
  return profiles.length;
};

export const requestUserDiscoveryRefresh = (
  listenHistoryProfile,
  { feedbackUserId = null, localOnly = false } = {},
) => {
  const profile = getListenHistoryProfile(listenHistoryProfile);
  const cacheNamespace = getListenHistoryCacheNamespace(profile);
  if (!cacheNamespace || !getLastfmApiKey()) {
    return Promise.resolve(null);
  }
  if (isGlobalDiscoveryRefreshInProgress()) {
    pendingUserDiscoveryProfiles.set(cacheNamespace, {
      profile,
      feedbackUserId,
      localOnly,
    });
    enqueueDiscoveryUserRefreshJob(
      {
        listenHistoryProfile: profile,
        feedbackUserId,
        localOnly,
        requestedAt: Date.now(),
        reason: "global_refresh_in_progress",
      },
      { delaySeconds: getDiscoveryUserRefreshDelaySeconds(), priority: -10 },
    );
    return Promise.resolve({
      enqueued: true,
      reason: "global_refresh_in_progress",
    });
  }
  const operationId = enqueueDiscoveryUserRefreshJob({
    listenHistoryProfile: profile,
    feedbackUserId,
    localOnly,
    requestedAt: Date.now(),
    reason: "manual",
  });
  return Promise.resolve({ enqueued: true, operationId });
};

const fetchListenHistoryArtists = async (
  listenHistoryProfile,
  discoveryPeriod,
  lastfmHealth,
) => {
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
    const artists = Array.isArray(data?.payload?.artists)
      ? data.payload.artists
      : [];
    return artists
      .map((artist) => {
        const mbid = Array.isArray(artist.artist_mbids)
          ? artist.artist_mbids.find(Boolean)
          : artist.artist_mbid || null;
        const resolvedMbid =
          mbid || musicbrainzGetCachedArtistMbidByName(artist.artist_name);
        return {
          mbid: resolvedMbid || null,
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
  if (userTopArtists && !userTopArtists.error) lastfmHealth.success++; else lastfmHealth.failure++;

  if (!userTopArtists?.topartists?.artist) {
    return [];
  }

  const artists = Array.isArray(userTopArtists.topartists.artist)
    ? userTopArtists.topartists.artist
    : [userTopArtists.topartists.artist];

  return artists
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

export const serveCachedRecommendations = ({
  recommendations = [],
  feedback = [],
} = {}) => filterRecommendationsForServe(recommendations, feedback);

const resolveRecommendationCandidates = async (
  recommendations,
  existingArtistKeys,
  maxResolve,
  options = {},
) => {
  const resolveLimit =
    options.resolveLimit != null
      ? Math.max(0, Number(options.resolveLimit) || 0)
      : Math.max(maxResolve, getDiscoveryRecommendationsPerRefresh() * 3);
  const requireResolved = options.requireResolved !== false;
  const shortlist = recommendations.slice(
    0,
    Math.min(recommendations.length, resolveLimit),
  );

  await mapWithConcurrency(
    shortlist,
    getDiscoveryNetworkConcurrency(),
    async (item) => {
      if (item?.id || !item?.name) return;
      const cached = musicbrainzGetCachedArtistMbidByName(item.name);
      const resolved =
        cached || (await musicbrainzResolveArtistMbidByName(item.name));
      if (!resolved) return;
      item.id = resolved;
      item.navigateTo = resolved;
    },
  );

  const merged = mergeResolvedRecommendations(
    recommendations,
    existingArtistKeys,
  )
    .filter((item) => !requireResolved || item?.id || item?.navigateTo)
    .sort((left, right) => {
      if (
        (right.scoreTotal || right.score || 0) !==
        (left.scoreTotal || left.score || 0)
      ) {
        return (
          (right.scoreTotal || right.score || 0) -
          (left.scoreTotal || left.score || 0)
        );
      }
      if ((right.seedCount || 0) !== (left.seedCount || 0)) {
        return (right.seedCount || 0) - (left.seedCount || 0);
      }
      return String(left.name || "").localeCompare(String(right.name || ""));
    });

  return merged.slice(
    0,
    Math.max(120, getDiscoveryRecommendationsPerRefresh() * 2),
  );
};

const buildDiscoveryUpdatePayload = (
  discoveryData,
  {
    phase = "completed",
    progress = 100,
    progressMessage = "Discovery refresh completed",
  } = {},
) => {
  if (phase === "playlists_completed") {
    clearDiscoverPlaylistBuildProgress();
  }
  return {
    recommendations: discoveryData.recommendations || [],
    globalTop: discoveryData.globalTop || [],
    basedOn: discoveryData.basedOn || [],
    topTags: discoveryData.topTags || [],
    topGenres: discoveryData.topGenres || [],
    fallbackGenres: discoveryData.fallbackGenres || [],
    discoverPlaylists: discoveryData.discoverPlaylists || [],
    provider: discoveryData.provider || DISCOVERY_PROVIDER_LASTFM,
    capabilities:
      discoveryData.capabilities ||
      getDiscoveryCapabilities(
        (discoveryData.provider || DISCOVERY_PROVIDER_LASTFM) ===
          DISCOVERY_PROVIDER_LASTFM,
      ),
    lastUpdated: discoveryData.lastUpdated,
    recommendationQuality:
      discoveryData.recommendationQuality ||
      discoveryData.metadata?.recommendationQuality ||
      null,
    isEnriching:
      discoveryData.isEnriching === true ||
      discoveryData.metadata?.isEnriching === true,
    discoveryRunId:
      discoveryData.discoveryRunId ||
      discoveryData.metadata?.discoveryRunId ||
      null,
    enrichmentStartedAt:
      discoveryData.enrichmentStartedAt ||
      discoveryData.metadata?.enrichmentStartedAt ||
      null,
    enrichmentCompletedAt:
      discoveryData.enrichmentCompletedAt ||
      discoveryData.metadata?.enrichmentCompletedAt ||
      null,
    enrichmentProgressMessage:
      discoveryData.enrichmentProgressMessage ||
      discoveryData.metadata?.enrichmentProgressMessage ||
      null,
    isUpdating: false,
    configured: true,
    phase,
    progress,
    progressMessage,
    discoveryMode: getDiscoveryMode(),
    ...(phase === "playlists_completed"
      ? { playlistsUpdating: false, playlistsUpdateMessage: null }
      : {}),
  };
};

const emitDiscoveryDataUpdate = (discoveryData, options = {}) => {
  websocketService.emitDiscoveryUpdate(
    buildDiscoveryUpdatePayload(discoveryData, options),
  );
};

const scheduleDiscoverPlaylistBuild = ({
  cacheNamespace = null,
  listenHistoryProfile = null,
  historyTopArtists = [],
  publishUpdate = true,
  progressExtra = {},
} = {}) => {
  if (!getLastfmApiKey()) return;

  const buildKey = getDiscoveryPlaylistBuildKey(cacheNamespace);
  const buildToken = randomUUID();
  setDiscoveryPlaylistBuildToken(buildKey, buildToken);

  const payload = {
    cacheNamespace,
    buildToken,
    publishUpdate,
    requestedAt: Date.now(),
    listenHistoryProfile,
    historyTopArtists: normalizePlaylistBuildStringList(historyTopArtists, 3),
  };

  enqueueDiscoveryPlaylistBuildJob(payload);
  if (publishUpdate) {
    recordDiscoverPlaylistBuildProgress("Updating recommended playlists...", progressExtra);
  }
};

export const updateDiscoveryCache = async (options = {}) => {
  const { withHonkerLock } = await import("../honkerDb.js");
  if (options.skipHonkerLock !== true) {
    return withHonkerLock(
      "discovery-global-refresh",
      () =>
        updateDiscoveryCache({
          ...options,
          skipHonkerLock: true,
        }),
      {
        ttlSeconds: 3600,
        waitTimeoutMs: 30 * 60 * 1000,
        retryDelayMs: 500,
      },
    );
  }
  discoveryCache.isUpdating = true;
  logger.info('discovery', "Starting background update of discovery recommendations...");
  recordDiscoveryUpdateProgress("starting", "Preparing discovery refresh", 5);
  import("../aurralHistoryService.js")
    .then(({ recordDiscoveryRefreshStarted }) =>
      recordDiscoveryRefreshStarted(),
    )
    .catch((err) => { logger.warn('discovery', err); });

  try {
    recordDiscoveryUpdateProgress("loading_sources", "Loading library artists", 12);
    const allLibraryArtists = [...iterateCanonicalArtistProjection({ pageSize: 100 })];
    const recentLibraryArtists = allLibraryArtists.slice(0, 40);
    const libraryArtists =
      recentLibraryArtists.length > 0
        ? recentLibraryArtists
        : allLibraryArtists.slice(0, 40);
    logger.info('discovery', `Found ${allLibraryArtists.length} artists in library.`);

    const hasLastfmKey = !!getLastfmApiKey();
    const lastfmHealth = { success: 0, failure: 0 };

    if (!hasLastfmKey) {
      logger.info(
        'discovery',
        "No Last.fm API key configured. Building ListenBrainz fallback discovery.",
      );
      recordDiscoveryUpdateProgress(
        "fetching_trending",
        "Fetching ListenBrainz trending artists",
        45,
        {
          provider: "listenbrainz-fallback",
          capabilities: getDiscoveryCapabilities(false),
        },
      );
      const fallbackData = await buildListenbrainzFallbackDiscovery({
        existingArtistKeys: buildExistingArtistKeySet(allLibraryArtists),
        onProgress: ({ phase, progress, progressMessage }) =>
          recordDiscoveryUpdateProgress(phase, progressMessage, progress, {
            provider: "listenbrainz-fallback",
            capabilities: getDiscoveryCapabilities(false),
          }),
      });
      discoveryCache.isUpdating = false;
      Object.assign(discoveryCache, fallbackData, {
        isUpdating: false,
      });
      dbOps.updateDiscoveryCache(fallbackData);
      websocketService.emitDiscoveryUpdate({
        ...fallbackData,
        isUpdating: false,
        configured: true,
        phase: "completed",
        progress: 100,
        progressMessage: "Discovery refresh completed",
      });
      const { recordDiscoveryUpdated } =
        await import("../aurralHistoryService.js");
      recordDiscoveryUpdated({
        recommendationCount: fallbackData.recommendations?.length || 0,
        genreCount: fallbackData.topGenres?.length || 0,
      });
      return;
    }

    recordDiscoveryUpdateProgress(
      "collecting_seeds",
      "Collecting recommendation seed artists",
      20,
    );

    const historyArtists = [];

    const profileSampleSeedCount = selectDiscoverySeedSample(
      buildDiscoverySeedList({
        libraryArtists: libraryArtists.map((a) => ({
          mbid: a.mbid,
          artistName: a.artistName,
          source: "library",
        })),
        historyArtists,
      }),
      getLastfmFailureRatio(lastfmHealth),
    ).length;
    const existingArtistKeys = buildExistingArtistKeySet(allLibraryArtists);

    const provisionalSeeds = buildDiscoverySeedList({
      libraryArtists: libraryArtists.map((a) => ({
        mbid: a.mbid,
        artistName: a.artistName,
        source: "library",
      })),
      historyArtists,
    });
    const profileSample = provisionalSeeds.slice(0, profileSampleSeedCount);

    logger.info(
      'discovery',
      `Sampling tags/genres from ${profileSample.length} artists (${libraryArtists.length} library, ${historyArtists.length} history)...`,
    );
    const { tagMap, tagWeights } =
      getLastfmApiKey()
        ? await collectSeedTagsAndGenres(
            profileSample,
            lastfmHealth,
            "building_genres",
          )
        : {
            tagMap: new Map(),
            tagWeights: new Map(),
          };
    const tasteProfile = buildTasteProfile({
      recentLibraryArtists,
      allLibraryArtists,
      historyArtists,
      tagMap,
      tagWeights,
    });
    const seeds = buildDiscoverySeedList({
      libraryArtists: tasteProfile.librarySeeds,
      historyArtists: tasteProfile.historySeeds,
    });
    discoveryCache.topTags = tasteProfile.topTags;
    discoveryCache.topGenres = tasteProfile.topGenres;

    logger.info(
      'discovery',
      `Identified Top Genres: ${discoveryCache.topGenres.join(", ")}`,
    );

    if (getLastfmApiKey()) {
      logger.info('discovery', "Fetching Global Trending (real-time style) from Last.fm...");
      recordDiscoveryUpdateProgress(
        "fetching_trending",
        "Fetching global trending artists",
        50,
      );
      try {
        const topData = await lastfmRequest("chart.getTopArtists", {
          limit: getLastfmFailureRatio(lastfmHealth) >= 0.3 ? 60 : 100,
        });
        if (topData && !topData.error) lastfmHealth.success++; else lastfmHealth.failure++;
        const trendingArtists = [];
        if (topData?.artists?.artist) {
          const topArtists = Array.isArray(topData.artists.artist)
            ? topData.artists.artist
            : [topData.artists.artist];
          for (const artist of topArtists) {
            const entry = buildTrendingArtistEntry(artist);
            if (entry) trendingArtists.push(entry);
          }
        }
        let globalTop = mergeResolvedRecommendations(
          trendingArtists,
          existingArtistKeys,
        ).slice(0, 32);

        const globalFailureRatio = getLastfmFailureRatio(lastfmHealth);
        const maxGlobalResolve =
          globalFailureRatio >= 0.5 ? 10 : globalFailureRatio >= 0.3 ? 18 : 30;
        await mapWithConcurrency(
          globalTop.slice(0, maxGlobalResolve),
          getDiscoveryNetworkConcurrency(),
          async (item) => {
            if (!item?.name || item?.id) return;
            const resolved =
              musicbrainzGetCachedArtistMbidByName(item.name) ||
              (await musicbrainzResolveArtistMbidByName(item.name));
            if (!resolved) return;
            item.id = resolved;
            item.navigateTo = resolved;
          },
        );

        discoveryCache.globalTop = mergeResolvedRecommendations(
          globalTop,
          existingArtistKeys,
        )
          .filter((item) => item?.id || item?.navigateTo)
          .slice(0, 32);
        logger.info(
          'discovery',
          `Found ${discoveryCache.globalTop.length} trending artists.`,
        );
      } catch (e) {
        logger.error('discovery', `Failed to fetch Global Top: ${e.message}`);
      }
    }

    const recSample = seeds.slice(
      0,
      getDiscoveryRecommendationSeedLimit(
        seeds.length,
        getLastfmFailureRatio(lastfmHealth),
      ),
    );
    const recommendationRunStartedAt = new Date().toISOString();
    const discoveryRunId = createDiscoveryRunId();

    logger.info(
      'discovery',
      `Generating recommendations based on ${recSample.length} seed artists...`,
    );
    recordDiscoveryUpdateProgress(
      "generating_recommendations",
      "Generating personalized recommendations",
      65,
    );

    let recommendationsArray = [];
    if (getLastfmApiKey()) {
      const rawRecommendations = await buildRecommendationsFromSeeds({
        seeds: recSample,
        existingArtistKeys,
        lastfmHealth,
        profileTagWeights: tasteProfile.profileTagWeights,
        seedTagMap: tagMap,
        discoveryMode: getDiscoveryMode(),
        includeCandidateTagHydration: true,
        includeSecondHop: true,
      });
      const recommendationFailureRatio = getLastfmFailureRatio(lastfmHealth);
      const maxResolve =
        recommendationFailureRatio >= 0.5
          ? 12
          : recommendationFailureRatio >= 0.3
            ? 24
            : 40;
      recommendationsArray = await resolveRecommendationCandidates(
        rawRecommendations,
        existingArtistKeys,
        maxResolve,
        {
          resolveLimit: Math.max(
            maxResolve,
            getDiscoveryRecommendationsPerRefresh(),
          ),
        },
      );
      const freshRecommendations = rerankCachedRecommendations({
        recommendations: recommendationsArray,
        discoveryMode: getDiscoveryMode(),
        limit: getDiscoveryRecommendationsPerRefresh(),
      });
      recommendationsArray = mergeRetainedRecommendationPool({
        freshRecommendations,
        existingRecommendations: discoveryCache.recommendations || [],
        existingArtistKeys,
        limit: getDiscoveryRecommendationPoolLimit(),
        runStartedAt: recommendationRunStartedAt,
        discoveryMode: getDiscoveryMode(),
        feedback: getDiscoveryFeedback("global"),
      });

    } else {
      logger.warn('discovery', "Last.fm API key required for similar artist discovery.");
    }

    logger.info(
      'discovery',
      `Generated ${recommendationsArray.length} total recommendations.`,
    );

    const discoveryData = {
      provider: DISCOVERY_PROVIDER_LASTFM,
      capabilities: getDiscoveryCapabilities(true),
      recommendations: recommendationsArray,
      basedOn: recSample.map((a) => ({
        name: a.artistName,
        id: a.mbid,
        source: a.source || "library",
        profileBucket: a.profileBucket || null,
      })),
      topTags: discoveryCache.topTags || [],
      topGenres: discoveryCache.topGenres || [],
      globalTop: discoveryCache.globalTop || [],
      fallbackGenres: [],
      fallbackGenrePools: {},
      lastUpdated: recommendationRunStartedAt,
      recommendationQuality: DISCOVERY_QUALITY_ENRICHED,
      isEnriching: false,
      discoveryRunId,
      enrichmentStartedAt: null,
      enrichmentCompletedAt: recommendationRunStartedAt,
      enrichmentProgressMessage: null,
    };

    Object.assign(discoveryCache, discoveryData, { isUpdating: false });
    dbOps.updateDiscoveryCache(discoveryData);
    recordDiscoveryUpdateProgress(
      "saving_results",
      "Saving discovery recommendations",
      96,
    );
    const { notifyDiscoveryUpdated } = await import("../notificationService.js");
    notifyDiscoveryUpdated().catch((err) =>
      logger.warn('discovery', "[Discovery] Notification failed:", err.message),
    );
    logger.info(
      'discovery',
      `Discovery data written to database: ${discoveryData.recommendations.length} recommendations, ${discoveryData.topGenres.length} genres, ${discoveryData.globalTop.length} trending artists`,
    );

    logger.info('discovery', "Discovery cache updated successfully.");
    logger.info(
      'discovery',
      `Summary: ${recommendationsArray.length} recommendations, ${discoveryCache.topGenres.length} genres, ${discoveryCache.globalTop.length} trending artists`,
    );
    discoveryCache.isUpdating = false;
    clearDiscoveryUpdateProgress();

    const listeningHistoryUsersConfigured = userOps
      .getAllListeningHistoryUsers()
      .some((user) => hasListenHistoryProfile(getListenHistoryProfile(user)));
    if (listeningHistoryUsersConfigured) {
      emitDiscoveryDataUpdate(discoveryData, {
        progressMessage: "Discovery refresh completed",
      });
      const queuedUserRefreshes = enqueueListeningHistoryUserRefreshes({
        reason: "global_refresh_completed",
      });
      if (queuedUserRefreshes > 0) {
        logger.info(
          'discovery',
          `[Discovery] Queued ${queuedUserRefreshes} per-user refresh${
            queuedUserRefreshes === 1 ? "" : "es"
          } after global refresh.`,
        );
      }
    } else {
      scheduleDiscoverPlaylistBuild({
        historyTopArtists: historyArtists
          .slice(0, 3)
          .map((artist) => artist.artistName)
          .filter(Boolean),
        progressExtra: {
          recommendations: discoveryData.recommendations || [],
          globalTop: discoveryData.globalTop || [],
          basedOn: discoveryData.basedOn || [],
          topTags: discoveryData.topTags || [],
          topGenres: discoveryData.topGenres || [],
          fallbackGenres: discoveryData.fallbackGenres || [],
          discoverPlaylists: discoveryCache.discoverPlaylists || [],
          provider: discoveryData.provider || DISCOVERY_PROVIDER_LASTFM,
          lastUpdated: discoveryData.lastUpdated,
        },
      });
      logger.info('discovery', "Global refresh complete. Starting playlist build.");
    }

    const { recordDiscoveryUpdated } =
      await import("../aurralHistoryService.js");
    recordDiscoveryUpdated({
      recommendationCount: discoveryData.recommendations?.length || 0,
      genreCount: discoveryData.topGenres?.length || 0,
    });

    try {
      const cleaned = dbOps.cleanOldImageCache(30);
      if (cleaned?.changes > 0) {
        logger.info(
          'discovery',
          `[Discovery] Cleaned ${cleaned.changes} old image cache entries`,
        );
      }
      dbOps.cleanOldMusicbrainzArtistMbidCache(90);
    } catch (e) {
      logger.warn('discovery', "[Discovery] Failed to clean old image cache:", e.message);
    }
  } catch (error) {
    logger.error('discovery', "Failed to update discovery cache:", error.message);
    logger.error('discovery', "Stack trace:", error.stack);
    websocketService.emitDiscoveryUpdate({
      isUpdating: false,
      configured: true,
      phase: "error",
      progress: 100,
      progressMessage: "Discovery refresh failed",
      error: error.message,
    });
    import("../aurralHistoryService.js")
      .then(({ recordDiscoveryRefreshFailed }) =>
        recordDiscoveryRefreshFailed(error.message),
      )
      .catch((err) => { logger.warn('discovery', err); });
  } finally {
    if (pendingUserDiscoveryProfiles.size > 0) {
      const queuedUserRefreshes = enqueueListeningHistoryUserRefreshes({
        reason: "global_refresh_finished",
      });
      if (queuedUserRefreshes > 0) {
        logger.info(
          'discovery',
          `[Discovery] Queued ${queuedUserRefreshes} deferred per-user refresh${
            queuedUserRefreshes === 1 ? "" : "es"
          }.`,
        );
      }
    }
    discoveryCache.isUpdating = false;
    clearDiscoveryUpdateProgress();
  }
};

export const updateUserDiscoveryCache = async (
  listenHistoryProfile,
  options = {},
) => {
  const { withHonkerLock } = await import("../honkerDb.js");
  const { duringGlobalRefresh = false, localOnly = false } = options;
  const profile = getListenHistoryProfile(listenHistoryProfile);
  const cacheNamespace = getListenHistoryCacheNamespace(profile);
  if (!cacheNamespace) return null;
  if (!getLastfmApiKey()) return null;
  if (options.skipHonkerLock !== true) {
    return withHonkerLock(
      `discovery-user-refresh:${cacheNamespace}`,
      () =>
        updateUserDiscoveryCache(profile, {
          ...options,
          skipHonkerLock: true,
        }),
      {
        ttlSeconds: 300,
        waitTimeoutMs: 30 * 60 * 1000,
        retryDelayMs: 500,
      },
    );
  }
  if (!duringGlobalRefresh && isGlobalDiscoveryRefreshInProgress()) {
    pendingUserDiscoveryProfiles.set(cacheNamespace, {
      profile,
      feedbackUserId: options.feedbackUserId || null,
      localOnly,
    });
    enqueueDiscoveryUserRefreshJob(
      {
        listenHistoryProfile: profile,
        feedbackUserId: options.feedbackUserId || null,
        localOnly,
        requestedAt: Date.now(),
        reason: "global_refresh_in_progress",
      },
      { delaySeconds: 300 },
    );
    return { skipped: true, reason: "global_refresh_in_progress" };
  }
  const shouldPublishRefreshState = !duringGlobalRefresh;
  logger.info(
    'discovery',
    `[Discovery] Starting per-user refresh for ${profile.listenHistoryProvider} user ${profile.listenHistoryUsername}...`,
  );

  if (shouldPublishRefreshState) {
    discoveryCache.isUpdating = true;
    recordDiscoveryUpdateProgress(
      "generating_recommendations",
      "Personalizing discovery recommendations",
      35,
    );
  }

  try {
    const existingArtistKeys = buildExistingArtistKeySet(getCanonicalArtistKeyProjection());

    const lastfmHealth = { success: 0, failure: 0 };
    const discoveryPeriod = getLastfmDiscoveryPeriod();
    const historyArtists = [];

    if (!localOnly && discoveryPeriod !== "none") {
      logger.info(
        'discovery',
        `[Discovery] Fetching ${profile.listenHistoryProvider} top artists for ${profile.listenHistoryUsername} (period: ${discoveryPeriod})...`,
      );
      try {
        const fetchedHistoryArtists = await fetchListenHistoryArtists(
          profile,
          discoveryPeriod,
          lastfmHealth,
        );
        historyArtists.push(
          ...fetchedHistoryArtists.map((artist) => ({
            ...artist,
            source: profile.listenHistoryProvider,
          })),
        );
        logger.info(
          'discovery',
          `[Discovery] Found ${historyArtists.length} ${profile.listenHistoryProvider} artists for ${profile.listenHistoryUsername}.`,
        );
      } catch (e) {
        logger.error(
          'discovery',
          `[Discovery] Failed to fetch ${profile.listenHistoryProvider} artists for ${profile.listenHistoryUsername}: ${e.message}`,
        );
      }
    }

    if (options.feedbackUserId) {
      historyArtists.push(
        ...getTopPlayedArtists(options.feedbackUserId, { limit: 50 }).map((artist) => ({
          ...artist,
          source: "local",
        })),
      );
    }

    const recommendationRunStartedAt = new Date().toISOString();
    const discoveryRunId = createDiscoveryRunId();
    const feedback = options.feedbackUserId
      ? getDiscoveryFeedback(options.feedbackUserId)
      : [];

    const globalCache = getDiscoveryCache();
    const globalPool = globalCache.recommendations || [];
    const globalTopTags = globalCache.topTags || [];
    const globalTopGenres = globalCache.topGenres || [];

    if (globalPool.length === 0 && historyArtists.length === 0) {
      logger.info(
        'discovery',
        `[Discovery] Per-user refresh skipped for ${profile.listenHistoryUsername}: global pool is empty.`,
      );
      if (shouldPublishRefreshState) {
        discoveryCache.isUpdating = false;
        websocketService.emitDiscoveryUpdate({
          isUpdating: false,
          phase: "completed",
          progress: 100,
          progressMessage: "Discovery refresh completed (global pool unavailable)",
        });
      }
      return null;
    }

    const personalSeeds = buildDiscoverySeedList({
      libraryArtists: [],
      historyArtists,
    });
    let freshRecommendations = [];
    if (personalSeeds.length > 0) {
      const rawRecommendations = await buildRecommendationsFromSeeds({
        seeds: personalSeeds,
        existingArtistKeys,
        lastfmHealth,
        profileTagWeights: new Map(),
        seedTagMap: new Map(),
        discoveryMode: getDiscoveryMode(),
        includeCandidateTagHydration: false,
        includeSecondHop: true,
      });
      freshRecommendations = await resolveRecommendationCandidates(
        rawRecommendations,
        existingArtistKeys,
        40,
        { resolveLimit: getDiscoveryRecommendationsPerRefresh() },
      );
    }
    const recommendationsArray = mergeRetainedRecommendationPool({
      freshRecommendations: freshRecommendations.length ? freshRecommendations : globalPool,
      existingRecommendations:
        dbOps.getDiscoveryCache(cacheNamespace).recommendations || [],
      existingArtistKeys,
      limit: getDiscoveryRecommendationPoolLimit(),
      runStartedAt: recommendationRunStartedAt,
      discoveryMode: getDiscoveryMode(),
      feedback,
    });

    const basedOnArtists = historyArtists
      .map((artist) => ({
        name: artist.artistName,
        id: artist.mbid,
        source: artist.source || profile.listenHistoryProvider,
        profileBucket: null,
      }));
    const userData = {
      recommendations: recommendationsArray,
      basedOn: basedOnArtists,
      topTags: globalTopTags,
      topGenres: globalTopGenres,
      recommendationQuality: DISCOVERY_QUALITY_ENRICHED,
      isEnriching: false,
      discoveryRunId,
      enrichmentStartedAt: null,
      enrichmentCompletedAt: recommendationRunStartedAt,
      enrichmentProgressMessage: null,
    };

    dbOps.updateDiscoveryCache(userData, cacheNamespace);
    scheduleDiscoverPlaylistBuild({
      cacheNamespace,
      listenHistoryProfile: profile,
      historyTopArtists: historyArtists
        .slice(0, 3)
        .map((artist) => artist.artistName)
        .filter(Boolean),
    });
    logger.info(
      'discovery',
      `[Discovery] ${profile.listenHistoryProvider}:${profile.listenHistoryUsername} refresh complete: ${recommendationsArray.length} recommendations from global pool.`,
    );
    if (shouldPublishRefreshState) {
      websocketService.emitDiscoveryUpdate({
        isUpdating: false,
        configured: true,
        phase: "completed",
        progress: 100,
        progressMessage: "Discovery refresh completed",
      });
    }
    return userData;
  } catch (error) {
    logger.error(
      'discovery',
      `[Discovery] Failed to update cache for ${profile.listenHistoryProvider}:${profile.listenHistoryUsername}: ${error.message}`,
    );
    if (shouldPublishRefreshState) {
      websocketService.emitDiscoveryUpdate({
        isUpdating: false,
        configured: true,
        phase: "error",
        progress: 100,
        progressMessage: "Discovery refresh failed",
        error: error.message,
      });
    }
    return null;
  } finally {
    if (shouldPublishRefreshState) {
      discoveryCache.isUpdating = false;
      clearDiscoveryUpdateProgress();
    }
  }
};

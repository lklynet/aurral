import { logger } from "../logger.js";
import {
  getDiscoveryCache,
  getDiscoveryUpdateStatus,
  getDiscoveryPlaylistBuildStatus,
  requestUserDiscoveryRefresh,
  getUserDiscoveryCacheStaleness,
  isGlobalDiscoveryRefreshInProgress,
  getDiscoveryMode,
  getDiscoveryFeedback,
  filterBlockedArtistsForUser,
  serveCachedRecommendations,
} from "./index.js";
import { getLastfmApiKey } from "../apiClients/index.js";
import { iterateCanonicalArtistProjection } from "../libraryQueryService.js";
import { dbOps, userOps } from "../../db/helpers/index.js";
import {
  DISCOVERY_PROVIDER_LASTFM,
  DISCOVERY_PROVIDER_LISTENBRAINZ_FALLBACK,
  buildListenbrainzFallbackDiscovery,
  getDiscoveryCapabilities,
} from "../listenbrainzDiscoveryFallback.js";
import {
  getListenHistoryCacheNamespace,
  getListenHistoryProfile,
  hasListenHistoryProfile,
} from "../listeningHistory.js";
import { enqueueDiscoveryRefresh } from "./refreshScheduler.js";
import {
  buildArtistKeySet,
  isLibraryArtist,
  getDiscoveryRevalidateAt,
  setDiscoveryRevalidateAt,
  DISCOVERY_REVALIDATE_COOLDOWN_MS,
  getDiscoveryStaleMs,
} from "../../routes/discovery/handlers/utils.js";
import { getTopPlayedArtists } from "../playEventService.js";

export async function getUserDiscovery(userId, limit = 50, offset = 0) {
  const hasLastfmKey = !!getLastfmApiKey();
  const libraryArtists = [...iterateCanonicalArtistProjection({ pageSize: 100 })];

  const reqUser = userOps.getUserById(userId);
  const externalListenHistoryProfile = getListenHistoryProfile(reqUser || {});
  const localHistoryArtists = getTopPlayedArtists(userId, { limit: 50 });
  const localOnlyProfile = externalListenHistoryProfile.listenHistoryProvider === "local";
  const hasExternalListenHistory =
    !localOnlyProfile && hasListenHistoryProfile(externalListenHistoryProfile);
  const hasLocalListenHistory = localOnlyProfile || localHistoryArtists.length > 0;
  const listenHistoryProfile = hasExternalListenHistory
    ? externalListenHistoryProfile
    : hasLocalListenHistory
      ? { listenHistoryProvider: "lastfm", listenHistoryUsername: `__aurral_local_${userId}` }
      : externalListenHistoryProfile;
  const localOnly = !hasExternalListenHistory && hasLocalListenHistory;
  const userCacheNamespace =
    getListenHistoryCacheNamespace(listenHistoryProfile);
  const effectiveCacheNamespace = hasLastfmKey ? userCacheNamespace : null;

  if (
    hasListenHistoryProfile(listenHistoryProfile) &&
    hasLastfmKey &&
    !isGlobalDiscoveryRefreshInProgress()
  ) {
    const staleness = getUserDiscoveryCacheStaleness(userCacheNamespace);
    const staleMs = await getDiscoveryStaleMs();
    if (staleness > staleMs) {
      requestUserDiscoveryRefresh(listenHistoryProfile, {
        feedbackUserId: userId || null,
        localOnly,
      }).catch((err) => {
        logger.error("discovery", `On-demand refresh for ${listenHistoryProfile.listenHistoryProvider}:${listenHistoryProfile.listenHistoryUsername} failed`, { error: err.message });
      });
    }
  }

  let discoveryCache = getDiscoveryCache(effectiveCacheNamespace);

  const hasData =
    discoveryCache.recommendations?.length > 0 ||
    discoveryCache.globalTop?.length > 0 ||
    discoveryCache.topGenres?.length > 0 ||
    discoveryCache.fallbackGenres?.length > 0;
  const hasCompletedRefresh =
    !!discoveryCache.lastUpdated &&
    (discoveryCache.recommendations?.length > 0 ||
      discoveryCache.globalTop?.length > 0 ||
      discoveryCache.topGenres?.length > 0 ||
      discoveryCache.fallbackGenres?.length > 0);

  let isUpdating = discoveryCache.isUpdating || false;

  if (
    !hasLastfmKey &&
    (!hasData ||
      discoveryCache.provider !== DISCOVERY_PROVIDER_LISTENBRAINZ_FALLBACK)
  ) {
    const fallbackData = await buildListenbrainzFallbackDiscovery({
      existingArtistKeys: buildArtistKeySet(libraryArtists),
    });
    dbOps.updateDiscoveryCache(fallbackData);
    Object.assign(getDiscoveryCache(), fallbackData, { isUpdating: false });
    discoveryCache = getDiscoveryCache(effectiveCacheNamespace);
    isUpdating = false;
  } else if (!hasData && !hasCompletedRefresh && !isUpdating) {
    setDiscoveryRevalidateAt(Date.now());
    const lazyRefresh = enqueueDiscoveryRefresh({ reason: "lazy" });
    if (lazyRefresh.enqueued) {
      isUpdating = true;
    }
  }

  let {
    recommendations,
    globalTop,
    basedOn,
    topTags,
    topGenres,
    fallbackGenres = [],
    discoverPlaylists = [],
    lastUpdated,
    recommendationQuality,
    isEnriching,
    discoveryRunId,
    enrichmentStartedAt,
    enrichmentCompletedAt,
    enrichmentProgressMessage,
    provider,
    capabilities,
  } = discoveryCache;
  provider = hasLastfmKey
    ? DISCOVERY_PROVIDER_LASTFM
    : provider || DISCOVERY_PROVIDER_LISTENBRAINZ_FALLBACK;
  capabilities = capabilities || getDiscoveryCapabilities(hasLastfmKey);
  const feedback = getDiscoveryFeedback(userId || "global");
  const discoveryMode = getDiscoveryMode();

  const existingArtistKeys = buildArtistKeySet(libraryArtists);

  recommendations = recommendations.filter(
    (artist) => !isLibraryArtist(artist, existingArtistKeys),
  );
  globalTop = globalTop.filter(
    (artist) => !isLibraryArtist(artist, existingArtistKeys),
  );

  recommendations = serveCachedRecommendations({
    recommendations,
    feedback,
  });
  globalTop = serveCachedRecommendations({
    recommendations: globalTop,
    feedback,
  });
  const localBasedOn = localHistoryArtists.map((artist) => ({
    name: artist.artistName,
    id: artist.mbid,
    source: "local",
    profileBucket: null,
  }));
  const seenBasedOn = new Set((basedOn || []).map((artist) => `${artist.id || ""}:${artist.name || ""}`));
  basedOn = [...(basedOn || []), ...localBasedOn.filter((artist) => {
    const key = `${artist.id || ""}:${artist.name || ""}`;
    if (seenBasedOn.has(key)) return false;
    seenBasedOn.add(key);
    return true;
  })];
  fallbackGenres = (Array.isArray(fallbackGenres) ? fallbackGenres : []).map((section) => ({
    ...section,
    artists: filterBlockedArtistsForUser(userId || "global", section?.artists || []),
  }));

  const parsedLastUpdated = lastUpdated ? new Date(lastUpdated).getTime() : 0;
  const staleMs = await getDiscoveryStaleMs();
  const isStale =
    Number.isFinite(parsedLastUpdated) &&
    parsedLastUpdated > 0 &&
    Date.now() - parsedLastUpdated > staleMs;

  if (
    isStale &&
    !isUpdating &&
    !hasListenHistoryProfile(listenHistoryProfile) &&
    Date.now() - getDiscoveryRevalidateAt() > DISCOVERY_REVALIDATE_COOLDOWN_MS
  ) {
    setDiscoveryRevalidateAt(Date.now());
    const staleRefresh = enqueueDiscoveryRefresh({ reason: "stale" });
    if (staleRefresh.enqueued) {
      isUpdating = true;
    }
  }

  const cacheStrategy =
    recommendations.length > 0 || globalTop.length > 0
      ? "fresh"
      : isUpdating
        ? "updating"
        : "empty";

  const { annotateDiscoverPlaylistsForUser } =
    await import("./playlistBuilder.js");
  const playlists = annotateDiscoverPlaylistsForUser(discoverPlaylists, userId)
    .map((playlist) => {
      const tracks = filterBlockedArtistsForUser(userId || "global", playlist.tracks || []);
      return {
        ...playlist,
        tracks,
        trackCount: tracks.length,
      };
    })
    .filter((playlist) => playlist.trackCount > 0);

  const playlistBuildStatus =
    getDiscoveryPlaylistBuildStatus(effectiveCacheNamespace);

  const limitClamped = Math.max(limit, 1);
  const offsetClamped = Math.max(offset, 0);

  return {
    cacheStrategy,
    body: {
      recommendations: limit
        ? recommendations.slice(offsetClamped, offsetClamped + limitClamped)
        : recommendations,
      recommendationCount: recommendations.length,
      globalTop,
      basedOn,
      topTags,
      topGenres,
      fallbackGenres,
      discoverPlaylists: playlists,
      lastUpdated,
      isUpdating,
      recommendationQuality,
      isEnriching,
      discoveryRunId,
      enrichmentStartedAt,
      enrichmentCompletedAt,
      enrichmentProgressMessage,
      ...(isUpdating ? getDiscoveryUpdateStatus() : {}),
      playlistsUpdating: playlistBuildStatus.playlistsUpdating,
      ...(playlistBuildStatus.playlistsUpdating
        ? {
            playlistsUpdateMessage: playlistBuildStatus.playlistsUpdateMessage,
          }
        : {}),
      stale: isStale,
      configured: true,
      provider,
      capabilities,
      discoveryMode,
    },
  };
}

import { dbOps, userOps } from "../config/db-helpers.js";
import { GENRE_KEYWORDS } from "../config/constants.js";
import {
  BASE_DISCOVER_FLOW_COUNT,
  DISCOVERY_FLOWS_DEFAULT,
  DISCOVERY_FLOWS_MAX,
} from "../config/discoverPlaylistPresets.js";
import {
  lastfmRequest,
  listenbrainzRequest,
  getLastfmApiKey,
  musicbrainzGetCachedArtistMbidByName,
  musicbrainzResolveArtistMbidByName,
} from "./apiClients.js";
import { hydrateArtistImages } from "./artistImageHydration.js";
import { websocketService } from "./websocketService.js";
import { libraryManager } from "./libraryManager.js";
import {
  getDefaultListenHistoryProfile,
  getListenHistoryCacheNamespace,
  getListenHistoryProfile,
  hasListenHistoryProfile,
} from "./listeningHistory.js";
import {
  DISCOVERY_PROVIDER_LASTFM,
  buildListenbrainzFallbackDiscovery,
  getDiscoveryCapabilities,
} from "./listenbrainzDiscoveryFallback.js";
import {
  addRecommendationCandidate,
  buildDiscoverySeedList,
  buildExistingArtistKeySet,
  finalizeRecommendationAccumulator,
  mergeResolvedRecommendations,
  rerankRecommendations,
} from "./discoveryRecommendations.js";
import {
  enqueueDiscoveryPlaylistBuildJob,
  enqueueDiscoveryUserRefreshJob,
  isDiscoveryRefreshQueueLocked,
  isHonkerLockHeld,
  withHonkerLock,
} from "./honkerDb.js";

const LASTFM_PERIODS = [
  "none",
  "7day",
  "1month",
  "3month",
  "6month",
  "12month",
  "overall",
];
const LISTENBRAINZ_RANGE_BY_PERIOD = {
  "7day": "week",
  "1month": "month",
  "3month": "quarter",
  "6month": "half_yearly",
  "12month": "year",
  overall: "all_time",
};
const getLastfmDiscoveryPeriod = () => {
  const settings = dbOps.getSettings();
  const p = settings.integrations?.lastfm?.discoveryPeriod;
  return p && LASTFM_PERIODS.includes(p) ? p : "1month";
};

const getListenbrainzRange = (discoveryPeriod) => {
  if (discoveryPeriod === "none") return null;
  return LISTENBRAINZ_RANGE_BY_PERIOD[discoveryPeriod] || "month";
};

const clampInt = (value, fallback, min, max) => {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
};
const normalizeTextList = (value) => {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const entry of value) {
    const normalized = String(entry || "")
      .trim()
      .toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
};

export const getDiscoveryAutoRefreshHours = () => {
  const settings = dbOps.getSettings();
  const parsed = parseInt(
    settings.integrations?.lastfm?.discoveryAutoRefreshHours,
    10,
  );
  return [24, 168, 720].includes(parsed) ? parsed : 168;
};

const DISCOVERY_RECOMMENDATIONS_MIN = 50;
const DISCOVERY_RECOMMENDATIONS_MAX = 500;
const DISCOVERY_RECOMMENDATIONS_DEFAULT = 200;

export const getDiscoveryRecommendationsPerRefresh = () => {
  const settings = dbOps.getSettings();
  const parsed = parseInt(
    settings.integrations?.lastfm?.discoveryRecommendationsPerRefresh,
    10,
  );
  if (!Number.isFinite(parsed)) return DISCOVERY_RECOMMENDATIONS_DEFAULT;
  return Math.min(
    DISCOVERY_RECOMMENDATIONS_MAX,
    Math.max(DISCOVERY_RECOMMENDATIONS_MIN, parsed),
  );
};

export const getDiscoveryFlowsPerRefresh = () => {
  const settings = dbOps.getSettings();
  const parsed = parseInt(
    settings.integrations?.lastfm?.discoveryFlowsPerRefresh,
    10,
  );
  if (!Number.isFinite(parsed)) return DISCOVERY_FLOWS_DEFAULT;
  return Math.min(
    DISCOVERY_FLOWS_MAX,
    Math.max(BASE_DISCOVER_FLOW_COUNT, parsed),
  );
};

export const getMaxFocusPlaylists = () =>
  Math.max(0, getDiscoveryFlowsPerRefresh() - BASE_DISCOVER_FLOW_COUNT);

export const getDiscoveryMode = () => {
  const settings = dbOps.getSettings();
  const value = String(
    settings.integrations?.lastfm?.discoveryMode || "balanced",
  )
    .trim()
    .toLowerCase();
  return value === "safer" || value === "deeper" ? value : "balanced";
};

export const getLocalDiscoveryPreferences = () => {
  const settings = dbOps.getSettings();
  return {
    includeRecommendations:
      settings.integrations?.ticketmaster
        ?.localDiscoveryIncludeRecommendations !== false,
    includeTrending:
      settings.integrations?.ticketmaster?.localDiscoveryIncludeTrending !==
      false,
  };
};

const getDiscoveryFeedbackKey = (userId = "global") =>
  `discoveryFeedback:${String(userId || "global").trim()}`;

const normalizeFeedbackAction = (value) => {
  const action = String(value || "")
    .trim()
    .toLowerCase();
  return ["more_like_this", "less_like_this"].includes(action) ? action : null;
};

const normalizeFeedbackList = (value) =>
  (Array.isArray(value) ? value : [])
    .filter((entry) => entry && typeof entry === "object")
    .map((entry) => ({
      id: String(entry.id || "").trim() || null,
      artistId: String(entry.artistId || "").trim() || null,
      artistName: String(entry.artistName || "").trim() || null,
      action: normalizeFeedbackAction(entry.action),
      sourceContext: String(entry.sourceContext || "").trim() || null,
      tagContext: normalizeTextList(entry.tagContext).slice(0, 8),
      seedContext: normalizeTextList(entry.seedContext).slice(0, 8),
      createdAt: entry.createdAt || null,
      expiresAt: entry.expiresAt || null,
    }))
    .filter((entry) => entry.action && (entry.artistId || entry.artistName))
    .filter((entry) => {
      if (!entry.expiresAt) return true;
      const time = new Date(entry.expiresAt).getTime();
      return Number.isFinite(time) ? time > Date.now() : true;
    });

export const getDiscoveryFeedback = (userId = "global") =>
  normalizeFeedbackList(dbOps.getJSONSetting(getDiscoveryFeedbackKey(userId)));

export const addDiscoveryFeedback = (userId = "global", entry = {}) => {
  const action = normalizeFeedbackAction(entry.action);
  if (!action) throw new Error("Invalid discovery feedback action");
  const artistId = String(entry.artistId || "").trim() || null;
  const artistName = String(entry.artistName || "").trim() || null;
  if (!artistId && !artistName) {
    throw new Error("artistId or artistName is required");
  }

  const existing = getDiscoveryFeedback(userId);
  const now = new Date();
  const normalizedEntry = {
    id:
      String(entry.id || "").trim() ||
      `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    artistId,
    artistName,
    action,
    sourceContext: String(entry.sourceContext || "").trim() || null,
    tagContext: normalizeTextList(entry.tagContext).slice(0, 8),
    seedContext: normalizeTextList(entry.seedContext).slice(0, 8),
    createdAt: now.toISOString(),
    expiresAt: null,
  };
  const deduped = existing.filter((item) => {
    const sameArtist =
      (artistId && item.artistId && artistId === item.artistId) ||
      (artistName &&
        item.artistName &&
        artistName.toLowerCase() === item.artistName.toLowerCase());
    return !(sameArtist && item.action === action);
  });
  deduped.unshift(normalizedEntry);
  dbOps.setJSONSetting(getDiscoveryFeedbackKey(userId), deduped.slice(0, 200));
  return normalizedEntry;
};

export const removeDiscoveryFeedback = (userId = "global", feedbackId) => {
  const target = String(feedbackId || "").trim();
  const next = getDiscoveryFeedback(userId).filter(
    (entry) => entry.id !== target,
  );
  dbOps.setJSONSetting(getDiscoveryFeedbackKey(userId), next);
  return next;
};

export const resetDiscoveryFeedback = (userId = "global") => {
  dbOps.setJSONSetting(getDiscoveryFeedbackKey(userId), []);
  return [];
};

const buildWeightedTopList = (map, limit) =>
  Array.from(map.entries())
    .sort((left, right) => {
      if (right[1] !== left[1]) return right[1] - left[1];
      return String(left[0] || "").localeCompare(String(right[0] || ""));
    })
    .slice(0, limit)
    .map(([name]) => name);

const buildTasteProfile = ({
  recentLibraryArtists = [],
  allLibraryArtists = [],
  historyArtists = [],
  tagMap = new Map(),
  tagWeights = new Map(),
  genreWeights = new Map(),
} = {}) => {
  const recentIds = new Set(
    recentLibraryArtists
      .map((artist) =>
        String(artist?.mbid || "")
          .trim()
          .toLowerCase(),
      )
      .filter(Boolean),
  );
  const bucketedLibrarySeeds = [];

  recentLibraryArtists.slice(0, 18).forEach((artist, index) => {
    if (!artist?.mbid || !artist?.artistName) return;
    bucketedLibrarySeeds.push({
      mbid: artist.mbid,
      artistName: artist.artistName,
      source: "library",
      profileBucket: index < 8 ? "recent_interest" : "core_favorites",
      affinityWeight: 1.65 - Math.min(index, 12) * 0.04,
    });
  });

  allLibraryArtists.slice(0, 20).forEach((artist, index) => {
    if (!artist?.mbid || !artist?.artistName) return;
    if (recentIds.has(String(artist.mbid).trim().toLowerCase())) return;
    bucketedLibrarySeeds.push({
      mbid: artist.mbid,
      artistName: artist.artistName,
      source: "library",
      profileBucket: index < 10 ? "collection_anchor" : "exploratory_seed",
      affinityWeight: index < 10 ? 1.1 : 0.95,
    });
  });

  const bucketedHistorySeeds = historyArtists.map((artist, index) => ({
    ...artist,
    source: artist.source || "lastfm",
    profileBucket:
      index < 12
        ? "core_favorites"
        : index < 24
          ? "recent_interest"
          : "exploratory_seed",
    affinityWeight:
      1.35 +
      Math.min(
        1.2,
        Math.log10(Math.max(0, Number(artist.playcount || 0)) + 1) * 0.35,
      ),
  }));

  const profileTagWeights = new Map();
  for (const [tag, weight] of tagWeights.entries()) {
    const normalized = String(tag || "")
      .trim()
      .toLowerCase();
    if (!normalized) continue;
    profileTagWeights.set(normalized, Number(weight || 0));
  }

  return {
    tagMap,
    profileTagWeights,
    topTags: buildWeightedTopList(tagWeights, 20),
    topGenres: buildWeightedTopList(genreWeights, 24),
    historySeeds: bucketedHistorySeeds,
    librarySeeds: bucketedLibrarySeeds,
  };
};

export const rerankCachedRecommendations = ({
  recommendations = [],
  feedback = [],
  discoveryMode = getDiscoveryMode(),
  limit = getDiscoveryRecommendationsPerRefresh(),
} = {}) =>
  rerankRecommendations(recommendations, limit, {
    feedback,
    discoveryMode,
  });

const createLastfmHealth = () => ({
  success: 0,
  failure: 0,
});

const getLastfmFailureRatio = (health) => {
  const total = health.success + health.failure;
  if (total === 0) return 0;
  return health.failure / total;
};

const recordLastfmResult = (health, payload) => {
  if (payload && !payload.error) {
    health.success += 1;
  } else {
    health.failure += 1;
  }
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

const recordDiscoverPlaylistBuildProgress = (
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

export const getDiscoveryPlaylistBuildStatus = (cacheNamespace = null) => {
  const buildKey = getDiscoveryPlaylistBuildKey(cacheNamespace);
  const lockHeld = isHonkerLockHeld(`discovery-playlist-build:${buildKey}`);
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

const emitDiscoveryProgress = (
  phase,
  progressMessage,
  progress,
  extra = {},
) => {
  recordDiscoveryUpdateProgress(phase, progressMessage, progress, extra);
};

const EMPTY_CACHE = {
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
    isUpdating: false,
  };
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

  const dbData = dbOps.getDiscoveryCache();
  if (
    (dbData.lastUpdated && !discoveryCache.lastUpdated) ||
    (dbData.recommendations?.length > 0 &&
      (!discoveryCache.recommendations ||
        discoveryCache.recommendations.length === 0)) ||
    (dbData.globalTop?.length > 0 &&
      (!discoveryCache.globalTop || discoveryCache.globalTop.length === 0)) ||
    (dbData.topGenres?.length > 0 &&
      (!discoveryCache.topGenres || discoveryCache.topGenres.length === 0)) ||
    (dbData.fallbackGenres?.length > 0 &&
      (!discoveryCache.fallbackGenres ||
        discoveryCache.fallbackGenres.length === 0)) ||
    (Object.keys(dbData.fallbackGenrePools || {}).length > 0 &&
      Object.keys(discoveryCache.fallbackGenrePools || {}).length === 0)
  ) {
    Object.assign(discoveryCache, {
      recommendations:
        dbData.recommendations || discoveryCache.recommendations || [],
      globalTop: dbData.globalTop || discoveryCache.globalTop || [],
      basedOn: dbData.basedOn || discoveryCache.basedOn || [],
      topTags: dbData.topTags || discoveryCache.topTags || [],
      topGenres: dbData.topGenres || discoveryCache.topGenres || [],
      fallbackGenres:
        dbData.fallbackGenres || discoveryCache.fallbackGenres || [],
      fallbackGenrePools:
        dbData.fallbackGenrePools || discoveryCache.fallbackGenrePools || {},
      discoverPlaylists:
        dbData.discoverPlaylists || discoveryCache.discoverPlaylists || [],
      provider:
        dbData.provider || discoveryCache.provider || DISCOVERY_PROVIDER_LASTFM,
      capabilities: getDiscoveryCapabilities(
        (dbData.provider ||
          discoveryCache.provider ||
          DISCOVERY_PROVIDER_LASTFM) === DISCOVERY_PROVIDER_LASTFM,
      ),
      lastUpdated: dbData.lastUpdated || discoveryCache.lastUpdated || null,
    });
  }
  return discoveryCache;
};

export const isGlobalDiscoveryRefreshInProgress = () =>
  isHonkerLockHeld("discovery-global-refresh") ||
  isDiscoveryRefreshQueueLocked();

const hasListeningHistoryUsers = () =>
  userOps
    .getAllListeningHistoryUsers()
    .some((user) => hasListenHistoryProfile(user));

const pendingUserDiscoveryProfiles = new Map();

const collectListeningHistoryRefreshProfiles = () => {
  const profiles = new Map();
  for (const user of userOps.getAllListeningHistoryUsers()) {
    const profile = getListenHistoryProfile(user);
    const cacheNamespace = getListenHistoryCacheNamespace(profile);
    if (!cacheNamespace || !hasListenHistoryProfile(profile)) continue;
    profiles.set(cacheNamespace, profile);
  }
  for (const [cacheNamespace, profile] of pendingUserDiscoveryProfiles) {
    profiles.set(cacheNamespace, profile);
  }
  pendingUserDiscoveryProfiles.clear();
  return [...profiles.values()];
};

const refreshListeningHistoryUserCaches = async ({ onProgress } = {}) => {
  const profiles = collectListeningHistoryRefreshProfiles();
  if (profiles.length === 0) return;

  let completed = 0;
  for (const profile of profiles) {
    try {
      await updateUserDiscoveryCache(profile, { duringGlobalRefresh: true });
    } catch (error) {
      console.error(
        `[Discovery] Per-user refresh failed for ${profile.listenHistoryProvider}:${profile.listenHistoryUsername}: ${error.message}`,
      );
    }
    completed += 1;
    onProgress?.({ completed, total: profiles.length });
  }
};

const flushPendingUserDiscoveryRefreshes = async () => {
  if (pendingUserDiscoveryProfiles.size === 0) return;
  const profiles = [...pendingUserDiscoveryProfiles.values()];
  pendingUserDiscoveryProfiles.clear();
  for (const profile of profiles) {
    try {
      await updateUserDiscoveryCache(profile, { duringGlobalRefresh: true });
    } catch (error) {
      console.error(
        `[Discovery] Deferred per-user refresh failed for ${profile.listenHistoryProvider}:${profile.listenHistoryUsername}: ${error.message}`,
      );
    }
  }
};

export const requestUserDiscoveryRefresh = (listenHistoryProfile) => {
  const profile = getListenHistoryProfile(listenHistoryProfile);
  const cacheNamespace = getListenHistoryCacheNamespace(profile);
  if (!cacheNamespace || !getLastfmApiKey()) {
    return Promise.resolve(null);
  }
  if (isGlobalDiscoveryRefreshInProgress()) {
    pendingUserDiscoveryProfiles.set(cacheNamespace, profile);
    enqueueDiscoveryUserRefreshJob(
      {
        listenHistoryProfile: profile,
        requestedAt: Date.now(),
        reason: "global_refresh_in_progress",
      },
      { delaySeconds: 300 },
    );
    return Promise.resolve({
      enqueued: true,
      reason: "global_refresh_in_progress",
    });
  }
  const operationId = enqueueDiscoveryUserRefreshJob({
    listenHistoryProfile: profile,
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
        if (!resolvedMbid) return null;
        return {
          mbid: resolvedMbid,
          artistName: artist.artist_name,
          playcount: parseInt(artist.listen_count || 0, 10) || 0,
        };
      })
      .filter(Boolean);
  }

  if (profile.listenHistoryProvider === "koito") {
    const { fetchKoitoTopArtists } = await import("./koitoClient.js");
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
  recordLastfmResult(lastfmHealth, userTopArtists);

  if (!userTopArtists?.topartists?.artist) {
    return [];
  }

  const artists = Array.isArray(userTopArtists.topartists.artist)
    ? userTopArtists.topartists.artist
    : [userTopArtists.topartists.artist];

  return artists
    .map((artist) => {
      if (!artist.mbid) return null;
      return {
        mbid: artist.mbid,
        artistName: artist.name,
        playcount: parseInt(artist.playcount || 0, 10) || 0,
      };
    })
    .filter(Boolean);
};

const getSeedSampleSize = (count, failureRatio) => {
  const sampleBase = Math.min(25, count);
  if (failureRatio >= 0.5) return Math.min(8, sampleBase);
  if (failureRatio >= 0.3) return Math.min(14, sampleBase);
  return sampleBase;
};

const selectDiscoverySeedSample = (seeds, failureRatio) => {
  const sampleSize = getSeedSampleSize(seeds.length, failureRatio);
  return [...seeds].slice(0, sampleSize);
};

const pickLastfmImage = (images) => {
  if (!Array.isArray(images)) return null;
  const image =
    images.find((entry) => entry.size === "extralarge") ||
    images.find((entry) => entry.size === "large") ||
    images.slice(-1)[0];
  if (
    image &&
    image["#text"] &&
    !image["#text"].includes("2a96cbd8b46e442fc41c2b86b821562f")
  ) {
    return image["#text"];
  }
  return null;
};

const formatTrendingPopularity = (artist) => {
  const listeners = parseInt(artist?.listeners || 0, 10) || 0;
  if (listeners > 0) {
    return `${new Intl.NumberFormat("en-US", {
      notation: listeners >= 100000 ? "compact" : "standard",
      maximumFractionDigits: listeners >= 100000 ? 1 : 0,
    }).format(listeners)} listeners on Last.fm`;
  }
  const playcount = parseInt(artist?.playcount || 0, 10) || 0;
  if (playcount > 0) {
    return `${new Intl.NumberFormat("en-US", {
      notation: playcount >= 100000 ? "compact" : "standard",
      maximumFractionDigits: playcount >= 100000 ? 1 : 0,
    }).format(playcount)} plays on Last.fm`;
  }
  const rank = parseInt(artist?.["@attr"]?.rank || artist?.rank || 0, 10) || 0;
  if (rank > 0) {
    return `Trending #${rank} on Last.fm`;
  }
  return "Trending on Last.fm";
};

const buildTrendingArtistEntry = (artist) => {
  const name = String(artist?.name || artist?.["#text"] || "").trim();
  if (!name) return null;
  return {
    id: String(artist?.mbid || "").trim() || null,
    name,
    image: pickLastfmImage(artist?.image),
    type: "Artist",
    popularityLabel: formatTrendingPopularity(artist),
    listeners: parseInt(artist?.listeners || 0, 10) || 0,
    playcount: parseInt(artist?.playcount || 0, 10) || 0,
    popularityRank:
      parseInt(artist?.["@attr"]?.rank || artist?.rank || 0, 10) || null,
  };
};

const collectSeedTagsAndGenres = async (
  seeds,
  lastfmHealth,
  progressPhase = null,
) => {
  const tagCounts = new Map();
  const genreCounts = new Map();
  const tagMap = new Map();

  if (progressPhase) {
    emitDiscoveryProgress(progressPhase, "Building genre and tag profile", 35);
  }

  let tagsFound = 0;
  await Promise.all(
    seeds.map(async (seed) => {
      try {
        const data = await lastfmRequest("artist.getTopTags", {
          mbid: seed.mbid,
        });
        recordLastfmResult(lastfmHealth, data);
        if (!data?.toptags?.tag) return;

        const tags = Array.isArray(data.toptags.tag)
          ? data.toptags.tag
          : [data.toptags.tag];
        const names = tags
          .slice(0, 15)
          .map((tag) => String(tag?.name || "").trim())
          .filter(Boolean);
        if (names.length === 0) return;

        const tagMapKey = String(seed?.mbid || "")
          .trim()
          .toLowerCase();
        if (tagMapKey) {
          tagMap.set(tagMapKey, names);
        }
        tagsFound += 1;

        for (const tag of tags.slice(0, 15)) {
          const name = String(tag?.name || "").trim();
          if (!name) continue;
          const tagWeight = parseInt(tag?.count || 0, 10) || 1;
          tagCounts.set(
            name,
            (tagCounts.get(name) || 0) +
              tagWeight * Math.max(0.5, seed.weight || 1),
          );
          const normalized = name.toLowerCase();
          if (GENRE_KEYWORDS.some((keyword) => normalized.includes(keyword))) {
            genreCounts.set(
              name,
              (genreCounts.get(name) || 0) +
                Math.max(1, Math.round(tagWeight / 25)) *
                  Math.max(0.5, seed.weight || 1),
            );
          }
        }
      } catch (error) {
        console.warn(
          `Failed to get Last.fm tags for ${seed.artistName}: ${error.message}`,
        );
      }
    }),
  );

  return {
    tagMap,
    tagWeights: tagCounts,
    genreWeights: genreCounts,
    tagsFound,
    topTags: buildWeightedTopList(tagCounts, 20),
    topGenres: buildWeightedTopList(genreCounts, 24),
  };
};

const getSeedTagMapKey = (seed) =>
  String(seed?.mbid || seed?.id || "")
    .trim()
    .toLowerCase();

const normalizeSeedTagList = (tags) =>
  (Array.isArray(tags) ? tags : [])
    .slice(0, 15)
    .map((tag) => String(tag || "").trim())
    .filter(Boolean);

const resolveRecommendationCandidates = async (
  recommendations,
  existingArtistKeys,
  maxResolve,
) => {
  const shortlist = recommendations.slice(
    0,
    Math.min(
      recommendations.length,
      Math.max(maxResolve, getDiscoveryRecommendationsPerRefresh() * 3),
    ),
  );

  await Promise.all(
    shortlist.map(async (item) => {
      if (item?.id || !item?.name) return;
      const cached = musicbrainzGetCachedArtistMbidByName(item.name);
      const resolved =
        cached || (await musicbrainzResolveArtistMbidByName(item.name));
      if (!resolved) return;
      item.id = resolved;
      item.navigateTo = resolved;
    }),
  );

  const merged = mergeResolvedRecommendations(
    recommendations,
    existingArtistKeys,
  )
    .filter((item) => item?.id || item?.navigateTo)
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
    Math.max(120, getDiscoveryRecommendationsPerRefresh() * 4),
  );
};

const buildRecommendationsFromSeeds = async ({
  seeds,
  existingArtistKeys,
  lastfmHealth,
  profileTagWeights,
  seedTagMap = new Map(),
  discoveryMode,
}) => {
  const recommendations = new Map();
  const maxPerSeed = getLastfmFailureRatio(lastfmHealth) >= 0.3 ? 10 : 16;

  await Promise.all(
    seeds.map(async (seed) => {
      try {
        const seedTagKey = getSeedTagMapKey(seed);
        let sourceTags = normalizeSeedTagList(seedTagMap.get(seedTagKey));
        if (sourceTags.length > 0) {
          recordLastfmResult(lastfmHealth, { cached: true });
        } else {
          const tagData = await lastfmRequest("artist.getTopTags", {
            mbid: seed.mbid,
          });
          recordLastfmResult(lastfmHealth, tagData);
          if (tagData?.toptags?.tag) {
            const tags = Array.isArray(tagData.toptags.tag)
              ? tagData.toptags.tag
              : [tagData.toptags.tag];
            sourceTags = normalizeSeedTagList(
              tags.map((tag) => tag?.name),
            );
          }
        }

        const similar = await lastfmRequest("artist.getSimilar", {
          mbid: seed.mbid,
          limit: getLastfmFailureRatio(lastfmHealth) >= 0.3 ? 12 : 25,
        });
        recordLastfmResult(lastfmHealth, similar);
        if (!similar?.similarartists?.artist) return;

        const artists = Array.isArray(similar.similarartists.artist)
          ? similar.similarartists.artist
          : [similar.similarartists.artist];
        for (const artist of artists.slice(0, maxPerSeed)) {
          addRecommendationCandidate(recommendations, {
            candidate: {
              mbid: artist?.mbid,
              name: artist?.name,
              image: pickLastfmImage(artist?.image),
              match: artist?.match,
            },
            seed,
            sourceTags,
            profileTagWeights,
            existingArtistKeys,
          });
        }
      } catch (error) {
        console.warn(
          `Error getting similar artists for ${seed.artistName}: ${error.message}`,
        );
      }
    }),
  );

  return finalizeRecommendationAccumulator(
    recommendations,
    Math.max(140, getDiscoveryRecommendationsPerRefresh() * 5),
    { discoveryMode },
  );
};

const discoveryPlaylistBuildTokens = new Map();

const getDiscoveryPlaylistBuildKey = (cacheNamespace = null) =>
  String(cacheNamespace || "global");

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
    recommendations: rerankCachedRecommendations({
      recommendations: discoveryData.recommendations || [],
      discoveryMode: getDiscoveryMode(),
    }),
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

const pickArray = (primary, fallback = []) =>
  Array.isArray(primary) && primary.length > 0
    ? primary
    : Array.isArray(fallback)
      ? fallback
      : [];

const normalizePlaylistBuildStringList = (value, limit = 10) => {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const entry of value) {
    const text = String(entry || "").trim();
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
};

const resolveDiscoveryDataForPlaylistBuild = (payload = {}) => {
  const cacheNamespace = String(payload?.cacheNamespace || "").trim() || null;
  const cached = getDiscoveryCache(cacheNamespace);
  const fallback =
    payload?.discoveryData && typeof payload.discoveryData === "object"
      ? payload.discoveryData
      : {};
  const provider =
    cached.provider || fallback.provider || DISCOVERY_PROVIDER_LASTFM;
  return {
    provider,
    capabilities:
      cached.capabilities ||
      fallback.capabilities ||
      getDiscoveryCapabilities(provider === DISCOVERY_PROVIDER_LASTFM),
    recommendations: pickArray(
      cached.recommendations,
      fallback.recommendations,
    ),
    globalTop: pickArray(cached.globalTop, fallback.globalTop),
    basedOn: pickArray(cached.basedOn, fallback.basedOn),
    topTags: pickArray(cached.topTags, fallback.topTags),
    topGenres: pickArray(cached.topGenres, fallback.topGenres),
    fallbackGenres: pickArray(cached.fallbackGenres, fallback.fallbackGenres),
    fallbackGenrePools:
      cached.fallbackGenrePools &&
      typeof cached.fallbackGenrePools === "object"
        ? cached.fallbackGenrePools
        : fallback.fallbackGenrePools &&
            typeof fallback.fallbackGenrePools === "object"
          ? fallback.fallbackGenrePools
          : {},
    discoverPlaylists: pickArray(
      cached.discoverPlaylists,
      fallback.discoverPlaylists,
    ),
    lastUpdated: cached.lastUpdated || fallback.lastUpdated || null,
  };
};

export async function runQueuedDiscoverPlaylistBuild(payload = {}) {
  const cacheNamespace = String(payload?.cacheNamespace || "").trim() || null;
  const buildKey = getDiscoveryPlaylistBuildKey(cacheNamespace);
  const buildToken = String(payload?.buildToken || "").trim();
  const activeToken = discoveryPlaylistBuildTokens.get(buildKey);
  if (activeToken && buildToken && activeToken !== buildToken) {
    return { skipped: true, reason: "stale_build" };
  }
  if (!getLastfmApiKey()) {
    return { skipped: true, reason: "lastfm_not_configured" };
  }

  return withHonkerLock(
    `discovery-playlist-build:${buildKey}`,
    async () => {
      const lockedToken = discoveryPlaylistBuildTokens.get(buildKey);
      if (lockedToken && buildToken && lockedToken !== buildToken) {
        return { skipped: true, reason: "stale_build" };
      }
      try {
        const baseDiscoveryData = resolveDiscoveryDataForPlaylistBuild(payload);
        if (
          baseDiscoveryData.recommendations.length === 0 &&
          baseDiscoveryData.globalTop.length === 0
        ) {
          return { skipped: true, reason: "empty_discovery_data" };
        }

        if (payload?.publishUpdate !== false) {
          recordDiscoverPlaylistBuildProgress("Building recommended playlists...");
        }

        const allLibraryArtistsRaw = await libraryManager.getAllArtists();
        const allLibraryArtists = Array.isArray(allLibraryArtistsRaw)
          ? allLibraryArtistsRaw
          : [];
        const existingArtistKeys = buildExistingArtistKeySet(allLibraryArtists);
        const { generateDiscoverPlaylists } =
          await import("./discoverPlaylistService.js");
        const discoverPlaylists = await generateDiscoverPlaylists({
          listenHistoryProfile: payload?.listenHistoryProfile || null,
          discoveryCache: baseDiscoveryData,
          basedOn: baseDiscoveryData.basedOn,
          topGenres: baseDiscoveryData.topGenres,
          topTags: baseDiscoveryData.topTags,
          recommendations: baseDiscoveryData.recommendations,
          globalTop: baseDiscoveryData.globalTop,
          libraryArtists: allLibraryArtists,
          libraryArtistKeys: existingArtistKeys,
          historyTopArtists: normalizePlaylistBuildStringList(
            payload?.historyTopArtists,
            3,
          ),
        });

        const currentToken = discoveryPlaylistBuildTokens.get(buildKey);
        if (currentToken && buildToken && currentToken !== buildToken) {
          return { skipped: true, reason: "stale_build" };
        }

        const playlistData = { discoverPlaylists };
        if (!cacheNamespace) {
          discoveryCache.discoverPlaylists = discoverPlaylists;
        }
        dbOps.updateDiscoveryCache(playlistData, cacheNamespace);

        if (payload?.publishUpdate !== false) {
          emitDiscoveryDataUpdate(
            {
              ...baseDiscoveryData,
              discoverPlaylists,
            },
            {
              phase: "playlists_completed",
              progressMessage: "Discover playlists updated",
            },
          );
        }
        return { built: true, playlistCount: discoverPlaylists.length };
      } finally {
        if (discoveryPlaylistBuildTokens.get(buildKey) === buildToken) {
          discoveryPlaylistBuildTokens.delete(buildKey);
        }
      }
    },
    {
      ttlSeconds: 300,
      waitTimeoutMs: 30 * 60 * 1000,
      retryDelayMs: 500,
    },
  );
}

export function emitDiscoverPlaylistBuildFailure(payload = {}, error) {
  if (payload?.publishUpdate === false) return;
  const message = error?.message || String(error || "Unknown error");
  clearDiscoverPlaylistBuildProgress();
  websocketService.emitDiscoveryUpdate({
    isUpdating: false,
    playlistsUpdating: false,
    playlistsUpdateMessage: null,
    configured: true,
    phase: "playlists_error",
    progress: 100,
    progressMessage: "Discover playlists failed to update",
    error: message,
  });
}

const scheduleDiscoverPlaylistBuild = ({
  baseDiscoveryData,
  cacheNamespace = null,
  playlistArgs = {},
  publishUpdate = true,
} = {}) => {
  if (!baseDiscoveryData || !getLastfmApiKey()) return;

  const buildKey = getDiscoveryPlaylistBuildKey(cacheNamespace);
  const buildToken = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  discoveryPlaylistBuildTokens.set(buildKey, buildToken);

  const payload = {
    cacheNamespace,
    buildToken,
    publishUpdate,
    requestedAt: Date.now(),
    listenHistoryProfile: playlistArgs.listenHistoryProfile || null,
    historyTopArtists: normalizePlaylistBuildStringList(
      playlistArgs.historyTopArtists,
      3,
    ),
    discoveryData: baseDiscoveryData,
  };

  enqueueDiscoveryPlaylistBuildJob(payload);
  if (publishUpdate) {
    recordDiscoverPlaylistBuildProgress("Updating recommended playlists...");
  }
};

export const updateDiscoveryCache = async (options = {}) => {
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
  console.log("Starting background update of discovery recommendations...");
  emitDiscoveryProgress("starting", "Preparing discovery refresh", 5);
  import("./aurralHistoryService.js")
    .then(({ recordDiscoveryRefreshStarted }) =>
      recordDiscoveryRefreshStarted(),
    )
    .catch(() => {});

  try {
    const { libraryManager } = await import("./libraryManager.js");
    emitDiscoveryProgress("loading_sources", "Loading library artists", 12);
    const [recentLibraryArtists, allLibraryArtistsRaw] = await Promise.all([
      libraryManager.getRecentArtists(40),
      libraryManager.getAllArtists(),
    ]);
    const allLibraryArtists = Array.isArray(allLibraryArtistsRaw)
      ? allLibraryArtistsRaw
      : [];
    const libraryArtists =
      recentLibraryArtists.length > 0
        ? recentLibraryArtists
        : allLibraryArtists.slice(0, 40);
    console.log(`Found ${allLibraryArtists.length} artists in library.`);

    const hasLastfmKey = !!getLastfmApiKey();
    const lastfmHealth = createLastfmHealth();

    if (!hasLastfmKey) {
      console.log(
        "No Last.fm API key configured. Building ListenBrainz fallback discovery.",
      );
      emitDiscoveryProgress(
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
          emitDiscoveryProgress(phase, progressMessage, progress, {
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
        await import("./aurralHistoryService.js");
      recordDiscoveryUpdated({
        recommendationCount: fallbackData.recommendations?.length || 0,
        genreCount: fallbackData.topGenres?.length || 0,
      });
      return;
    }

    emitDiscoveryProgress(
      "collecting_seeds",
      "Collecting recommendation seed artists",
      20,
    );

    const historyArtists = [];
    const defaultListenHistoryProfile = getDefaultListenHistoryProfile(
      dbOps.getSettings(),
    );
    const discoveryPeriod = getLastfmDiscoveryPeriod();
    const listeningHistoryUsersConfigured = hasListeningHistoryUsers();
    if (
      defaultListenHistoryProfile &&
      discoveryPeriod !== "none" &&
      !listeningHistoryUsersConfigured
    ) {
      try {
        const fetched = await fetchListenHistoryArtists(
          defaultListenHistoryProfile,
          discoveryPeriod,
          lastfmHealth,
        );
        historyArtists.push(
          ...fetched.map((artist) => ({
            ...artist,
            source: defaultListenHistoryProfile.listenHistoryProvider,
          })),
        );
      } catch (error) {
        console.warn(
          `[Discovery] Failed to load default listening history for ${defaultListenHistoryProfile.listenHistoryUsername}: ${error.message}`,
        );
      }
    }

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

    console.log(
      `Sampling tags/genres from ${profileSample.length} artists (${libraryArtists.length} library, ${historyArtists.length} history)...`,
    );
    const { tagsFound, topTags, topGenres, tagMap, tagWeights, genreWeights } =
      getLastfmApiKey()
        ? await collectSeedTagsAndGenres(
            profileSample,
            lastfmHealth,
            "building_genres",
          )
        : {
            tagsFound: 0,
            topTags: [],
            topGenres: [],
            tagMap: new Map(),
            tagWeights: new Map(),
            genreWeights: new Map(),
          };
    const tasteProfile = buildTasteProfile({
      recentLibraryArtists,
      allLibraryArtists,
      historyArtists,
      tagMap,
      tagWeights,
      genreWeights,
    });
    const seeds = buildDiscoverySeedList({
      libraryArtists: tasteProfile.librarySeeds,
      historyArtists: tasteProfile.historySeeds,
    });
    console.log(
      `Found tags for ${tagsFound} out of ${profileSample.length} artists`,
    );
    discoveryCache.topTags =
      tasteProfile.topTags.length > 0 ? tasteProfile.topTags : topTags;
    discoveryCache.topGenres =
      tasteProfile.topGenres.length > 0 ? tasteProfile.topGenres : topGenres;

    console.log(
      `Identified Top Genres: ${discoveryCache.topGenres.join(", ")}`,
    );

    if (getLastfmApiKey()) {
      console.log("Fetching Global Trending (real-time style) from Last.fm...");
      emitDiscoveryProgress(
        "fetching_trending",
        "Fetching global trending artists",
        50,
      );
      try {
        const trendingArtists = [];
        const trackData = await lastfmRequest("chart.getTopTracks", {
          limit: getLastfmFailureRatio(lastfmHealth) >= 0.3 ? 60 : 100,
        });
        recordLastfmResult(lastfmHealth, trackData);
        if (trackData?.tracks?.track) {
          const tracks = Array.isArray(trackData.tracks.track)
            ? trackData.tracks.track
            : [trackData.tracks.track];
          for (const track of tracks) {
            const artist = buildTrendingArtistEntry(track?.artist);
            if (!artist) continue;
            if (!artist.image) {
              artist.image = pickLastfmImage(track?.image);
            }
            const trackName = String(track?.name || "").trim();
            if (trackName) {
              artist.sampleTrack = {
                trackName,
                albumName:
                  String(
                    track?.album?.title || track?.album?.["#text"] || "",
                  ).trim() || null,
              };
            }
            trendingArtists.push(artist);
          }
        }
        let globalTop = mergeResolvedRecommendations(
          trendingArtists,
          existingArtistKeys,
        ).slice(0, 32);
        if (globalTop.length < 12) {
          const topData = await lastfmRequest("chart.getTopArtists", {
            limit: getLastfmFailureRatio(lastfmHealth) >= 0.3 ? 60 : 100,
          });
          recordLastfmResult(lastfmHealth, topData);
          if (topData?.artists?.artist) {
            const topArtists = Array.isArray(topData.artists.artist)
              ? topData.artists.artist
              : [topData.artists.artist];
            globalTop = mergeResolvedRecommendations(
              [
                ...globalTop,
                ...topArtists.map(buildTrendingArtistEntry).filter(Boolean),
              ],
              existingArtistKeys,
            ).slice(0, 32);
          }
        }

        const globalFailureRatio = getLastfmFailureRatio(lastfmHealth);
        const maxGlobalResolve =
          globalFailureRatio >= 0.5 ? 10 : globalFailureRatio >= 0.3 ? 18 : 30;
        await Promise.all(
          globalTop.slice(0, maxGlobalResolve).map(async (item) => {
            if (!item?.name || item?.id) return;
            const resolved =
              musicbrainzGetCachedArtistMbidByName(item.name) ||
              (await musicbrainzResolveArtistMbidByName(item.name));
            if (!resolved) return;
            item.id = resolved;
            item.navigateTo = resolved;
          }),
        );

        discoveryCache.globalTop = mergeResolvedRecommendations(
          globalTop,
          existingArtistKeys,
        )
          .filter((item) => item?.id || item?.navigateTo)
          .slice(0, 32);
        console.log(
          `Found ${discoveryCache.globalTop.length} trending artists (from top tracks).`,
        );
      } catch (e) {
        console.error(`Failed to fetch Global Top: ${e.message}`);
      }
    }

    const recSample = seeds.slice(
      0,
      Math.max(
        18,
        Math.min(
          seeds.length,
          getLastfmFailureRatio(lastfmHealth) >= 0.3 ? 20 : 32,
        ),
      ),
    );

    console.log(
      `Generating recommendations based on ${recSample.length} seed artists...`,
    );
    emitDiscoveryProgress(
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
      );
      recommendationsArray = rerankCachedRecommendations({
        recommendations: recommendationsArray,
        discoveryMode: getDiscoveryMode(),
      });
    } else {
      console.warn("Last.fm API key required for similar artist discovery.");
    }

    console.log(
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
      discoverPlaylists: discoveryCache.discoverPlaylists || [],
      lastUpdated: new Date().toISOString(),
    };

    const allToHydrate = [
      ...(discoveryData.globalTop || []),
      ...recommendationsArray,
    ].filter((a) => !a.image);
    console.log(`Hydrating images for ${allToHydrate.length} artists...`);
    emitDiscoveryProgress("hydrating_images", "Hydrating artist images", 90);
    await hydrateArtistImages(allToHydrate, {
      limit: allToHydrate.length,
      batchSize: 10,
      delayMs: 50,
    });

    Object.assign(discoveryCache, discoveryData);
    dbOps.updateDiscoveryCache(discoveryData);
    emitDiscoveryProgress(
      "saving_results",
      "Saving refreshed discovery cache",
      96,
    );
    const { notifyDiscoveryUpdated } = await import("./notificationService.js");
    notifyDiscoveryUpdated().catch((err) =>
      console.warn("[Discovery] Notification failed:", err.message),
    );
    console.log(
      `Discovery data written to database: ${discoveryData.recommendations.length} recommendations, ${discoveryData.topGenres.length} genres, ${discoveryData.globalTop.length} trending`,
    );

    console.log("Discovery cache updated successfully.");
    console.log(
      `Summary: ${recommendationsArray.length} recommendations, ${discoveryCache.topGenres.length} genres, ${discoveryCache.globalTop.length} trending artists`,
    );
    discoveryCache.isUpdating = false;
    clearDiscoveryUpdateProgress();

    if (listeningHistoryUsersConfigured) {
      emitDiscoveryDataUpdate(discoveryData, {
        progressMessage: "Discovery refresh completed",
      });
      refreshListeningHistoryUserCaches().catch((error) => {
        console.error(
          `[Discovery] Background per-user refresh failed: ${error.message}`,
        );
      });
    } else {
      scheduleDiscoverPlaylistBuild({
        baseDiscoveryData: discoveryData,
        playlistArgs: {
          discoveryCache: discoveryData,
          basedOn: discoveryData.basedOn,
          topGenres: discoveryData.topGenres,
          topTags: discoveryData.topTags,
          recommendations: discoveryData.recommendations,
          globalTop: discoveryData.globalTop,
          libraryArtists: allLibraryArtists,
          libraryArtistKeys: existingArtistKeys,
          historyTopArtists: historyArtists
            .slice(0, 3)
            .map((artist) => artist.artistName)
            .filter(Boolean),
        },
      });
      emitDiscoveryDataUpdate(discoveryData, {
        progressMessage: "Discovery refresh completed",
      });
    }

    const { recordDiscoveryUpdated } =
      await import("./aurralHistoryService.js");
    recordDiscoveryUpdated({
      recommendationCount: discoveryData.recommendations?.length || 0,
      genreCount: discoveryData.topGenres?.length || 0,
    });

    try {
      const cleaned = dbOps.cleanOldImageCache(30);
      if (cleaned?.changes > 0) {
        console.log(
          `[Discovery] Cleaned ${cleaned.changes} old image cache entries`,
        );
      }
      dbOps.cleanOldMusicbrainzArtistMbidCache(90);
    } catch (e) {
      console.warn("[Discovery] Failed to clean old image cache:", e.message);
    }
  } catch (error) {
    console.error("Failed to update discovery cache:", error.message);
    console.error("Stack trace:", error.stack);
    websocketService.emitDiscoveryUpdate({
      isUpdating: false,
      configured: true,
      phase: "error",
      progress: 100,
      progressMessage: "Discovery refresh failed",
      error: error.message,
    });
    import("./aurralHistoryService.js")
      .then(({ recordDiscoveryRefreshFailed }) =>
        recordDiscoveryRefreshFailed(error.message),
      )
      .catch(() => {});
  } finally {
    if (pendingUserDiscoveryProfiles.size > 0) {
      flushPendingUserDiscoveryRefreshes().catch((error) => {
        console.error(
          `[Discovery] Failed to flush deferred per-user refreshes: ${error.message}`,
        );
      });
    }
    discoveryCache.isUpdating = false;
    clearDiscoveryUpdateProgress();
  }
};

export const updateUserDiscoveryCache = async (
  listenHistoryProfile,
  options = {},
) => {
  const { duringGlobalRefresh = false } = options;
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
    pendingUserDiscoveryProfiles.set(cacheNamespace, profile);
    enqueueDiscoveryUserRefreshJob(
      {
        listenHistoryProfile: profile,
        requestedAt: Date.now(),
        reason: "global_refresh_in_progress",
      },
      { delaySeconds: 300 },
    );
    return { skipped: true, reason: "global_refresh_in_progress" };
  }
  const shouldPublishRefreshState = !duringGlobalRefresh;
  console.log(
    `[Discovery] Starting per-user refresh for ${profile.listenHistoryProvider} user ${profile.listenHistoryUsername}...`,
  );

  if (shouldPublishRefreshState) {
    discoveryCache.isUpdating = true;
    emitDiscoveryProgress(
      "generating_playlists",
      "Building discover playlists",
      92,
    );
  }

  try {
    const [recentLibraryArtistsRaw, allLibraryArtistsRaw] = await Promise.all([
      libraryManager.getRecentArtists(40),
      libraryManager.getAllArtists(),
    ]);
    const recentLibraryArtists = Array.isArray(recentLibraryArtistsRaw)
      ? recentLibraryArtistsRaw
      : [];
    const allLibraryArtists = Array.isArray(allLibraryArtistsRaw)
      ? allLibraryArtistsRaw
      : [];
    const existingArtistKeys = buildExistingArtistKeySet(allLibraryArtists);

    const lastfmHealth = createLastfmHealth();
    const discoveryPeriod = getLastfmDiscoveryPeriod();
    const historyArtists = [];

    if (discoveryPeriod !== "none") {
      console.log(
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
        console.log(
          `[Discovery] Found ${historyArtists.length} ${profile.listenHistoryProvider} artists for ${profile.listenHistoryUsername}.`,
        );
      } catch (e) {
        console.error(
          `[Discovery] Failed to fetch ${profile.listenHistoryProvider} artists for ${profile.listenHistoryUsername}: ${e.message}`,
        );
      }
    }

    const provisionalSeeds = buildDiscoverySeedList({
      libraryArtists: recentLibraryArtists.map((a) => ({
        mbid: a.mbid,
        artistName: a.artistName,
        source: "library",
      })),
      historyArtists,
    });
    const profileSample = provisionalSeeds.slice(
      0,
      selectDiscoverySeedSample(
        provisionalSeeds,
        getLastfmFailureRatio(lastfmHealth),
      ).length,
    );
    const { topTags, topGenres, tagMap, tagWeights, genreWeights } =
      await collectSeedTagsAndGenres(profileSample, lastfmHealth);
    const tasteProfile = buildTasteProfile({
      recentLibraryArtists,
      allLibraryArtists,
      historyArtists,
      tagMap,
      tagWeights,
      genreWeights,
    });
    const seeds = buildDiscoverySeedList({
      libraryArtists: tasteProfile.librarySeeds,
      historyArtists: tasteProfile.historySeeds,
    });
    const recSample = seeds.slice(
      0,
      Math.max(
        18,
        Math.min(
          seeds.length,
          getLastfmFailureRatio(lastfmHealth) >= 0.3 ? 20 : 32,
        ),
      ),
    );
    const rawRecommendations = await buildRecommendationsFromSeeds({
      seeds: recSample,
      existingArtistKeys,
      lastfmHealth,
      profileTagWeights: tasteProfile.profileTagWeights,
      seedTagMap: tagMap,
      discoveryMode: getDiscoveryMode(),
    });
    let recommendationsArray = await resolveRecommendationCandidates(
      rawRecommendations,
      existingArtistKeys,
      40,
    );
    recommendationsArray = rerankCachedRecommendations({
      recommendations: recommendationsArray,
      discoveryMode: getDiscoveryMode(),
    });

    await hydrateArtistImages(recommendationsArray, {
      limit: recommendationsArray.length,
      batchSize: 10,
      delayMs: 50,
    });

    const userData = {
      recommendations: recommendationsArray,
      basedOn: recSample.map((a) => ({
        name: a.artistName,
        id: a.mbid,
        source: a.source || "library",
        profileBucket: a.profileBucket || null,
      })),
      topTags: tasteProfile.topTags.length > 0 ? tasteProfile.topTags : topTags,
      topGenres:
        tasteProfile.topGenres.length > 0 ? tasteProfile.topGenres : topGenres,
    };

    const { generateDiscoverPlaylists } =
      await import("./discoverPlaylistService.js");
    userData.discoverPlaylists = await generateDiscoverPlaylists({
      listenHistoryProfile: profile,
      discoveryCache: {
        ...getDiscoveryCache(profile),
        ...userData,
        recommendations: recommendationsArray,
      },
      basedOn: userData.basedOn,
      topGenres: userData.topGenres,
      topTags: userData.topTags,
      recommendations: recommendationsArray,
      libraryArtists: allLibraryArtists,
      libraryArtistKeys: existingArtistKeys,
      historyTopArtists: tasteProfile.historySeeds
        .slice(0, 3)
        .map((artist) => artist.artistName)
        .filter(Boolean),
      onProgress: shouldPublishRefreshState
        ? ({ completed, total }) => {
            const pct =
              total > 0 ? 92 + Math.round((completed / total) * 4) : 92;
            emitDiscoveryProgress(
              "generating_playlists",
              `Building discover playlists (${completed}/${total})`,
              pct,
            );
          }
        : undefined,
    });

    dbOps.updateDiscoveryCache(userData, cacheNamespace);
    console.log(
      `[Discovery] ${profile.listenHistoryProvider}:${profile.listenHistoryUsername} refresh complete: ${recommendationsArray.length} recommendations, ${topGenres.length} genres.`,
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
    console.error(
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

export const getUserDiscoveryCacheStaleness = (cacheNamespace) => {
  const data = dbOps.getDiscoveryCache(cacheNamespace);
  if (!data.lastUpdated) return Infinity;
  return Date.now() - new Date(data.lastUpdated).getTime();
};

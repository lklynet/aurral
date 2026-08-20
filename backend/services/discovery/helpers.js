
import { randomUUID } from "crypto";
import { dbOps } from "../../db/helpers/index.js";

export const LASTFM_PERIODS = [
  "none",
  "7day",
  "1month",
  "3month",
  "6month",
  "12month",
  "overall",
];
export const LISTENBRAINZ_RANGE_BY_PERIOD = {
  "7day": "week",
  "1month": "month",
  "3month": "quarter",
  "6month": "half_yearly",
  "12month": "year",
  overall: "all_time",
};

export const DISCOVERY_QUALITY_INITIAL = "initial";
export const DISCOVERY_QUALITY_ENRICHING = "enriching";
export const DISCOVERY_QUALITY_ENRICHED = "enriched";

const DISCOVERY_NETWORK_CONCURRENCY = 6;
const DISCOVERY_CANDIDATE_MULTIPLIER = 2.5;
const DISCOVERY_RECOMMENDATIONS_MAX = 500;
const DISCOVERY_RECOMMENDATIONS_DEFAULT = 200;

export const getDiscoveryRecommendationPoolLimit = () =>
  DISCOVERY_RECOMMENDATIONS_MAX;

export const getDiscoveryRecommendationsPerRefresh = () => {
  const settings = dbOps.getSettings();
  const parsed = parseInt(
    settings.integrations?.lastfm?.discoveryRecommendationsPerRefresh,
    10,
  );
  if (!Number.isFinite(parsed)) return DISCOVERY_RECOMMENDATIONS_DEFAULT;
  return Math.min(DISCOVERY_RECOMMENDATIONS_MAX, Math.max(50, parsed));
};

export const isDiscoveryPersonalizedEnabled = () => {
  const settings = dbOps.getSettings();
  const value = settings.integrations?.lastfm?.discoveryPersonalizedEnabled;
  if (typeof value === "boolean") return value;
  return true;
};

export const getDiscoveryAutoRefreshHours = () => {
  const settings = dbOps.getSettings();
  const parsed = parseInt(
    settings.integrations?.lastfm?.discoveryAutoRefreshHours,
    10,
  );
  return [24, 168, 720].includes(parsed) ? parsed : 168;
};

export const getLastfmDiscoveryPeriod = () => {
  const settings = dbOps.getSettings();
  const p = settings.integrations?.lastfm?.discoveryPeriod;
  return p && LASTFM_PERIODS.includes(p) ? p : "1month";
};

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
      settings.integrations?.ticketmaster?.localDiscoveryIncludeRecommendations !== false,
    includeTrending:
      settings.integrations?.ticketmaster?.localDiscoveryIncludeTrending !== false,
  };
};

export const getListenbrainzRange = (discoveryPeriod) => {
  if (discoveryPeriod === "none") return null;
  return LISTENBRAINZ_RANGE_BY_PERIOD[discoveryPeriod] || "month";
};

export const getDiscoveryUserRefreshDelaySeconds = () => {
  const parsed = Number(
    process.env.AURRAL_DISCOVERY_USER_REFRESH_DELAY_SECONDS,
  );
  if (!Number.isFinite(parsed)) return 10;
  return Math.max(5, Math.min(3600, Math.floor(parsed)));
};

export const normalizeTextList = (value) => {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const entry of value) {
    const normalized = String(entry || "").trim().toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
};

export const normalizePlaylistBuildStringList = (value, limit = 10) => {
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

export const buildWeightedTopList = (map, limit) =>
  Array.from(map.entries())
    .sort((left, right) => {
      if (right[1] !== left[1]) return right[1] - left[1];
      return String(left[0] || "").localeCompare(String(right[0] || ""));
    })
    .slice(0, limit)
    .map(([name]) => name);

export const getLastfmFailureRatio = (health) => {
  const total = health.success + health.failure;
  if (total === 0) return 0;
  return health.failure / total;
};

const shrinkByFailureRatio = (base, failureRatio, shrink05, shrink03) => {
  if (failureRatio >= 0.5) return Math.min(shrink05, base);
  if (failureRatio >= 0.3) return Math.min(shrink03, base);
  return base;
};

export const getDiscoveryTagSeedLimit = (count, failureRatio) => {
  const target = getDiscoveryRecommendationsPerRefresh();
  const sampleBase = Math.min(
    count,
    Math.max(25, Math.min(45, Math.ceil(target / 5))),
  );
  return shrinkByFailureRatio(sampleBase, failureRatio, 12, 24);
};

export const getDiscoveryRecommendationSeedLimit = (count, failureRatio) => {
  const target = getDiscoveryRecommendationsPerRefresh();
  const sampleBase = Math.min(
    count,
    Math.max(32, Math.min(56, Math.ceil(target / 4))),
  );
  return shrinkByFailureRatio(sampleBase, failureRatio, 16, 32);
};

export const getSimilarArtistSampling = (failureRatio) => {
  if (failureRatio >= 0.5) {
    return { similarLimit: 12, maxPerSeed: 10 };
  }
  if (failureRatio >= 0.3) {
    return { similarLimit: 20, maxPerSeed: 14 };
  }
  const target = getDiscoveryRecommendationsPerRefresh();
  const maxPerSeed = Math.min(24, Math.max(16, Math.ceil(target / 9)));
  return {
    similarLimit: Math.min(40, Math.max(25, maxPerSeed + 12)),
    maxPerSeed,
  };
};

export const getSecondHopArtistSampling = (failureRatio) => {
  if (failureRatio >= 0.5) {
    return { seedLimit: 0, similarLimit: 0, maxPerSeed: 0 };
  }
  if (failureRatio >= 0.3) {
    return { seedLimit: 16, similarLimit: 10, maxPerSeed: 5 };
  }
  const target = getDiscoveryRecommendationsPerRefresh();
  return {
    seedLimit: Math.min(40, Math.max(25, Math.ceil(target / 6))),
    similarLimit: 15,
    maxPerSeed: 8,
  };
};

export const getSecondHopRecommendationLimit = () =>
  Math.ceil(getDiscoveryRecommendationsPerRefresh() * 0.35);

export const getCandidateTagHydrationLimit = (count, failureRatio, depth = 1) => {
  if (count <= 0) return 0;
  const target = getDiscoveryRecommendationsPerRefresh();
  if (failureRatio >= 0.5) return Math.min(count, depth >= 2 ? 0 : 40);
  if (failureRatio >= 0.3) {
    return Math.min(
      count,
      depth >= 2 ? 24 : Math.max(80, Math.ceil(target * 0.75)),
    );
  }
  return Math.min(
    count,
    depth >= 2
      ? getSecondHopRecommendationLimit()
      : Math.max(target, Math.ceil(target * 1.5)),
  );
};

const getDiscoveryCandidateLimit = () =>
  Math.min(
    getDiscoveryRecommendationPoolLimit(),
    Math.max(
      160,
      Math.ceil(
        getDiscoveryRecommendationsPerRefresh() * DISCOVERY_CANDIDATE_MULTIPLIER,
      ),
    ),
  );

export const createDiscoveryRunId = () => randomUUID();

export const selectDiscoverySeedSample = (seeds, failureRatio) => {
  const sampleSize = getDiscoveryTagSeedLimit(seeds.length, failureRatio);
  return [...seeds].slice(0, sampleSize);
};

export const getDiscoveryNetworkConcurrency = () => DISCOVERY_NETWORK_CONCURRENCY;
export { getDiscoveryCandidateLimit };

export const wait = (delayMs) =>
  delayMs > 0
    ? new Promise((resolve) => {
        setTimeout(resolve, delayMs);
      })
    : Promise.resolve();

export const mapWithConcurrency = async (
  items,
  concurrency,
  worker,
  { stopOnError = false } = {},
) => {
  const list = Array.isArray(items) ? items : [];
  const limit = Math.max(1, Number(concurrency) || 1);
  if (list.length === 0) return [];
  const results = new Array(list.length);
  let nextIndex = 0;
  let failed = false;
  let firstError;
  const runners = Array.from(
    { length: Math.min(limit, list.length) },
    async () => {
      while (!failed && nextIndex < list.length) {
        const index = nextIndex;
        nextIndex += 1;
        try {
          results[index] = await worker(list[index], index);
        } catch (error) {
          if (!stopOnError) throw error;
          if (!failed) {
            failed = true;
            firstError = error;
          }
        }
      }
    },
  );
  await Promise.all(runners);
  if (failed) throw firstError;
  return results;
};

export const pickLastfmImage = (images) => {
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

export const formatTrendingPopularity = (artist) => {
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

export const buildTrendingArtistEntry = (artist) => {
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

export const getSeedTagMapKey = (seed) =>
  String(seed?.mbid || seed?.id || seed?.artistName || seed?.name || "")
    .trim()
    .toLowerCase();

export const normalizeSeedTagList = (tags) =>
  (Array.isArray(tags) ? tags : [])
    .slice(0, 15)
    .map((tag) => String(tag || "").trim().replace(/-/g, " "))
    .filter(Boolean);

export const INHERITED_TAG_MINIMUM = 3;

export const canInheritTagsFromSeeds = (item) => {
  if (item.candidateTagsHydrated && item.tagSource === "lastfm_artist") return false;
  const seedTagCount = Array.isArray(item.tags) ? item.tags.length : 0;
  return seedTagCount >= INHERITED_TAG_MINIMUM;
};

import { randomUUID } from "crypto";
import pMap, { pMapSkip } from "p-map";
import * as v from "valibot";
import { dbOps } from "../../db/helpers/index.ts";
import type { ArtistMatchFields } from "./artistKeys.ts";

export const DISCOVERY_QUALITY_INITIAL = "initial";
export const DISCOVERY_QUALITY_ENRICHING = "enriching";
export const DISCOVERY_QUALITY_ENRICHED = "enriched";

const DISCOVERY_NETWORK_CONCURRENCY = 6;
const DISCOVERY_CANDIDATE_MULTIPLIER = 2.5;
const DISCOVERY_RECOMMENDATIONS_MAX = 500;
export const DISCOVERY_RECOMMENDATIONS_PER_REFRESH = 200;
export const DISCOVERY_REFRESH_MS = 7 * 24 * 60 * 60 * 1000;

export const getDiscoveryRecommendationPoolLimit = () => DISCOVERY_RECOMMENDATIONS_MAX;

export const DISCOVERY_MODES = ["safer", "balanced", "deeper"] as const;
export type DiscoveryMode = (typeof DISCOVERY_MODES)[number];
const discoveryModeSchema = v.picklist(DISCOVERY_MODES);
const discoveryModeKey = (userId: number) => `user:${userId}:discoveryMode`;

export const getDiscoveryMode = (userId: number | null): DiscoveryMode =>
  (userId != null && dbOps.getJSONSetting(discoveryModeKey(userId), discoveryModeSchema)) ||
  "balanced";

export const setDiscoveryMode = (userId: number, mode: DiscoveryMode) =>
  dbOps.setJSONSetting(discoveryModeKey(userId), mode);

export const normalizeTextList = (value: unknown) => {
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

export const buildWeightedTopList = <K>(map: Map<K, number>, limit: number): K[] =>
  Array.from(map.entries())
    .sort((left, right) => {
      if (right[1] !== left[1]) return right[1] - left[1];
      return String(left[0] || "").localeCompare(String(right[0] || ""));
    })
    .slice(0, limit)
    .map(([name]) => name);

export const getSourceFailureRatio = (health: { success: number; failure: number }) => {
  const total = health.success + health.failure;
  if (total === 0) return 0;
  return health.failure / total;
};

export const getDiscoveryRecommendationSeedLimit = () =>
  Math.max(32, Math.min(56, Math.ceil(DISCOVERY_RECOMMENDATIONS_PER_REFRESH / 4)));

export const getSimilarArtistSampling = (failureRatio: number) => {
  if (failureRatio >= 0.5) {
    return { similarLimit: 12, maxPerSeed: 10 };
  }
  if (failureRatio >= 0.3) {
    return { similarLimit: 20, maxPerSeed: 14 };
  }
  const target = DISCOVERY_RECOMMENDATIONS_PER_REFRESH;
  const maxPerSeed = Math.min(24, Math.max(16, Math.ceil(target / 9)));
  return {
    similarLimit: Math.min(40, Math.max(25, maxPerSeed + 12)),
    maxPerSeed,
  };
};

export const getSecondHopArtistSampling = (failureRatio: number) => {
  if (failureRatio >= 0.5) {
    return { seedLimit: 0, similarLimit: 0, maxPerSeed: 0 };
  }
  if (failureRatio >= 0.3) {
    return { seedLimit: 16, similarLimit: 10, maxPerSeed: 5 };
  }
  const target = DISCOVERY_RECOMMENDATIONS_PER_REFRESH;
  return {
    seedLimit: Math.min(40, Math.max(25, Math.ceil(target / 6))),
    similarLimit: 15,
    maxPerSeed: 8,
  };
};

export const getSecondHopRecommendationLimit = () =>
  Math.ceil(DISCOVERY_RECOMMENDATIONS_PER_REFRESH * 0.35);

export const getCandidateTagHydrationLimit = (count: number, failureRatio: number, depth = 1) => {
  if (count <= 0) return 0;
  const target = DISCOVERY_RECOMMENDATIONS_PER_REFRESH;
  if (failureRatio >= 0.5) return Math.min(count, depth >= 2 ? 0 : 40);
  if (failureRatio >= 0.3) {
    return Math.min(count, depth >= 2 ? 24 : Math.max(80, Math.ceil(target * 0.75)));
  }
  return Math.min(
    count,
    depth >= 2 ? getSecondHopRecommendationLimit() : Math.max(target, Math.ceil(target * 1.5)),
  );
};

const getDiscoveryCandidateLimit = () =>
  Math.min(
    getDiscoveryRecommendationPoolLimit(),
    Math.max(
      160,
      Math.ceil(DISCOVERY_RECOMMENDATIONS_PER_REFRESH * DISCOVERY_CANDIDATE_MULTIPLIER),
    ),
  );

export const createDiscoveryRunId = () => randomUUID();

export const getDiscoveryNetworkConcurrency = () => DISCOVERY_NETWORK_CONCURRENCY;

export const interleaveLists = <T extends {} | null>(...lists: T[][]) => {
  const result: T[] = [];
  const longest = Math.max(0, ...lists.map((list) => list.length));
  for (let index = 0; index < longest; index += 1) {
    for (const list of lists) {
      const item = list[index];
      if (item !== undefined) result.push(item);
    }
  }
  return result;
};
export { getDiscoveryCandidateLimit };

export const mapWithConcurrency = async <T, R>(
  items: readonly T[] | null | undefined,
  concurrency: number,
  worker: (item: T, index: number) => R | Promise<R>,
  { stopOnError = false } = {},
) => {
  const list = items ?? [];
  const options = { concurrency: Math.max(1, Number(concurrency) || 1) };
  if (!stopOnError) return pMap(list, worker, options);
  let firstError: unknown;
  const results = await pMap(
    list,
    async (item, index) => {
      if (firstError) return pMapSkip;
      try {
        return await worker(item, index);
      } catch (error) {
        firstError ??= error;
        return pMapSkip;
      }
    },
    options,
  );
  if (firstError) throw firstError;
  return results;
};

export const getSeedTagMapKey = (seed: ArtistMatchFields | null | undefined) =>
  String(seed?.mbid || seed?.id || seed?.artistName || seed?.name || "")
    .trim()
    .toLowerCase();

export const normalizeSeedTagList = (tags: unknown) =>
  (Array.isArray(tags) ? tags : [])
    .slice(0, 15)
    .map((tag) =>
      String(tag || "")
        .trim()
        .replace(/-/g, " "),
    )
    .filter(Boolean);

export const INHERITED_TAG_MINIMUM = 3;

export const canInheritTagsFromSeeds = (item: {
  candidateTagsHydrated?: boolean;
  tagSource?: string;
  tags?: unknown[];
}) => {
  if (item.candidateTagsHydrated && item.tagSource === "lastfm_artist") return false;
  const seedTagCount = Array.isArray(item.tags) ? item.tags.length : 0;
  return seedTagCount >= INHERITED_TAG_MINIMUM;
};

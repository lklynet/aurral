import * as v from "valibot";
import { isOwnKey } from "../../../lib/ownKey.ts";
import { lenient, listOf } from "../../db/helpers/storedSchemas.ts";
import { UUID_REGEX } from "../../../lib/uuid.ts";

export interface ArtistIdentity {
  id?: string | null;
  mbid?: string | null;
  foreignArtistId?: string | null;
  name?: string | null;
  artistName?: string | null;
}

export interface SeedArtistInput extends ArtistIdentity {
  source?: string | null;
  playcount?: number | null;
  affinityWeight?: number | null;
  profileBucket?: string | null;
}

export interface DiscoverySeed {
  mbid: string | null;
  artistName: string;
  source: string;
  identityKeys: string[];
  playcount: number;
  weight: number;
  affinityWeight: number;
  profileBucket: string | null;
}

export interface RecommendationSeed {
  artistName: string;
  source?: string;
  weight?: number;
  affinityWeight?: number;
  profileBucket?: string | null;
  similarityMultiplier?: number;
  tagAffinityMultiplier?: number;
  discoveryDepth?: number;
}

export interface RecommendationCandidate {
  mbid?: string | null;
  name?: string | null;
  image?: string | null;
  match?: number;
  similarityMultiplier?: number;
  tagAffinityMultiplier?: number;
  discoveryDepth?: number;
}

export type SupportingSeed = {
  artistName: string;
  source: string;
  weight: number;
  profileBucket: string | null;
};

export interface RecommendationAccumulatorEntry {
  id: string | null;
  name: string;
  type: string;
  image: string | null;
  bestMatch: number;
  rawContribution: number;
  scoreSimilarity: number;
  scoreTagAffinity: number;
  tagOverlapCount: number;
  tags: Set<string>;
  seedWeights: number[];
  matchedTagWeights: Map<string, number>;
  discoveryDepth: number;
  sourceTypes: Set<string>;
  supportingSeeds: Map<string, SupportingSeed>;
}

export type RecommendationAccumulator = Map<string, RecommendationAccumulatorEntry>;

const text = lenient(v.string());
const nullableText = lenient(v.nullable(v.string()));
const count = lenient(v.number());
const strings = lenient(listOf(v.string()));

export const discoveryRecommendationSchema = v.looseObject({
  id: nullableText,
  mbid: nullableText,
  foreignArtistId: nullableText,
  name: v.string(),
  artistName: nullableText,
  navigateTo: nullableText,
  type: text,
  image: nullableText,
  imageUrl: nullableText,
  metaText: nullableText,
  tags: strings,
  matchedTags: strings,
  supportingSeeds: lenient(
    listOf(
      v.looseObject({ artistName: text, source: text, weight: count, profileBucket: nullableText }),
    ),
  ),
  seedCount: count,
  score: count,
  scoreTotal: count,
  scoreSimilarity: count,
  scoreTagAffinity: count,
  scoreSeedCoverage: count,
  scoreNovelty: count,
  scoreDiversityPenalty: count,
  scorePopularityPenalty: count,
  scoreFreshnessBoost: count,
  scoreAgingPenalty: count,
  sourceArtist: nullableText,
  sourceArtists: strings,
  sourceType: text,
  sourceTypes: strings,
  sourceMix: strings,
  discoveryDepth: count,
  bestMatch: count,
  reasonCodes: strings,
  discoveryTier: text,
  confidence: count,
  candidateTagsHydrated: lenient(v.boolean()),
  tagSource: text,
  popularityLabel: nullableText,
  popularityRank: lenient(v.nullable(v.number())),
  listeners: count,
  playcount: count,
  firstDiscoveredAt: nullableText,
  discoveredAt: nullableText,
  lastRecommendedAt: nullableText,
  recommendationPoolState: text,
  recommendationPoolRank: count,
  matchPercent: count,
});

export type DiscoveryRecommendation = v.InferOutput<typeof discoveryRecommendationSchema>;

export interface RecommendationFeedback {
  action?: string | null;
  artistId?: string | null;
  artistName?: string | null;
  tagContext?: string[];
  seedContext?: string[];
  expiresAt?: string | number | null;
}

interface DiscoveryModeMultipliers {
  similarity: number;
  tagAffinity: number;
  seedCoverage: number;
  novelty: number;
  popularityPenalty: number;
  diversityPenalty: number;
}

interface RecommendationPoolMetadata {
  firstDiscoveredAt: string | null;
  lastRecommendedAt: string | null;
}

interface MergedRecommendation extends DiscoveryRecommendation {
  tags: string[];
  matchedTags: string[];
  sourceArtists: string[];
  sourceTypes: string[];
  supportingSeeds: Partial<SupportingSeed>[];
  sourceMix: string[];
  reasonCodes: string[];
}

const SOURCE_BASE_WEIGHTS = {
  library: 1,
  local: 1.25,
  lastfm: 1.2,
  listenbrainz: 1.3,
  koito: 1.3,
  feedback: 1.5,
} satisfies Record<string, number>;

const DISCOVERY_MODE_MULTIPLIERS = {
  safer: {
    similarity: 1.2,
    tagAffinity: 0.9,
    seedCoverage: 1.1,
    novelty: 0.6,
    popularityPenalty: 0.7,
    diversityPenalty: 0.8,
  },
  balanced: {
    similarity: 1,
    tagAffinity: 1,
    seedCoverage: 1,
    novelty: 1,
    popularityPenalty: 1,
    diversityPenalty: 1,
  },
  deeper: {
    similarity: 0.7,
    tagAffinity: 1.15,
    seedCoverage: 0.95,
    novelty: 2,
    popularityPenalty: 1.4,
    diversityPenalty: 1.2,
  },
} satisfies Record<string, DiscoveryModeMultipliers>;

const normalizeText = (value: unknown) =>
  String(value || "")
    .trim()
    .toLowerCase();

const normalizeMbid = (value: unknown) => {
  const normalized = normalizeText(value);
  return UUID_REGEX.test(normalized) ? normalized : null;
};

const buildSeedIdentityKeys = (mbid: string | null, artistName: string) => {
  const keys: string[] = [];
  if (mbid) keys.push(`mbid:${mbid}`);
  const normalizedName = normalizeText(artistName);
  if (normalizedName) keys.push(`name:${normalizedName}`);
  return keys;
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const normalizeDiscoveryMode = (value: unknown): keyof typeof DISCOVERY_MODE_MULTIPLIERS => {
  const mode = normalizeText(value);
  return isOwnKey(DISCOVERY_MODE_MULTIPLIERS, mode) ? mode : "balanced";
};

const sortByValueThenName = (entries: Iterable<[string, number]>) =>
  [...entries].sort((left, right) => {
    if (right[1] !== left[1]) return right[1] - left[1];
    return String(left[0] || "").localeCompare(String(right[0] || ""));
  });

const topKeysFromMap = (map: Map<string, number>, limit = 4) =>
  sortByValueThenName(map.entries())
    .slice(0, limit)
    .map(([key]) => key);

const summarizeSourceArtists = (sourceArtists: Iterable<string>) => {
  const artists = [...sourceArtists].filter(Boolean);
  if (artists.length === 0) return null;
  if (artists.length === 1) return artists[0];
  if (artists.length === 2) return `${artists[0]}, ${artists[1]}`;
  return `${artists[0]}, ${artists[1]} +${artists.length - 2} more`;
};

const mergeTags = (target: Set<string>, sourceTags: string[] = []) => {
  for (const tag of sourceTags) {
    const normalized = normalizeText(tag);
    if (!normalized) continue;
    if (target.size >= 16 && target.has(normalized) === false) continue;
    target.add(normalized);
  }
};

const normalizeTagList = (tags: string[] = []) =>
  (Array.isArray(tags) ? tags : []).map(normalizeText).filter(Boolean);

export const normalizeArtistIdentityKeys = (artist: ArtistIdentity) => {
  const keys: string[] = [];
  const mbids = [artist?.id, artist?.mbid, artist?.foreignArtistId]
    .map(normalizeMbid)
    .filter(Boolean);
  for (const mbid of mbids) {
    keys.push(`mbid:${mbid}`);
  }
  const names = [artist?.name, artist?.artistName].map(normalizeText).filter(Boolean);
  for (const name of names) {
    keys.push(`name:${name}`);
  }
  return [...new Set(keys)];
};

export const buildExistingArtistKeySet = (artists: ArtistIdentity[] = []) => {
  const keys = new Set<string>();
  for (const artist of Array.isArray(artists) ? artists : []) {
    for (const key of normalizeArtistIdentityKeys(artist)) {
      keys.add(key);
    }
  }
  return keys;
};

export const applyHydratedCandidateTags = (
  recommendation: DiscoveryRecommendation,
  candidateTags: string[] = [],
  profileTagWeights: Map<string, number> = new Map(),
  options: { source?: string; tagAffinityMultiplier?: number } = {},
) => {
  const normalizedTags = normalizeTagList(candidateTags);
  if (!recommendation || normalizedTags.length === 0) return recommendation;

  if (!(profileTagWeights instanceof Map) || profileTagWeights.size === 0) {
    return {
      ...recommendation,
      tags: normalizedTags,
      candidateTagsHydrated: true,
      tagSource: options.source || "lastfm_artist",
    };
  }

  const matchedTagWeights = new Map<string, number>();
  for (const tag of normalizedTags) {
    if (!profileTagWeights.has(tag)) continue;
    matchedTagWeights.set(tag, Number(profileTagWeights.get(tag) || 0));
  }
  const matchedTags = topKeysFromMap(matchedTagWeights, 4);
  const tagWeightSum = matchedTags.reduce(
    (sum, tag) => sum + Number(profileTagWeights.get(tag) || 0),
    0,
  );
  const tagAffinityMultiplier = clamp(
    Number(
      options.tagAffinityMultiplier ?? (Number(recommendation.discoveryDepth || 1) >= 2 ? 0.55 : 1),
    ),
    0,
    1,
  );
  const scoreTagAffinity =
    Math.min(45, tagWeightSum * 6 + matchedTags.length * 3) * tagAffinityMultiplier;
  const previousScoreTagAffinity = Number(recommendation.scoreTagAffinity || 0);
  const previousTotal = Number(recommendation.scoreTotal || recommendation.score || 0);
  const scoreTotal = Math.round(previousTotal - previousScoreTagAffinity + scoreTagAffinity);

  return {
    ...recommendation,
    tags: normalizedTags,
    matchedTags,
    scoreTagAffinity: Math.round(scoreTagAffinity),
    scoreTotal,
    score: scoreTotal,
    candidateTagsHydrated: true,
    tagSource: options.source || "lastfm_artist",
  };
};

const calculateSeedWeight = (
  seed: { source?: string; playcount?: number | null },
  index: number,
) => {
  const source = normalizeText(seed?.source) || "library";
  const baseWeight = (isOwnKey(SOURCE_BASE_WEIGHTS, source) ? SOURCE_BASE_WEIGHTS[source] : 0) || 1;

  if (source === "library") {
    const recencyBoost = Math.max(0, 0.5 - Math.max(index, 0) * 0.02);
    return Number((baseWeight + recencyBoost).toFixed(4));
  }

  const playcount = Math.max(0, Number(seed?.playcount || 0));
  const playcountBoost = playcount > 0 ? Math.min(1.4, Math.log10(playcount + 1) * 0.4) : 0.15;
  return Number((baseWeight + playcountBoost).toFixed(4));
};

export const buildDiscoverySeedList = ({
  libraryArtists = [],
  historyArtists = [],
}: { libraryArtists?: SeedArtistInput[]; historyArtists?: SeedArtistInput[] } = {}) => {
  const combined = [
    ...(Array.isArray(historyArtists) ? historyArtists : []),
    ...(Array.isArray(libraryArtists) ? libraryArtists : []),
  ];
  const seedsByKey = new Map<string, DiscoverySeed>();
  const seeds: DiscoverySeed[] = [];

  for (let index = 0; index < combined.length; index += 1) {
    const artist = combined[index];
    const mbid = normalizeMbid(artist?.mbid || artist?.id || artist?.foreignArtistId);
    const artistName = String(artist?.artistName || artist?.name || "").trim();
    if (!artistName) continue;

    const identityKeys = buildSeedIdentityKeys(mbid, artistName);
    const source = normalizeText(artist?.source) || "library";
    const nextWeight = calculateSeedWeight(
      {
        source,
        playcount: artist?.playcount,
      },
      source === "library" ? index : 0,
    );
    const profileBucket = normalizeText(artist?.profileBucket) || null;

    const existing = identityKeys.map((key) => seedsByKey.get(key)).find(Boolean);
    if (existing) {
      existing.weight = Math.max(existing.weight, nextWeight);
      existing.playcount = Math.max(
        Number(existing.playcount || 0),
        Number(artist?.playcount || 0),
      );
      existing.affinityWeight = Math.max(
        Number(existing.affinityWeight || 0),
        Number(artist?.affinityWeight || 0),
      );
      if (existing.source === "library" && source !== "library") {
        existing.source = source;
      }
      if (!existing.profileBucket && profileBucket) {
        existing.profileBucket = profileBucket;
      }
      for (const key of identityKeys) {
        if (!existing.identityKeys.includes(key)) {
          existing.identityKeys.push(key);
        }
        seedsByKey.set(key, existing);
      }
      if (!existing.mbid && mbid) {
        existing.mbid = mbid;
      }
      continue;
    }

    const seed: DiscoverySeed = {
      mbid,
      artistName,
      source,
      identityKeys,
      playcount: Math.max(0, Number(artist?.playcount || 0)),
      weight: nextWeight,
      affinityWeight: Math.max(nextWeight, Number(artist?.affinityWeight || 0) || nextWeight),
      profileBucket,
    };
    identityKeys.forEach((key) => seedsByKey.set(key, seed));
    seeds.push(seed);
  }

  return seeds.sort((left, right) => {
    if (right.affinityWeight !== left.affinityWeight) {
      return right.affinityWeight - left.affinityWeight;
    }
    if (right.weight !== left.weight) {
      return right.weight - left.weight;
    }
    if (right.playcount !== left.playcount) {
      return right.playcount - left.playcount;
    }
    return left.artistName.localeCompare(right.artistName);
  });
};

const LIKED_SEED_SHARE = 0.2;
const HISTORY_SEED_SHARE = 0.6;
const LIKED_SEED_AFFINITY = 2.4;

export const selectDiscoverySeeds = ({
  likedArtists = [],
  historyArtists = [],
  libraryArtists = [],
  limit = 50,
  excludedKeys = new Set(),
}: {
  likedArtists?: SeedArtistInput[];
  historyArtists?: SeedArtistInput[];
  libraryArtists?: SeedArtistInput[];
  limit?: number;
  excludedKeys?: Set<string>;
} = {}) => {
  const isAllowed = (artist: SeedArtistInput) =>
    !normalizeArtistIdentityKeys(artist).some((key) => excludedKeys.has(key));
  const liked = likedArtists.filter(isAllowed);
  const history = historyArtists.filter(isAllowed);
  const library = libraryArtists.filter(isAllowed);

  const likedCount = Math.min(liked.length, Math.max(1, Math.round(limit * LIKED_SEED_SHARE)));
  const remaining = Math.max(0, limit - likedCount);
  const historyTarget = library.length > 0 ? Math.ceil(remaining * HISTORY_SEED_SHARE) : remaining;
  const libraryCount = Math.min(
    library.length,
    remaining - Math.min(history.length, historyTarget),
  );
  const historyCount = Math.min(history.length, remaining - libraryCount);

  return buildDiscoverySeedList({
    historyArtists: [
      ...liked.slice(0, likedCount).map((artist) => ({
        ...artist,
        source: "feedback",
        profileBucket: "liked",
        affinityWeight: LIKED_SEED_AFFINITY,
      })),
      ...history.slice(0, historyCount),
    ],
    libraryArtists: library.slice(0, libraryCount),
  }).slice(0, limit);
};

const buildReasonCodes = ({
  tagOverlapCount,
  seedCoverage,
  sourceTypes,
  scoreNovelty,
  scorePopularityPenalty,
  discoveryMode,
  discoveryDepth,
}: {
  tagOverlapCount: number;
  seedCoverage: number;
  sourceTypes: string[];
  scoreNovelty: number;
  scorePopularityPenalty: number;
  discoveryMode: string;
  discoveryDepth: number;
}) => {
  const codes: string[] = [];
  if (tagOverlapCount >= 2) codes.push("tag_affinity_strong");
  else if (tagOverlapCount >= 1) codes.push("tag_affinity");
  if (seedCoverage >= 3) codes.push("multi_seed");
  else if (seedCoverage >= 2) codes.push("seed_consensus");
  if (discoveryDepth >= 2) codes.push("two_hop");
  if ((sourceTypes || []).some((entry) => entry !== "library")) {
    codes.push("history_aligned");
  }
  if (scoreNovelty >= 18) codes.push("deeper_pick");
  if (scorePopularityPenalty >= 8) codes.push("mainstream_overlap");
  if (discoveryMode === "deeper") codes.push("mode_deeper");
  if (discoveryMode === "safer") codes.push("mode_safer");
  return [...new Set(codes)];
};

export const addRecommendationCandidate = (
  accumulator: RecommendationAccumulator,
  {
    candidate,
    seed,
    sourceTags = [],
    profileTagWeights = new Map(),
    existingArtistKeys = new Set(),
  }: {
    candidate?: RecommendationCandidate;
    seed?: RecommendationSeed;
    sourceTags?: string[];
    profileTagWeights?: Map<string, number>;
    existingArtistKeys?: Set<string>;
  } = {},
) => {
  if (!accumulator || !candidate || !seed) return;

  const name = String(candidate?.name || "").trim();
  const mbid = normalizeMbid(candidate?.mbid);
  if (!name && !mbid) return;

  const candidateKeys = normalizeArtistIdentityKeys({
    id: mbid,
    name,
  });
  if (candidateKeys.some((key) => existingArtistKeys.has(key))) return;

  const candidateKey = mbid || `name:${normalizeText(name)}`;
  if (!candidateKey) return;

  const seedWeight = Number(seed?.weight || 1);
  const affinityWeight = Math.max(seedWeight, Number(seed?.affinityWeight || 0));
  const matchScore = clamp(Number(candidate?.match || 0), 0, 1);
  const similarityMultiplier = clamp(
    Number(candidate?.similarityMultiplier ?? seed?.similarityMultiplier ?? 1),
    0,
    1,
  );
  const tagAffinityMultiplier = clamp(
    Number(candidate?.tagAffinityMultiplier ?? seed?.tagAffinityMultiplier ?? 1),
    0,
    1,
  );
  const discoveryDepth = Math.max(
    1,
    Math.round(Number(candidate?.discoveryDepth ?? seed?.discoveryDepth ?? 1) || 1),
  );
  const normalizedTags = (Array.isArray(sourceTags) ? sourceTags : [])
    .map(normalizeText)
    .filter(Boolean);
  const matchedTags = normalizedTags.filter((tag) => profileTagWeights.has(tag));
  const tagWeightSum = matchedTags.reduce(
    (sum, tag) => sum + Number(profileTagWeights.get(tag) || 0),
    0,
  );
  const scoreSimilarity = Math.max(0, matchScore * 100 * seedWeight * similarityMultiplier);
  const scoreTagAffinity =
    Math.min(45, tagWeightSum * 6 + matchedTags.length * 3) * tagAffinityMultiplier;
  const perSeedContribution = scoreSimilarity + scoreTagAffinity + affinityWeight * 4;

  const existing = accumulator.get(candidateKey);
  if (existing) {
    existing.scoreSimilarity += scoreSimilarity;
    existing.scoreTagAffinity += scoreTagAffinity;
    existing.rawContribution += perSeedContribution;
    existing.bestMatch = Math.max(existing.bestMatch, matchScore);
    existing.tagOverlapCount += matchedTags.length;
    existing.seedWeights.push(seedWeight);
    existing.supportingSeeds.set(seed.artistName, {
      artistName: seed.artistName,
      source: seed.source || "library",
      weight: seedWeight,
      profileBucket: seed.profileBucket || null,
    });
    existing.sourceTypes.add(seed.source || "library");
    matchedTags.forEach((tag) => {
      existing.matchedTagWeights.set(
        tag,
        Math.max(
          Number(existing.matchedTagWeights.get(tag) || 0),
          Number(profileTagWeights.get(tag) || 0),
        ),
      );
    });
    if (!existing.image && candidate?.image) {
      existing.image = candidate.image;
    }
    mergeTags(existing.tags, normalizedTags);
    if (mbid && !existing.id) {
      existing.id = mbid;
    }
    existing.discoveryDepth = Math.min(
      Number(existing.discoveryDepth || discoveryDepth),
      discoveryDepth,
    );
    return;
  }

  const tags = new Set<string>();
  mergeTags(tags, normalizedTags);
  const matchedTagWeights = new Map<string, number>();
  matchedTags.forEach((tag) => {
    matchedTagWeights.set(tag, Number(profileTagWeights.get(tag) || 0));
  });
  accumulator.set(candidateKey, {
    id: mbid,
    name,
    type: "Artist",
    image: candidate?.image || null,
    bestMatch: matchScore,
    rawContribution: perSeedContribution,
    scoreSimilarity,
    scoreTagAffinity,
    tagOverlapCount: matchedTags.length,
    tags,
    seedWeights: [seedWeight],
    matchedTagWeights,
    discoveryDepth,
    sourceTypes: new Set([seed.source || "library"]),
    supportingSeeds: new Map([
      [
        seed.artistName,
        {
          artistName: seed.artistName,
          source: seed.source || "library",
          weight: seedWeight,
          profileBucket: seed.profileBucket || null,
        },
      ],
    ]),
  });
};

const finalizeRecommendationEntry = (
  entry: RecommendationAccumulatorEntry,
  discoveryMode = "balanced",
) => {
  const supportCount = entry.supportingSeeds.size;
  const matchedTags = topKeysFromMap(entry.matchedTagWeights, 4);
  const averageSeedWeight =
    entry.seedWeights.length > 0
      ? entry.seedWeights.reduce((sum, value) => sum + value, 0) / entry.seedWeights.length
      : 0;
  const scoreSeedCoverage = Math.min(
    28,
    Math.max(0, (supportCount - 1) * 8 + averageSeedWeight * 4),
  );
  const scoreNovelty = clamp(
    28 - supportCount * 3 - entry.bestMatch * 10 + matchedTags.length * 2,
    0,
    30,
  );
  const scorePopularityPenalty = clamp(
    supportCount * 2 + entry.bestMatch * 8 - scoreNovelty * 0.15,
    0,
    18,
  );
  const scoreDiversityPenalty = 0;
  const reasonCodes = buildReasonCodes({
    tagOverlapCount: entry.tagOverlapCount,
    seedCoverage: supportCount,
    sourceTypes: [...entry.sourceTypes],
    scoreNovelty,
    scorePopularityPenalty,
    discoveryMode,
    discoveryDepth: Number(entry.discoveryDepth || 1),
  });
  const confidence = clamp(
    Math.round(
      35 +
        Math.min(25, entry.bestMatch * 28) +
        Math.min(18, supportCount * 5) +
        Math.min(12, matchedTags.length * 3),
    ),
    20,
    98,
  );
  const discoveryTier =
    scoreNovelty >= 18 ? "deeper" : entry.bestMatch >= 0.72 ? "safer" : "balanced";

  const baseTotal =
    entry.scoreSimilarity +
    entry.scoreTagAffinity +
    scoreSeedCoverage +
    scoreNovelty -
    scorePopularityPenalty;

  return {
    id: entry.id || null,
    name: entry.name,
    type: "Artist",
    image: entry.image || null,
    tags: [...entry.tags],
    matchedTags,
    supportingSeeds: [...entry.supportingSeeds.values()]
      .sort((left, right) => right.weight - left.weight)
      .slice(0, 4),
    seedCount: supportCount,
    score: Math.round(baseTotal),
    scoreTotal: Math.round(baseTotal),
    scoreSimilarity: Math.round(entry.scoreSimilarity),
    scoreTagAffinity: Math.round(entry.scoreTagAffinity),
    scoreSeedCoverage: Math.round(scoreSeedCoverage),
    scoreNovelty: Math.round(scoreNovelty),
    scoreDiversityPenalty,
    scorePopularityPenalty: Math.round(scorePopularityPenalty),
    sourceArtist: summarizeSourceArtists(entry.supportingSeeds.keys()),
    sourceArtists: [...entry.supportingSeeds.keys()],
    sourceType: entry.sourceTypes.size === 1 ? [...entry.sourceTypes][0] : "blended",
    sourceTypes: [...entry.sourceTypes],
    sourceMix: [...entry.sourceTypes],
    discoveryDepth: Number(entry.discoveryDepth || 1),
    bestMatch: entry.bestMatch,
    reasonCodes,
    discoveryTier,
    confidence,
  };
};

export const finalizeRecommendationAccumulator = (
  accumulator: RecommendationAccumulator,
  limit = 100,
  options: { discoveryMode?: string } = {},
) => {
  const discoveryMode = normalizeDiscoveryMode(options?.discoveryMode);
  return [...accumulator.values()]
    .map((entry) => finalizeRecommendationEntry(entry, discoveryMode))
    .filter((entry) => entry.name)
    .sort((left, right) => {
      if (right.scoreTotal !== left.scoreTotal) {
        return right.scoreTotal - left.scoreTotal;
      }
      if (right.seedCount !== left.seedCount) {
        return right.seedCount - left.seedCount;
      }
      if (right.bestMatch !== left.bestMatch) {
        return right.bestMatch - left.bestMatch;
      }
      return left.name.localeCompare(right.name);
    })
    .slice(0, Math.max(1, Number(limit) || 100));
};

const FEEDBACK_ACTIONS = new Set<string | null | undefined>([
  "more_like_this",
  "less_like_this",
  "block_artist",
]);

const isActiveFeedback = (entry: RecommendationFeedback, now: number) => {
  if (!entry || typeof entry !== "object" || !FEEDBACK_ACTIONS.has(entry.action)) return false;
  if (!entry.expiresAt) return true;
  const time = new Date(entry.expiresAt).getTime();
  return Number.isFinite(time) ? time > now : true;
};

const buildFeedbackSignals = (feedbackList: RecommendationFeedback[] = []) => {
  const now = Date.now();
  return (Array.isArray(feedbackList) ? feedbackList : [])
    .filter((entry) => isActiveFeedback(entry, now))
    .map((entry) => ({
      action: entry.action,
      keys: normalizeArtistIdentityKeys({
        id: entry.artistId,
        mbid: entry.artistId,
        name: entry.artistName,
      }),
      tags: new Set(normalizeTagList(entry.tagContext)),
      seeds: new Set(normalizeTagList(entry.seedContext)),
    }));
};

const countMatches = (values: string[], lookup: Set<string>) => {
  let count = 0;
  for (const value of values) {
    if (lookup.has(value)) count += 1;
  }
  return count;
};

const feedbackAdjustmentForCandidate = (
  candidate: RerankEntry,
  signals: ReturnType<typeof buildFeedbackSignals>,
) => {
  if (signals.length === 0) return { adjustment: 0, hidden: false };
  const candidateKeys = new Set(normalizeArtistIdentityKeys(candidate));
  const candidateTags = [...new Set(normalizeTagList(candidate.matchedTags))];
  const candidateSeeds = (candidate.supportingSeeds || [])
    .map((seed) => normalizeText(seed?.artistName))
    .filter(Boolean);
  let adjustment = 0;

  for (const signal of signals) {
    const exactMatch = signal.keys.some((key) => candidateKeys.has(key));
    if (signal.action === "block_artist") {
      if (exactMatch) return { adjustment: adjustment - 100000, hidden: true };
      continue;
    }
    const direction = signal.action === "more_like_this" ? 1 : -1;
    if (exactMatch) {
      adjustment += 16 * direction;
      continue;
    }
    const tagOverlap = countMatches(candidateTags, signal.tags);
    if (tagOverlap > 0 || countMatches(candidateSeeds, signal.seeds) > 0) {
      adjustment += (10 + tagOverlap * 2) * direction;
    }
  }

  return { adjustment, hidden: false };
};

const normalizeRerankEntry = (entry: DiscoveryRecommendation, mode: string) => ({
  ...entry,
  matchedTags: Array.isArray(entry?.matchedTags)
    ? [...entry.matchedTags]
    : Array.isArray(entry?.tags)
      ? [...entry.tags].slice(0, 4)
      : [],
  supportingSeeds: Array.isArray(entry?.supportingSeeds)
    ? [...entry.supportingSeeds]
    : Array.isArray(entry?.sourceArtists)
      ? entry.sourceArtists.map((artistName) => ({
          artistName,
          source: entry?.sourceType || "library",
          weight: 1,
        }))
      : [],
  sourceTypes: Array.isArray(entry?.sourceTypes)
    ? [...entry.sourceTypes]
    : entry?.sourceType
      ? [entry.sourceType]
      : [],
  sourceMix: Array.isArray(entry?.sourceMix)
    ? [...entry.sourceMix]
    : Array.isArray(entry?.sourceTypes)
      ? [...entry.sourceTypes]
      : entry?.sourceType
        ? [entry.sourceType]
        : [],
  reasonCodes: Array.isArray(entry?.reasonCodes) ? [...entry.reasonCodes] : [],
  discoveryTier: entry?.discoveryTier || mode,
  discoveryDepth: Number(entry?.discoveryDepth || 1) || 1,
  confidence: Number(entry?.confidence || 0) || 0,
});

type RerankEntry = ReturnType<typeof normalizeRerankEntry>;

const compareByStoredScore = (left: RerankEntry, right: RerankEntry) => {
  const leftScore = Number(left.scoreTotal || left.score || 0);
  const rightScore = Number(right.scoreTotal || right.score || 0);
  if (rightScore !== leftScore) return rightScore - leftScore;
  if ((right.seedCount || 0) !== (left.seedCount || 0)) {
    return (right.seedCount || 0) - (left.seedCount || 0);
  }
  return String(left.name || "").localeCompare(String(right.name || ""));
};

export const rerankRecommendations = (
  recommendations: DiscoveryRecommendation[] = [],
  limit = 100,
  options: { discoveryMode?: string; feedback?: RecommendationFeedback[] } = {},
) => {
  const mode = normalizeDiscoveryMode(options.discoveryMode);
  const multipliers = DISCOVERY_MODE_MULTIPLIERS[mode];
  const feedbackSignals = buildFeedbackSignals(options.feedback);
  const pool = [];

  for (const recommendation of Array.isArray(recommendations) ? recommendations : []) {
    const entry = normalizeRerankEntry(recommendation, mode);
    const { adjustment, hidden } = feedbackAdjustmentForCandidate(entry, feedbackSignals);
    if (hidden) continue;
    pool.push({
      entry,
      feedbackAdjustment: adjustment,
      baseScore:
        Number(entry.scoreSimilarity || 0) * multipliers.similarity +
        Number(entry.scoreTagAffinity || 0) * multipliers.tagAffinity +
        Number(entry.scoreSeedCoverage || 0) * multipliers.seedCoverage +
        Number(entry.scoreNovelty || 0) * multipliers.novelty -
        Number(entry.scorePopularityPenalty || 0) * multipliers.popularityPenalty +
        Number(entry.scoreFreshnessBoost || 0) -
        Number(entry.scoreAgingPenalty || 0),
      tags: [...new Set(normalizeTagList(entry.matchedTags))],
      seeds: [
        ...new Set(
          entry.supportingSeeds.map((seed) => normalizeText(seed?.artistName)).filter(Boolean),
        ),
      ],
    });
  }
  pool.sort((left, right) => compareByStoredScore(left.entry, right.entry));

  const maxSelected = Math.max(1, Number(limit) || 100);
  const selectedTagCounts = new Map<string, number>();
  const selectedSeedCounts = new Map<string, number>();
  const diversityPenaltyFor = (candidate: { tags: string[]; seeds: string[] }) => {
    let penalty = 0;
    for (const tag of candidate.tags) penalty += (selectedTagCounts.get(tag) || 0) * 1.8;
    for (const seed of candidate.seeds) penalty += (selectedSeedCounts.get(seed) || 0) * 2.6;
    return penalty;
  };
  const selected = [];

  while (pool.length > 0 && selected.length < maxSelected) {
    let bestIndex = -1;
    let bestScore = 0;
    let bestPenalty = 0;
    for (let index = 0; index < pool.length; index += 1) {
      const candidate = pool[index];
      const penalty = diversityPenaltyFor(candidate);
      const score = Math.round(
        candidate.baseScore - penalty * multipliers.diversityPenalty + candidate.feedbackAdjustment,
      );
      if (bestIndex === -1 || score > bestScore) {
        bestIndex = index;
        bestScore = score;
        bestPenalty = penalty;
      }
    }

    const [best] = pool.splice(bestIndex, 1);
    for (const tag of best.tags) selectedTagCounts.set(tag, (selectedTagCounts.get(tag) || 0) + 1);
    for (const seed of best.seeds)
      selectedSeedCounts.set(seed, (selectedSeedCounts.get(seed) || 0) + 1);
    selected.push({
      ...best.entry,
      scoreDiversityPenalty: Math.round(bestPenalty),
      scoreTotal: bestScore,
      score: bestScore,
    });
  }

  return selected;
};

export const withArtistRouteId = (recommendation: DiscoveryRecommendation) => {
  const mbid = normalizeMbid(recommendation?.id) || normalizeMbid(recommendation?.navigateTo);
  return recommendation?.id === mbid && recommendation?.navigateTo === mbid
    ? recommendation
    : { ...recommendation, id: mbid, navigateTo: mbid };
};

const TOP_MATCH_PERCENT = 99;
const LOWEST_MATCH_PERCENT = 55;

const matchPercentForRank = (index: number, count: number) =>
  count <= 1
    ? TOP_MATCH_PERCENT
    : Math.round(
        TOP_MATCH_PERCENT - ((TOP_MATCH_PERCENT - LOWEST_MATCH_PERCENT) * index) / (count - 1),
      );

export const serveRecommendations = (
  recommendations: DiscoveryRecommendation[] = [],
  {
    feedback = [],
    discoveryMode,
  }: { feedback?: RecommendationFeedback[]; discoveryMode?: string } = {},
) => {
  const ranked = rerankRecommendations(recommendations, recommendations.length, {
    feedback,
    discoveryMode,
  });
  return ranked.map((recommendation, index) => ({
    ...withArtistRouteId(recommendation),
    matchPercent: matchPercentForRank(index, ranked.length),
  }));
};

const DAY_MS = 24 * 60 * 60 * 1000;

const parseTimeMs = (value: string | null | undefined, fallback = Date.now()) => {
  const time = new Date(value || "").getTime();
  return Number.isFinite(time) ? time : fallback;
};

const getRecommendationPoolKeys = (recommendation: DiscoveryRecommendation) => {
  const keys = normalizeArtistIdentityKeys(recommendation);
  if (keys.length > 0) return keys;
  const name = normalizeText(recommendation?.name);
  return name ? [`name:${name}`] : [];
};

const buildRecommendationPoolMetadataMap = (recommendations: DiscoveryRecommendation[] = []) => {
  const metadata = new Map<string, RecommendationPoolMetadata>();
  for (const recommendation of Array.isArray(recommendations) ? recommendations : []) {
    const keys = getRecommendationPoolKeys(recommendation);
    if (keys.length === 0) continue;
    const entry: RecommendationPoolMetadata = {
      firstDiscoveredAt:
        recommendation.firstDiscoveredAt ||
        recommendation.discoveredAt ||
        recommendation.lastRecommendedAt ||
        null,
      lastRecommendedAt:
        recommendation.lastRecommendedAt ||
        recommendation.discoveredAt ||
        recommendation.firstDiscoveredAt ||
        null,
    };
    for (const key of keys) {
      metadata.set(key, entry);
    }
  }
  return metadata;
};

const findRecommendationPoolMetadata = (
  recommendation: DiscoveryRecommendation,
  metadataMap: Map<string, RecommendationPoolMetadata>,
) => {
  for (const key of getRecommendationPoolKeys(recommendation)) {
    const metadata = metadataMap.get(key);
    if (metadata) return metadata;
  }
  return null;
};

const applyRecommendationPoolMetadata = (
  recommendation: DiscoveryRecommendation,
  {
    fresh = false,
    index = 0,
    metadata = null,
    runStartedAt,
    runStartedMs,
  }: {
    fresh?: boolean;
    index?: number;
    metadata?: RecommendationPoolMetadata | null;
    runStartedAt: string;
    runStartedMs: number;
  },
) => {
  const firstDiscoveredAt =
    metadata?.firstDiscoveredAt ||
    recommendation.firstDiscoveredAt ||
    recommendation.discoveredAt ||
    runStartedAt;
  const firstDiscoveredMs = parseTimeMs(firstDiscoveredAt, runStartedMs);
  const ageDays = Math.max(0, (runStartedMs - firstDiscoveredMs) / DAY_MS);
  const agingPenalty = fresh ? 0 : Math.min(80, Math.round(ageDays * 0.45));
  const freshnessBoost = fresh ? Math.max(8, 18 - index * 0.04) : 0;

  return {
    ...recommendation,
    firstDiscoveredAt,
    discoveredAt: recommendation.discoveredAt || firstDiscoveredAt,
    lastRecommendedAt: fresh
      ? runStartedAt
      : metadata?.lastRecommendedAt || recommendation.lastRecommendedAt || firstDiscoveredAt,
    recommendationPoolState: fresh ? "fresh" : "retained",
    scoreFreshnessBoost: Number(freshnessBoost.toFixed(2)),
    scoreAgingPenalty: Number(agingPenalty.toFixed(2)),
  };
};

export const mergeRetainedRecommendationPool = ({
  freshRecommendations = [],
  existingRecommendations = [],
  existingArtistKeys = new Set(),
  limit = 500,
  runStartedAt = new Date().toISOString(),
  discoveryMode = "balanced",
  feedback = [],
}: {
  freshRecommendations?: DiscoveryRecommendation[];
  existingRecommendations?: DiscoveryRecommendation[];
  existingArtistKeys?: Set<string>;
  limit?: number;
  runStartedAt?: string;
  discoveryMode?: string;
  feedback?: RecommendationFeedback[];
} = {}) => {
  const normalizedLimit = Math.max(1, Number(limit) || 500);
  const runStartedMs = parseTimeMs(runStartedAt);
  const existingMetadata = buildRecommendationPoolMetadataMap(existingRecommendations);
  const fresh = (Array.isArray(freshRecommendations) ? freshRecommendations : []).map(
    (recommendation, index) =>
      applyRecommendationPoolMetadata(recommendation, {
        fresh: true,
        index,
        metadata: findRecommendationPoolMetadata(recommendation, existingMetadata),
        runStartedAt,
        runStartedMs,
      }),
  );
  const retained = (Array.isArray(existingRecommendations) ? existingRecommendations : []).map(
    (recommendation, index) =>
      applyRecommendationPoolMetadata(recommendation, {
        fresh: false,
        index,
        runStartedAt,
        runStartedMs,
      }),
  );
  const merged = mergeResolvedRecommendations([...fresh, ...retained], existingArtistKeys);

  return rerankRecommendations(merged, normalizedLimit, {
    discoveryMode,
    feedback,
  }).map((recommendation, index) => ({
    ...recommendation,
    recommendationPoolRank: index + 1,
  }));
};

export const mergeResolvedRecommendations = (
  recommendations: DiscoveryRecommendation[] = [],
  existingArtistKeys: Set<string> = new Set(),
) => {
  const merged = new Map<string | null, MergedRecommendation>();
  const aliases = new Map<string | null, string | null>();

  for (const recommendation of Array.isArray(recommendations) ? recommendations : []) {
    const keys = normalizeArtistIdentityKeys(recommendation);
    if (keys.some((key) => existingArtistKeys.has(key))) continue;
    const recommendationMbid =
      normalizeMbid(recommendation?.id) || normalizeMbid(recommendation?.navigateTo);

    const identityKeys = [recommendationMbid, `name:${normalizeText(recommendation?.name)}`].filter(
      Boolean,
    );
    if (identityKeys.length === 0) continue;
    const existingIdentity = identityKeys.find((key) => aliases.has(key));
    const identity = existingIdentity || identityKeys[0];

    const existing = merged.get(identity);
    if (!existing) {
      const entry = {
        ...recommendation,
        id: recommendationMbid,
        navigateTo: recommendationMbid,
        tags: Array.isArray(recommendation?.tags) ? [...recommendation.tags] : [],
        matchedTags: Array.isArray(recommendation?.matchedTags)
          ? [...recommendation.matchedTags]
          : [],
        sourceArtists: Array.isArray(recommendation?.sourceArtists)
          ? [...recommendation.sourceArtists]
          : [],
        sourceTypes: Array.isArray(recommendation?.sourceTypes)
          ? [...recommendation.sourceTypes]
          : recommendation?.sourceType
            ? [recommendation.sourceType]
            : [],
        supportingSeeds: Array.isArray(recommendation?.supportingSeeds)
          ? [...recommendation.supportingSeeds]
          : [],
        sourceMix: Array.isArray(recommendation?.sourceMix) ? [...recommendation.sourceMix] : [],
        reasonCodes: Array.isArray(recommendation?.reasonCodes)
          ? [...recommendation.reasonCodes]
          : [],
        popularityLabel: recommendation?.popularityLabel || null,
        popularityRank: recommendation?.popularityRank || null,
        listeners: Number(recommendation?.listeners || 0) || 0,
        playcount: Number(recommendation?.playcount || 0) || 0,
        discoveryDepth: Number(recommendation?.discoveryDepth || 1) || 1,
      };
      merged.set(identity, entry);
      for (const key of identityKeys) {
        aliases.set(key, identity);
      }
      continue;
    }

    existing.id = existing.id || recommendationMbid;
    existing.navigateTo = existing.navigateTo || recommendationMbid;
    existing.image = existing.image || recommendation.image || null;
    existing.popularityLabel = existing.popularityLabel || recommendation.popularityLabel || null;
    existing.popularityRank = existing.popularityRank || recommendation.popularityRank || null;
    existing.listeners = Math.max(
      Number(existing.listeners || 0),
      Number(recommendation.listeners || 0),
    );
    existing.playcount = Math.max(
      Number(existing.playcount || 0),
      Number(recommendation.playcount || 0),
    );
    existing.score = Math.max(Number(existing.score || 0), Number(recommendation.score || 0));
    existing.scoreTotal = Math.max(
      Number(existing.scoreTotal || 0),
      Number(recommendation.scoreTotal || recommendation.score || 0),
    );
    existing.scoreSimilarity = Math.max(
      Number(existing.scoreSimilarity || 0),
      Number(recommendation.scoreSimilarity || 0),
    );
    existing.scoreTagAffinity = Math.max(
      Number(existing.scoreTagAffinity || 0),
      Number(recommendation.scoreTagAffinity || 0),
    );
    existing.scoreSeedCoverage = Math.max(
      Number(existing.scoreSeedCoverage || 0),
      Number(recommendation.scoreSeedCoverage || 0),
    );
    existing.scoreNovelty = Math.max(
      Number(existing.scoreNovelty || 0),
      Number(recommendation.scoreNovelty || 0),
    );
    existing.scorePopularityPenalty = Math.max(
      Number(existing.scorePopularityPenalty || 0),
      Number(recommendation.scorePopularityPenalty || 0),
    );
    existing.seedCount = Math.max(
      Number(existing.seedCount || 0),
      Number(recommendation.seedCount || 0),
    );
    existing.confidence = Math.max(
      Number(existing.confidence || 0),
      Number(recommendation.confidence || 0),
    );
    existing.discoveryTier = existing.discoveryTier || recommendation.discoveryTier || "balanced";
    existing.discoveryDepth = Math.min(
      Number(existing.discoveryDepth || recommendation.discoveryDepth || 1) || 1,
      Number(recommendation.discoveryDepth || 1) || 1,
    );
    existing.sourceArtists = [
      ...new Set([
        ...existing.sourceArtists,
        ...(Array.isArray(recommendation?.sourceArtists)
          ? recommendation.sourceArtists
          : recommendation?.sourceArtist
            ? [recommendation.sourceArtist]
            : []),
      ]),
    ];
    existing.sourceTypes = [
      ...new Set([
        ...existing.sourceTypes,
        ...(Array.isArray(recommendation?.sourceTypes)
          ? recommendation.sourceTypes
          : recommendation?.sourceType
            ? [recommendation.sourceType]
            : []),
      ]),
    ];
    existing.sourceMix = [
      ...new Set([
        ...(existing.sourceMix || []),
        ...(Array.isArray(recommendation?.sourceMix) ? recommendation.sourceMix : []),
      ]),
    ];
    existing.reasonCodes = [
      ...new Set([
        ...(existing.reasonCodes || []),
        ...(Array.isArray(recommendation?.reasonCodes) ? recommendation.reasonCodes : []),
      ]),
    ];
    existing.tags = [
      ...new Set([
        ...existing.tags,
        ...(Array.isArray(recommendation?.tags) ? recommendation.tags : []),
      ]),
    ];
    existing.matchedTags = [
      ...new Set([
        ...(existing.matchedTags || []),
        ...(Array.isArray(recommendation?.matchedTags) ? recommendation.matchedTags : []),
      ]),
    ];
    existing.supportingSeeds = [
      ...new Map(
        [...(existing.supportingSeeds || []), ...(recommendation.supportingSeeds || [])]
          .filter((seed) => seed?.artistName)
          .map((seed) => [normalizeText(seed.artistName), seed]),
      ).values(),
    ];
    for (const key of identityKeys) {
      aliases.set(key, identity);
    }
  }

  return [...merged.values()].map((entry) => ({
    ...entry,
    sourceArtist: summarizeSourceArtists(entry.sourceArtists || []),
    sourceType:
      Array.isArray(entry.sourceTypes) && entry.sourceTypes.length === 1
        ? entry.sourceTypes[0]
        : "blended",
    sourceMix:
      Array.isArray(entry.sourceMix) && entry.sourceMix.length > 0
        ? entry.sourceMix
        : Array.isArray(entry.sourceTypes)
          ? entry.sourceTypes
          : [],
    matchedTags:
      Array.isArray(entry.matchedTags) && entry.matchedTags.length > 0
        ? entry.matchedTags.slice(0, 4)
        : Array.isArray(entry.tags)
          ? entry.tags.slice(0, 4)
          : [],
    supportingSeeds: Array.isArray(entry.supportingSeeds)
      ? entry.supportingSeeds
          .sort((left, right) => Number(right.weight || 0) - Number(left.weight || 0))
          .slice(0, 4)
      : [],
  }));
};

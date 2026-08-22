import { UUID_REGEX } from "../../../lib/uuid.js";

const SOURCE_BASE_WEIGHTS = {
  library: 1,
  lastfm: 1.2,
  listenbrainz: 1.3,
  koito: 1.3,
};

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
};

const normalizeText = (value) =>
  String(value || "")
    .trim()
    .toLowerCase();

const normalizeMbid = (value) => {
  const normalized = normalizeText(value);
  return UUID_REGEX.test(normalized) ? normalized : null;
};

const buildSeedIdentityKeys = (mbid, artistName) => {
  const keys = [];
  if (mbid) keys.push(`mbid:${mbid}`);
  const normalizedName = normalizeText(artistName);
  if (normalizedName) keys.push(`name:${normalizedName}`);
  return keys;
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const normalizeDiscoveryMode = (value) => {
  const mode = normalizeText(value);
  return DISCOVERY_MODE_MULTIPLIERS[mode] ? mode : "balanced";
};

const sortByValueThenName = (entries) =>
  [...entries].sort((left, right) => {
    if (right[1] !== left[1]) return right[1] - left[1];
    return String(left[0] || "").localeCompare(String(right[0] || ""));
  });

const topKeysFromMap = (map, limit = 4) =>
  sortByValueThenName(map.entries())
    .slice(0, limit)
    .map(([key]) => key);

const summarizeSourceArtists = (sourceArtists) => {
  const artists = [...sourceArtists].filter(Boolean);
  if (artists.length === 0) return null;
  if (artists.length === 1) return artists[0];
  if (artists.length === 2) return `${artists[0]}, ${artists[1]}`;
  return `${artists[0]}, ${artists[1]} +${artists.length - 2} more`;
};

const mergeTags = (target, sourceTags = []) => {
  for (const tag of sourceTags) {
    const normalized = normalizeText(tag);
    if (!normalized) continue;
    if (target.size >= 16 && target.has(normalized) === false) continue;
    target.add(normalized);
  }
};

const normalizeTagList = (tags = []) =>
  (Array.isArray(tags) ? tags : []).map(normalizeText).filter(Boolean);

export const normalizeArtistIdentityKeys = (artist) => {
  const keys = [];
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

export const buildExistingArtistKeySet = (artists = []) => {
  const keys = new Set();
  for (const artist of Array.isArray(artists) ? artists : []) {
    for (const key of normalizeArtistIdentityKeys(artist)) {
      keys.add(key);
    }
  }
  return keys;
};

export const applyHydratedCandidateTags = (
  recommendation,
  candidateTags = [],
  profileTagWeights = new Map(),
  options = {},
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

  const matchedTagWeights = new Map();
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

const calculateSeedWeight = (seed, index) => {
  const source = normalizeText(seed?.source) || "library";
  const baseWeight = SOURCE_BASE_WEIGHTS[source] || 1;

  if (source === "library") {
    const recencyBoost = Math.max(0, 0.5 - Math.max(index, 0) * 0.02);
    return Number((baseWeight + recencyBoost).toFixed(4));
  }

  const playcount = Math.max(0, Number(seed?.playcount || 0));
  const playcountBoost = playcount > 0 ? Math.min(1.4, Math.log10(playcount + 1) * 0.4) : 0.15;
  return Number((baseWeight + playcountBoost).toFixed(4));
};

export const buildDiscoverySeedList = ({ libraryArtists = [], historyArtists = [] } = {}) => {
  const combined = [
    ...(Array.isArray(historyArtists) ? historyArtists : []),
    ...(Array.isArray(libraryArtists) ? libraryArtists : []),
  ];
  const seen = new Set();
  const seeds = [];

  for (let index = 0; index < combined.length; index += 1) {
    const artist = combined[index];
    const mbid = normalizeMbid(artist?.mbid || artist?.id || artist?.foreignArtistId);
    const artistName = String(artist?.artistName || artist?.name || "").trim();
    if (!artistName) continue;

    const identityKeys = buildSeedIdentityKeys(mbid, artistName);
    if (identityKeys.length === 0) continue;
    const source = normalizeText(artist?.source) || "library";
    const nextWeight = calculateSeedWeight(
      {
        source,
        playcount: artist?.playcount,
      },
      source === "library" ? index : 0,
    );
    const profileBucket = normalizeText(artist?.profileBucket) || null;

    const existingKey = identityKeys.find((key) => seen.has(key));
    if (existingKey) {
      const existing = seeds.find((entry) =>
        Array.isArray(entry.identityKeys)
          ? entry.identityKeys.some((key) => identityKeys.includes(key))
          : entry.mbid === mbid,
      );
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
          seen.add(key);
        }
        if (!existing.mbid && mbid) {
          existing.mbid = mbid;
        }
      }
      continue;
    }

    identityKeys.forEach((key) => seen.add(key));
    seeds.push({
      mbid,
      artistName,
      source,
      identityKeys,
      playcount: Math.max(0, Number(artist?.playcount || 0)),
      weight: nextWeight,
      affinityWeight: Math.max(nextWeight, Number(artist?.affinityWeight || 0) || nextWeight),
      profileBucket,
    });
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

const buildReasonCodes = ({
  tagOverlapCount,
  seedCoverage,
  sourceTypes,
  scoreNovelty,
  scorePopularityPenalty,
  discoveryMode,
  discoveryDepth,
}) => {
  const codes = [];
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
  accumulator,
  {
    candidate,
    seed,
    sourceTags = [],
    profileTagWeights = new Map(),
    existingArtistKeys = new Set(),
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

  const tags = new Set();
  mergeTags(tags, normalizedTags);
  const matchedTagWeights = new Map();
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

const finalizeRecommendationEntry = (entry, discoveryMode = "balanced") => {
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

export const finalizeRecommendationAccumulator = (accumulator, limit = 100, options = {}) => {
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

const normalizeFeedbackList = (value) =>
  (Array.isArray(value) ? value : [])
    .filter((entry) => entry && typeof entry === "object")
    .filter((entry) => {
      if (!entry.expiresAt) return true;
      const time = new Date(entry.expiresAt).getTime();
      return Number.isFinite(time) ? time > Date.now() : true;
    });

const feedbackBoostForCandidate = (candidate, feedbackList = []) => {
  let adjustment = 0;
  let hidden = false;
  const candidateKeys = new Set(normalizeArtistIdentityKeys(candidate));
  const candidateTagSet = new Set(
    (Array.isArray(candidate.matchedTags) ? candidate.matchedTags : [])
      .map(normalizeText)
      .filter(Boolean),
  );

  for (const feedback of normalizeFeedbackList(feedbackList)) {
    const feedbackKeys = normalizeArtistIdentityKeys({
      id: feedback.artistId,
      mbid: feedback.artistId,
      name: feedback.artistName,
    });
    const exactMatch = feedbackKeys.some((key) => candidateKeys.has(key));
    const tagContext = (Array.isArray(feedback.tagContext) ? feedback.tagContext : [])
      .map(normalizeText)
      .filter(Boolean);
    const tagOverlap = tagContext.filter((tag) => candidateTagSet.has(tag)).length;
    const seedContext = (Array.isArray(feedback.seedContext) ? feedback.seedContext : [])
      .map(normalizeText)
      .filter(Boolean);
    const seedOverlap = (candidate.supportingSeeds || []).filter((seed) =>
      seedContext.includes(normalizeText(seed.artistName)),
    ).length;
    const contextualMatch = tagOverlap > 0 || seedOverlap > 0;

    switch (feedback.action) {
      case "more_like_this":
        if (exactMatch) adjustment += 16;
        else if (contextualMatch) adjustment += 10 + tagOverlap * 2;
        break;
      case "less_like_this":
        if (exactMatch) {
          adjustment -= 16;
        } else if (contextualMatch) {
          adjustment -= 10 + tagOverlap * 2;
        }
        break;
      case "block_artist":
        if (exactMatch) {
          hidden = true;
          adjustment -= 100000;
        }
        break;
      default:
        break;
    }
  }

  return { adjustment, hidden };
};

export const rerankRecommendations = (recommendations = [], limit = 100, options = {}) => {
  const mode = normalizeDiscoveryMode(options.discoveryMode);
  const multipliers = DISCOVERY_MODE_MULTIPLIERS[mode];
  const input = (Array.isArray(recommendations) ? recommendations : [])
    .map((entry) => ({
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
    }))
    .map((entry) => {
      const candidateTags = [
        ...new Set(
          (Array.isArray(entry.matchedTags) ? entry.matchedTags : entry.tags || [])
            .map(normalizeText)
            .filter(Boolean),
        ),
      ];
      const candidateSeeds = [
        ...new Set(
          (Array.isArray(entry.supportingSeeds) ? entry.supportingSeeds : [])
            .map((seed) => normalizeText(seed?.artistName))
            .filter(Boolean),
        ),
      ];
      const { adjustment, hidden } = feedbackBoostForCandidate(entry, options.feedback || []);
      const baseScore =
        Number(entry.scoreSimilarity || 0) * multipliers.similarity +
        Number(entry.scoreTagAffinity || 0) * multipliers.tagAffinity +
        Number(entry.scoreSeedCoverage || 0) * multipliers.seedCoverage +
        Number(entry.scoreNovelty || 0) * multipliers.novelty -
        Number(entry.scorePopularityPenalty || 0) * multipliers.popularityPenalty +
        Number(entry.scoreFreshnessBoost || 0) -
        Number(entry.scoreAgingPenalty || 0);
      return {
        ...entry,
        __rerankBaseScore: baseScore,
        __rerankFeedbackAdjustment: adjustment,
        __rerankHidden: hidden,
        __rerankTags: candidateTags,
        __rerankSeeds: candidateSeeds,
      };
    })
    .filter((entry) => !entry.__rerankHidden)
    .sort((left, right) => {
      const leftScore = Number(left.scoreTotal || left.score || 0);
      const rightScore = Number(right.scoreTotal || right.score || 0);
      if (rightScore !== leftScore) return rightScore - leftScore;
      if ((right.seedCount || 0) !== (left.seedCount || 0)) {
        return (right.seedCount || 0) - (left.seedCount || 0);
      }
      return String(left.name || "").localeCompare(String(right.name || ""));
    });

  const selected = [];
  const pool = [...input];
  const selectedTagCounts = new Map();
  const selectedSeedCounts = new Map();
  const scoreCandidate = (candidate) => {
    let diversityPenalty = 0;
    for (const tag of candidate.__rerankTags) {
      diversityPenalty += (selectedTagCounts.get(tag) || 0) * 1.8;
    }
    for (const seed of candidate.__rerankSeeds) {
      diversityPenalty += (selectedSeedCounts.get(seed) || 0) * 2.6;
    }
    const scoreTotal = Math.round(
      candidate.__rerankBaseScore -
        diversityPenalty * multipliers.diversityPenalty +
        candidate.__rerankFeedbackAdjustment,
    );
    return {
      ...candidate,
      scoreDiversityPenalty: Math.round(diversityPenalty),
      scoreTotal,
      score: scoreTotal,
      hiddenByFeedback: false,
    };
  };
  const stripRerankMetadata = (candidate) => {
    const {
      __rerankBaseScore,
      __rerankFeedbackAdjustment,
      __rerankHidden,
      __rerankTags,
      __rerankSeeds,
      ...clean
    } = candidate;
    return clean;
  };
  const addSelectedSignals = (candidate) => {
    for (const tag of candidate.__rerankTags) {
      selectedTagCounts.set(tag, (selectedTagCounts.get(tag) || 0) + 1);
    }
    for (const seed of candidate.__rerankSeeds) {
      selectedSeedCounts.set(seed, (selectedSeedCounts.get(seed) || 0) + 1);
    }
  };

  while (pool.length > 0 && selected.length < Math.max(1, Number(limit) || 100)) {
    let bestIndex = 0;
    let bestCandidate = scoreCandidate(pool[0]);

    for (let index = 1; index < pool.length; index += 1) {
      const candidate = scoreCandidate(pool[index]);
      if (bestCandidate.hiddenByFeedback || candidate.scoreTotal > bestCandidate.scoreTotal) {
        bestCandidate = candidate;
        bestIndex = index;
      }
    }

    pool.splice(bestIndex, 1);
    addSelectedSignals(bestCandidate);
    selected.push(bestCandidate);
  }

  return selected.map(stripRerankMetadata);
};

export const filterRecommendationsForServe = (recommendations = [], feedback = []) =>
  (Array.isArray(recommendations) ? recommendations : [])
    .filter((recommendation) => !feedbackBoostForCandidate(recommendation, feedback).hidden)
    .map((recommendation) => {
      const mbid = normalizeMbid(recommendation?.id) || normalizeMbid(recommendation?.navigateTo);
      return recommendation?.id === mbid && recommendation?.navigateTo === mbid
        ? recommendation
        : { ...recommendation, id: mbid, navigateTo: mbid };
    });

const DAY_MS = 24 * 60 * 60 * 1000;

const parseTimeMs = (value, fallback = Date.now()) => {
  const time = new Date(value || "").getTime();
  return Number.isFinite(time) ? time : fallback;
};

const getRecommendationPoolKeys = (recommendation) => {
  const keys = normalizeArtistIdentityKeys(recommendation);
  if (keys.length > 0) return keys;
  const name = normalizeText(recommendation?.name);
  return name ? [`name:${name}`] : [];
};

const buildRecommendationPoolMetadataMap = (recommendations = []) => {
  const metadata = new Map();
  for (const recommendation of Array.isArray(recommendations) ? recommendations : []) {
    const keys = getRecommendationPoolKeys(recommendation);
    if (keys.length === 0) continue;
    const entry = {
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

const findRecommendationPoolMetadata = (recommendation, metadataMap) => {
  for (const key of getRecommendationPoolKeys(recommendation)) {
    const metadata = metadataMap.get(key);
    if (metadata) return metadata;
  }
  return null;
};

const applyRecommendationPoolMetadata = (
  recommendation,
  { fresh = false, index = 0, metadata = null, runStartedAt, runStartedMs } = {},
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
  recommendations = [],
  existingArtistKeys = new Set(),
) => {
  const merged = new Map();
  const aliases = new Map();

  for (const recommendation of Array.isArray(recommendations) ? recommendations : []) {
    const keys = normalizeArtistIdentityKeys(recommendation);
    if (keys.some((key) => existingArtistKeys.has(key))) continue;
    const recommendationMbid =
      normalizeMbid(recommendation?.id) || normalizeMbid(recommendation?.navigateTo);

    const identityKeys = [
      recommendationMbid,
      `name:${normalizeText(recommendation?.name)}`,
    ].filter(Boolean);
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

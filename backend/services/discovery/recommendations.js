import {
  getDiscoveryCandidateLimit,
  getDiscoveryNetworkConcurrency,
  getLastfmFailureRatio,
  getSimilarArtistSampling,
  getSecondHopArtistSampling,
  getSecondHopRecommendationLimit,
  getCandidateTagHydrationLimit,
  normalizeSeedTagList,
  getSeedTagMapKey,
  pickLastfmImage,
  mapWithConcurrency,
} from "./helpers.js";
import { lastfmRequest } from "../apiClients/index.js";
import { logger } from "../logger.js";
import {
  addRecommendationCandidate,
  finalizeRecommendationAccumulator,
  mergeResolvedRecommendations,
  normalizeArtistIdentityKeys,
  rerankRecommendations,
} from "./recommendationPipeline.js";
import { fetchArtistTopTags, hydrateRecommendationCandidateTags } from "./tasteProfile.js";

const fetchSimilarArtists = async (seed, limit, lastfmHealth) => {
  const similar = await lastfmRequest(
    "artist.getSimilar",
    seed.mbid ? { mbid: seed.mbid, limit } : { artist: seed.artistName, limit },
  );
  if (similar && !similar.error) lastfmHealth.success++; else lastfmHealth.failure++;
  const artists = similar?.similarartists?.artist;
  if (!artists) return [];
  return Array.isArray(artists) ? artists : [artists];
};

const getSeedTags = async (seed, seedTagMap, lastfmHealth) => {
  const cached = normalizeSeedTagList(seedTagMap.get(getSeedTagMapKey(seed)));
  if (cached.length > 0) return cached;
  return normalizeSeedTagList(
    (await fetchArtistTopTags(seed, lastfmHealth)).map((tag) => tag.name),
  );
};

const collectSimilarCandidates = async ({
  seeds,
  similarLimit,
  maxPerSeed,
  candidateOverrides = {},
  getSourceTags,
  accumulator,
  lastfmHealth,
  profileTagWeights,
  existingArtistKeys,
}) => {
  await mapWithConcurrency(seeds, getDiscoveryNetworkConcurrency(), async (seed) => {
    try {
      const sourceTags = await getSourceTags(seed);
      const artists = await fetchSimilarArtists(seed, similarLimit, lastfmHealth);
      for (const artist of artists.slice(0, maxPerSeed)) {
        addRecommendationCandidate(accumulator, {
          candidate: {
            mbid: artist?.mbid,
            name: artist?.name,
            image: pickLastfmImage(artist?.image),
            match: artist?.match,
            ...candidateOverrides,
          },
          seed,
          sourceTags,
          profileTagWeights,
          existingArtistKeys,
        });
      }
    } catch (error) {
      logger.warn(
        'discovery',
        `Error getting similar artists for ${seed.artistName}: ${error.message}`,
      );
    }
  });
};

const toBridgeSeed = (bridge) => {
  const weight = Math.min(
    0.78,
    Math.max(
      0.45,
      0.42 +
        Number(bridge.bestMatch || 0) * 0.25 +
        Math.min(Number(bridge.seedCount || 0), 3) * 0.04,
    ),
  );
  return {
    mbid: bridge.id || bridge.mbid || null,
    artistName: bridge.name,
    source: "lastfm_related",
    profileBucket: "two_hop_bridge",
    weight,
    affinityWeight: weight,
    discoveryDepth: 2,
    similarityMultiplier: 0.55,
    tagAffinityMultiplier: 0.55,
    bridgeTags: normalizeSeedTagList(bridge.matchedTags?.length ? bridge.matchedTags : bridge.tags),
  };
};

export const buildRecommendationsFromSeeds = async ({
  seeds,
  existingArtistKeys,
  bridgeExclusionKeys = new Set(),
  lastfmHealth,
  profileTagWeights,
  seedTagMap = new Map(),
  discoveryMode,
}) => {
  const candidateLimit = getDiscoveryCandidateLimit();
  const directRecommendations = new Map();
  await collectSimilarCandidates({
    seeds,
    ...getSimilarArtistSampling(getLastfmFailureRatio(lastfmHealth)),
    candidateOverrides: { discoveryDepth: 1 },
    getSourceTags: (seed) => getSeedTags(seed, seedTagMap, lastfmHealth),
    accumulator: directRecommendations,
    lastfmHealth,
    profileTagWeights,
    existingArtistKeys,
  });

  let directList = finalizeRecommendationAccumulator(directRecommendations, candidateLimit, {
    discoveryMode,
  });
  directList = await hydrateRecommendationCandidateTags({
    recommendations: directList,
    lastfmHealth,
    profileTagWeights,
    limit: getCandidateTagHydrationLimit(directList.length, getLastfmFailureRatio(lastfmHealth), 1),
    depth: 1,
  });
  directList = rerankRecommendations(directList, candidateLimit, { discoveryMode });

  const secondHopSampling = getSecondHopArtistSampling(getLastfmFailureRatio(lastfmHealth));
  if (secondHopSampling.seedLimit <= 0 || directList.length === 0) {
    return directList;
  }

  const bridgeSeeds = directList
    .filter((candidate) => candidate?.name)
    .filter((candidate) =>
      (Array.isArray(candidate.matchedTags) ? candidate.matchedTags : candidate.tags || []).length > 0)
    .filter((candidate) =>
      !normalizeArtistIdentityKeys(candidate).some((key) => bridgeExclusionKeys.has(key)))
    .map(toBridgeSeed)
    .filter((bridge) => bridge.bridgeTags.length > 0)
    .slice(0, secondHopSampling.seedLimit);

  const secondHopRecommendations = new Map();
  await collectSimilarCandidates({
    seeds: bridgeSeeds,
    similarLimit: secondHopSampling.similarLimit,
    maxPerSeed: secondHopSampling.maxPerSeed,
    candidateOverrides: {
      discoveryDepth: 2,
      similarityMultiplier: 0.55,
      tagAffinityMultiplier: 0.55,
    },
    getSourceTags: (bridge) => bridge.bridgeTags,
    accumulator: secondHopRecommendations,
    lastfmHealth,
    profileTagWeights,
    existingArtistKeys,
  });

  const secondHopLimit = getSecondHopRecommendationLimit();
  let secondHopList = finalizeRecommendationAccumulator(secondHopRecommendations, secondHopLimit, {
    discoveryMode,
  });
  secondHopList = await hydrateRecommendationCandidateTags({
    recommendations: secondHopList,
    lastfmHealth,
    profileTagWeights,
    limit: getCandidateTagHydrationLimit(
      secondHopList.length,
      getLastfmFailureRatio(lastfmHealth),
      2,
    ),
    depth: 2,
  });
  secondHopList = rerankRecommendations(secondHopList, secondHopLimit, { discoveryMode });
  if (secondHopList.length === 0) {
    return directList;
  }

  return rerankRecommendations(
    mergeResolvedRecommendations([...directList, ...secondHopList], existingArtistKeys),
    candidateLimit,
    { discoveryMode },
  );
};

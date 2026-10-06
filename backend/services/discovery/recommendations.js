import {
  getDiscoveryCandidateLimit,
  getDiscoveryNetworkConcurrency,
  getSourceFailureRatio,
  getSimilarArtistSampling,
  getSecondHopArtistSampling,
  getSecondHopRecommendationLimit,
  getCandidateTagHydrationLimit,
  normalizeSeedTagList,
  getSeedTagMapKey,
  mapWithConcurrency,
} from "./helpers.js";
import { getSimilarArtists } from "../musicDataSource/index.js";
import {
  addRecommendationCandidate,
  finalizeRecommendationAccumulator,
  mergeResolvedRecommendations,
  normalizeArtistIdentityKeys,
  rerankRecommendations,
} from "./recommendationPipeline.js";
import { fetchArtistGenreTags, hydrateRecommendationCandidateTags } from "./tasteProfile.js";

const getSeedTags = async (seed, seedTagMap, sourceHealth) => {
  const key = getSeedTagMapKey(seed);
  if (seedTagMap.has(key)) return normalizeSeedTagList(seedTagMap.get(key));
  const [tags] = await fetchArtistGenreTags([seed], sourceHealth);
  return normalizeSeedTagList(tags.map((tag) => tag.name));
};

const collectSimilarCandidates = async ({
  seeds,
  similarLimit,
  maxPerSeed,
  candidateOverrides = {},
  getSourceTags,
  accumulator,
  sourceHealth,
  profileTagWeights,
  existingArtistKeys,
}) => {
  await mapWithConcurrency(seeds, getDiscoveryNetworkConcurrency(), async (seed) => {
    const sourceTags = await getSourceTags(seed);
    const artists = await getSimilarArtists(
      { mbid: seed.mbid, name: seed.artistName },
      { limit: similarLimit, health: sourceHealth },
    );
    for (const artist of artists.slice(0, maxPerSeed)) {
      addRecommendationCandidate(accumulator, {
        candidate: {
          mbid: artist.mbid,
          name: artist.name,
          image: artist.image,
          match: artist.match,
          ...candidateOverrides,
        },
        seed,
        sourceTags,
        profileTagWeights,
        existingArtistKeys,
      });
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
  sourceHealth,
  profileTagWeights,
  seedTagMap = new Map(),
  discoveryMode,
}) => {
  const candidateLimit = getDiscoveryCandidateLimit();
  const directRecommendations = new Map();
  await collectSimilarCandidates({
    seeds,
    ...getSimilarArtistSampling(getSourceFailureRatio(sourceHealth)),
    candidateOverrides: { discoveryDepth: 1 },
    getSourceTags: (seed) => getSeedTags(seed, seedTagMap, sourceHealth),
    accumulator: directRecommendations,
    sourceHealth,
    profileTagWeights,
    existingArtistKeys,
  });

  let directList = finalizeRecommendationAccumulator(directRecommendations, candidateLimit, {
    discoveryMode,
  });
  directList = await hydrateRecommendationCandidateTags({
    recommendations: directList,
    sourceHealth,
    profileTagWeights,
    limit: getCandidateTagHydrationLimit(directList.length, getSourceFailureRatio(sourceHealth), 1),
    depth: 1,
  });
  directList = rerankRecommendations(directList, candidateLimit, { discoveryMode });

  const secondHopSampling = getSecondHopArtistSampling(getSourceFailureRatio(sourceHealth));
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
    sourceHealth,
    profileTagWeights,
    existingArtistKeys,
  });

  const secondHopLimit = getSecondHopRecommendationLimit();
  let secondHopList = finalizeRecommendationAccumulator(secondHopRecommendations, secondHopLimit, {
    discoveryMode,
  });
  secondHopList = await hydrateRecommendationCandidateTags({
    recommendations: secondHopList,
    sourceHealth,
    profileTagWeights,
    limit: getCandidateTagHydrationLimit(
      secondHopList.length,
      getSourceFailureRatio(sourceHealth),
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

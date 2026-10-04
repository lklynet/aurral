import { buildWeightedTopList, canInheritTagsFromSeeds, getSeedTagMapKey } from "./helpers.js";
import { getArtistTagLists } from "../musicDataSource/index.js";
import { isKnownGenre } from "../musicGenres.js";
import { applyHydratedCandidateTags } from "./recommendationPipeline.js";

const TAGS_PER_ARTIST = 15;

const toArtistRef = (artist) => ({
  mbid: artist?.mbid || artist?.id || null,
  name: String(artist?.artistName || artist?.name || "").trim(),
});

const toGenreTags = (tags) =>
  tags
    .map((tag) => ({ name: tag.name.replace(/-/g, " "), count: tag.count }))
    .filter((tag) => tag.name && isKnownGenre(tag.name))
    .slice(0, TAGS_PER_ARTIST);

export const fetchArtistGenreTags = async (artists, sourceHealth) =>
  (await getArtistTagLists(artists.map(toArtistRef), { health: sourceHealth })).map(toGenreTags);

export const collectSeedTags = async (seeds, sourceHealth) => {
  const tagWeights = new Map();
  const tagMap = new Map();
  const tagLists = await fetchArtistGenreTags(seeds, sourceHealth);

  seeds.forEach((seed, index) => {
    const tags = tagLists[index];
    if (tags.length === 0) return;
    const tagMapKey = getSeedTagMapKey(seed);
    if (tagMapKey) tagMap.set(tagMapKey, tags.map((tag) => tag.name));
    for (const tag of tags) {
      tagWeights.set(
        tag.name,
        (tagWeights.get(tag.name) || 0) + tag.count * Math.max(0.5, seed.weight || 1),
      );
    }
  });

  return { tagMap, tagWeights };
};

export const buildTagProfile = (tagWeights = new Map()) => {
  const profileTagWeights = new Map();
  for (const [tag, weight] of tagWeights.entries()) {
    const normalized = String(tag || "").trim().toLowerCase();
    if (!normalized) continue;
    profileTagWeights.set(normalized, Number(weight || 0));
  }
  return {
    profileTagWeights,
    topGenres: buildWeightedTopList(tagWeights, 24),
  };
};

export const hydrateRecommendationCandidateTags = async ({
  recommendations = [],
  sourceHealth,
  profileTagWeights,
  limit,
  depth = 1,
}) => {
  const items = Array.isArray(recommendations) ? [...recommendations] : [];
  const hydrationLimit = Math.min(items.length, Math.max(0, Number(limit) || 0));
  const options = { tagAffinityMultiplier: depth >= 2 ? 0.55 : 1 };
  const fetchIndexes = [];

  for (let index = 0; index < hydrationLimit; index += 1) {
    if (canInheritTagsFromSeeds(items[index])) {
      items[index] = applyHydratedCandidateTags(items[index], items[index].tags, profileTagWeights, {
        ...options,
        source: "inherited",
      });
    } else {
      fetchIndexes.push(index);
    }
  }

  const tagLists = await fetchArtistGenreTags(
    fetchIndexes.map((index) => items[index]),
    sourceHealth,
  );
  fetchIndexes.forEach((itemIndex, listIndex) => {
    items[itemIndex] = applyHydratedCandidateTags(
      items[itemIndex],
      tagLists[listIndex].map((tag) => tag.name),
      profileTagWeights,
      options,
    );
  });

  return items;
};

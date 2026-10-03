import {
  buildWeightedTopList,
  canInheritTagsFromSeeds,
  getDiscoveryNetworkConcurrency,
  getSeedTagMapKey,
  mapWithConcurrency,
} from "./helpers.js";
import { lastfmRequest } from "../apiClients/index.js";
import { isKnownGenre } from "../musicGenres.js";
import { logger } from "../logger.js";
import { applyHydratedCandidateTags } from "./recommendationPipeline.js";

const TAGS_PER_ARTIST = 15;

export const fetchArtistTopTags = async (artist, lastfmHealth) => {
  const artistName = String(artist?.name || artist?.artistName || "").trim();
  const mbid = String(artist?.id || artist?.mbid || "").trim();
  if (!artistName && !mbid) return [];

  const data = await lastfmRequest(
    "artist.getTopTags",
    mbid ? { mbid } : { artist: artistName },
  );
  if (data && !data.error) lastfmHealth.success++; else lastfmHealth.failure++;
  const tags = data?.toptags?.tag;
  if (!tags) return [];

  return (Array.isArray(tags) ? tags : [tags])
    .map((tag) => ({
      name: String(tag?.name || "").trim().replace(/-/g, " "),
      count: parseInt(tag?.count || 0, 10) || 1,
    }))
    .filter((tag) => tag.name && isKnownGenre(tag.name))
    .slice(0, TAGS_PER_ARTIST);
};

export const collectSeedTags = async (seeds, lastfmHealth) => {
  const tagWeights = new Map();
  const tagMap = new Map();

  await mapWithConcurrency(
    seeds,
    getDiscoveryNetworkConcurrency(),
    async (seed) => {
      try {
        const tags = await fetchArtistTopTags(seed, lastfmHealth);
        if (tags.length === 0) return;
        const tagMapKey = getSeedTagMapKey(seed);
        if (tagMapKey) tagMap.set(tagMapKey, tags.map((tag) => tag.name));
        for (const tag of tags) {
          tagWeights.set(
            tag.name,
            (tagWeights.get(tag.name) || 0) + tag.count * Math.max(0.5, seed.weight || 1),
          );
        }
      } catch (error) {
        logger.warn(
          'discovery',
          `Failed to get Last.fm tags for ${seed.artistName}: ${error.message}`,
        );
      }
    },
  );

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
  lastfmHealth,
  profileTagWeights,
  limit,
  depth = 1,
}) => {
  const items = Array.isArray(recommendations) ? [...recommendations] : [];
  const hydrationLimit = Math.min(items.length, Math.max(0, Number(limit) || 0));
  const options = { tagAffinityMultiplier: depth >= 2 ? 0.55 : 1 };

  await mapWithConcurrency(
    items.slice(0, hydrationLimit),
    getDiscoveryNetworkConcurrency(),
    async (item, index) => {
      try {
        items[index] = canInheritTagsFromSeeds(item)
          ? applyHydratedCandidateTags(item, item.tags, profileTagWeights, {
              ...options,
              source: "inherited",
            })
          : applyHydratedCandidateTags(
              item,
              (await fetchArtistTopTags(item, lastfmHealth)).map((tag) => tag.name),
              profileTagWeights,
              options,
            );
      } catch (error) {
        logger.warn(
          'discovery',
          `Failed to hydrate candidate tags for ${item?.name || "artist"}: ${error.message}`,
        );
      }
    },
  );

  return items;
};

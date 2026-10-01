import { setTimeout as wait } from "node:timers/promises";
import {
  getDiscoveryNetworkConcurrency,
  buildWeightedTopList,
  normalizeSeedTagList,
  getSeedTagMapKey,
  mapWithConcurrency,
} from "./helpers.js";
import {
  lastfmRequest,
} from "../apiClients/index.js";
import { recordDiscoveryUpdateProgress } from "./persistence.js";
import { logger } from "../logger.js";
import {
  applyHydratedCandidateTags,
} from "./recommendationPipeline.js";

export const fetchArtistTagNames = async (artist, lastfmHealth) => {
  const artistName = String(artist?.name || artist?.artistName || "").trim();
  const mbid = String(artist?.id || artist?.mbid || "").trim();
  if (!artistName && !mbid) return [];

  const data = await lastfmRequest(
    "artist.getTopTags",
    mbid ? { mbid } : { artist: artistName },
  );
  if (data && !data.error) lastfmHealth.success++; else lastfmHealth.failure++;
  if (!data?.toptags?.tag) return [];

  const tags = Array.isArray(data.toptags.tag)
    ? data.toptags.tag
    : [data.toptags.tag];
  return normalizeSeedTagList(tags.map((tag) => tag?.name));
};

export const collectSeedTagsAndGenres = async (
  seeds,
  lastfmHealth,
  progressPhase = null,
) => {
  const tagCounts = new Map();
  const tagMap = new Map();

  if (progressPhase) {
    recordDiscoveryUpdateProgress(progressPhase, "Building genre and tag profile", 35);
  }

  await mapWithConcurrency(
    seeds,
    getDiscoveryNetworkConcurrency(),
    async (seed) => {
      try {
        const data = await lastfmRequest(
          "artist.getTopTags",
          seed.mbid ? { mbid: seed.mbid } : { artist: seed.artistName },
        );
        if (data && !data.error) lastfmHealth.success++; else lastfmHealth.failure++;
        if (!data?.toptags?.tag) return;

        const tags = Array.isArray(data.toptags.tag)
          ? data.toptags.tag
          : [data.toptags.tag];
        const names = tags
          .slice(0, 15)
          .map((tag) => String(tag?.name || "").trim())
          .filter(Boolean);
        if (names.length === 0) return;

        const tagMapKey = getSeedTagMapKey(seed);
        if (tagMapKey) {
          tagMap.set(tagMapKey, names);
        }

        for (const tag of tags.slice(0, 15)) {
          const name = String(tag?.name || "").trim().replace(/-/g, " ");
          if (!name) continue;
          const tagWeight = parseInt(tag?.count || 0, 10) || 1;
          tagCounts.set(
            name,
            (tagCounts.get(name) || 0) +
              tagWeight * Math.max(0.5, seed.weight || 1),
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

  return {
    tagMap,
    tagWeights: tagCounts,
  };
};

export const buildTasteProfile = ({
  recentLibraryArtists = [],
  allLibraryArtists = [],
  historyArtists = [],
  tagMap = new Map(),
  tagWeights = new Map(),
} = {}) => {
  const recentIds = new Set(
    recentLibraryArtists
      .map((artist) =>
        String(artist?.mbid || "").trim().toLowerCase(),
      )
      .filter(Boolean),
  );
  const bucketedLibrarySeeds = [];

  recentLibraryArtists.slice(0, 28).forEach((artist, index) => {
    if (!artist?.mbid || !artist?.artistName) return;
    bucketedLibrarySeeds.push({
      mbid: artist.mbid,
      artistName: artist.artistName,
      source: "library",
      profileBucket: index < 12 ? "recent_interest" : "core_favorites",
      affinityWeight: 1.7 - Math.min(index, 20) * 0.035,
    });
  });

  allLibraryArtists.slice(0, 42).forEach((artist, index) => {
    if (!artist?.mbid || !artist?.artistName) return;
    if (recentIds.has(String(artist.mbid).trim().toLowerCase())) return;
    bucketedLibrarySeeds.push({
      mbid: artist.mbid,
      artistName: artist.artistName,
      source: "library",
      profileBucket: index < 16 ? "collection_anchor" : "exploratory_seed",
      affinityWeight: index < 16 ? 1.12 : 0.92,
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
    const normalized = String(tag || "").trim().toLowerCase();
    if (!normalized) continue;
    profileTagWeights.set(normalized, Number(weight || 0));
  }

  return {
    tagMap,
    profileTagWeights,
    topTags: buildWeightedTopList(tagWeights, 24),
    topGenres: buildWeightedTopList(tagWeights, 24),
    historySeeds: bucketedHistorySeeds,
    librarySeeds: bucketedLibrarySeeds,
  };
};

export const hydrateRecommendationCandidateTags = async ({
  recommendations = [],
  lastfmHealth,
  profileTagWeights,
  limit,
  depth = 1,
}) => {
  const { canInheritTagsFromSeeds } = await import("./helpers.js");
  const items = Array.isArray(recommendations) ? [...recommendations] : [];
  const hydrationLimit = Math.min(items.length, Math.max(0, Number(limit) || 0));
  if (hydrationLimit <= 0) return items;

  const batchSize = 8;
  const delayMs = 25;
  for (let index = 0; index < hydrationLimit; index += batchSize) {
    const batch = items.slice(index, index + batchSize);
    const hydrated = await Promise.all(
      batch.map(async (item) => {
        try {
          if (canInheritTagsFromSeeds(item)) {
            return applyHydratedCandidateTags(item, item.tags, profileTagWeights, {
              tagAffinityMultiplier: depth >= 2 ? 0.55 : 1,
              source: "inherited",
            });
          }
          const tags = await fetchArtistTagNames(item, lastfmHealth);
          return applyHydratedCandidateTags(item, tags, profileTagWeights, {
            tagAffinityMultiplier: depth >= 2 ? 0.55 : 1,
          });
        } catch (error) {
          logger.warn(
            'discovery',
            `Failed to hydrate candidate tags for ${item?.name || "artist"}: ${error.message}`,
          );
          return item;
        }
      }),
    );
    hydrated.forEach((item, offset) => {
      items[index + offset] = item;
    });
    if (index + batchSize < hydrationLimit) {
      await wait(delayMs);
    }
  }

  return items;
};

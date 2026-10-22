export function makeDiscoveryArtist(
  index,
  score,
  prefix = "artist",
  idPrefix = "00000000-0000-4000-8000",
) {
  const padded = String(index).padStart(12, "0");
  return {
    id: `${idPrefix}-${padded}`,
    name: `${prefix}-${index}`,
    matchedTags: ["indie"],
    supportingSeeds: [{ artistName: "Seed", weight: 1 }],
    scoreSimilarity: score,
    scoreTagAffinity: 10,
    scoreSeedCoverage: 8,
    scoreNovelty: 6,
    scorePopularityPenalty: 2,
    scoreTotal: score,
    seedCount: 1,
    sourceType: "lastfm",
  };
}

export function createDiscoveryArtistBatcher(idPrefix) {
  let nextOffset = 0;
  return {
    makeBatch(count, baseScore, prefix = "artist") {
      const start = nextOffset;
      nextOffset += count;
      return Array.from({ length: count }, (_, offset) =>
        makeDiscoveryArtist(start + offset, baseScore - offset, prefix, idPrefix),
      );
    },
    reset() {
      nextOffset = 0;
    },
  };
}

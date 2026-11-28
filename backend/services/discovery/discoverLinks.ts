import { dbOps } from "../../db/helpers/index.ts";
import { getUserDiscoveryNamespace } from "./userRefreshRequests.ts";

type SimilarArtist = { mbid: string | null; name: string; match: number };

const SIMILAR_OVERLAP = 0.2;
const MIN_SHARED = 2;

const nameKey = (name: string) => name.trim().toLowerCase();

// Reads stored Discover data only and never sends a request.
export function discoverSimilarArtists(userId: number) {
  const { recommendations } = dbOps.getDiscoveryCache(getUserDiscoveryNamespace(userId));
  const neighbors = new Map<string, Set<string>>();
  const spellings = new Map<string, string>();
  for (const recommendation of recommendations) {
    for (const source of recommendation.sourceArtists ?? []) {
      const key = nameKey(source);
      spellings.set(key, source.trim());
      neighbors.set(key, (neighbors.get(key) ?? new Set()).add(nameKey(recommendation.name)));
    }
  }
  const match = (left: string, right: string) => {
    const ofLeft = neighbors.get(left);
    const ofRight = neighbors.get(right);
    if (!ofLeft || !ofRight || left === right) return 0;
    const shared = [...ofLeft].filter((name) => ofRight.has(name)).length;
    const smaller = Math.min(ofLeft.size, ofRight.size);
    return shared >= Math.max(MIN_SHARED, SIMILAR_OVERLAP * smaller) ? shared / smaller : 0;
  };
  return (name: string): SimilarArtist[] => {
    const key = nameKey(name);
    return [...neighbors.keys()].flatMap((other) => {
      const score = match(key, other);
      return score ? [{ mbid: null, name: spellings.get(other) ?? other, match: score }] : [];
    });
  };
}

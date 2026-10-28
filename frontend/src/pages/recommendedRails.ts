import { artistMatchesGenre } from "./discoverUtils";

const NEW_FOR_MS = 7 * 24 * 60 * 60 * 1000;
const SEED_RAIL_LIMIT = 3;
const SEED_RAIL_MIN = 4;

type Recommendation = {
  name?: string | null;
  supportingSeeds?: { artistName?: string | null }[] | null;
  sourceArtists?: string[] | null;
  matchedTags?: string[] | null;
  tags?: string[] | null;
  discoveryDepth?: number | null;
  firstDiscoveredAt?: string | null;
};

export type RecommendedFilter =
  | { kind: "all" | "new" | "close" | "further" }
  | { kind: "genre" | "seed"; value: string };

export type RecommendedSort = { key: "rank" | "name" | "seen"; direction: "asc" | "desc" };

export const seedNameSet = (basedOn: { name?: string | null }[]): ReadonlySet<string> =>
  new Set(basedOn.flatMap((seed) => (seed.name ? [seed.name] : [])));

const supportingNames = (artist: Recommendation) =>
  (artist.supportingSeeds ?? []).flatMap((seed) => (seed.artistName ? [seed.artistName] : []));

export const firstGenre = (artist: Recommendation) =>
  artist.matchedTags?.[0] ?? artist.tags?.[0] ?? "";

export const isFurtherOut = (artist: Recommendation) => (artist.discoveryDepth ?? 1) >= 2;

export const firstSeenAt = (artist: Recommendation) => {
  const time = Date.parse(artist.firstDiscoveredAt ?? "");
  return Number.isFinite(time) ? time : null;
};

export const likedSeeds = (artist: Recommendation, seeds: ReadonlySet<string>) => [
  ...new Set(
    [...supportingNames(artist), ...(artist.sourceArtists ?? [])].filter((name) => seeds.has(name)),
  ),
];

export const pickReason = (artist: Recommendation, seeds: ReadonlySet<string>) =>
  isFurtherOut(artist)
    ? { kind: "via" as const, names: supportingNames(artist) }
    : { kind: "like" as const, names: likedSeeds(artist, seeds) };

export const recommendationReason = (artist: Recommendation, seeds: ReadonlySet<string>) => {
  const { kind, names } = pickReason(artist, seeds);
  return names.length > 0 ? `${kind} ${names.slice(0, 2).join(", ")}` : firstGenre(artist);
};

const newCutoff = (recommendations: Recommendation[], now: number) => {
  const times = recommendations.flatMap((artist) => firstSeenAt(artist) ?? []);
  if (times.length === 0) return Infinity;
  return Math.max(Math.min(...times) + 1, now - NEW_FOR_MS);
};

export const recommendationContext = (
  recommendations: Recommendation[],
  basedOn: { name?: string | null }[],
  now: number,
) => ({ cutoff: newCutoff(recommendations, now), seeds: seedNameSet(basedOn) });

export type RecommendationContext = ReturnType<typeof recommendationContext>;

const isNewSince = (artist: Recommendation, cutoff: number) =>
  (firstSeenAt(artist) ?? -Infinity) >= cutoff;

export function buildRecommendedRails<T extends Recommendation>(
  recommendations: T[],
  { cutoff, seeds }: RecommendationContext,
) {
  const [topPick, ...rest] = recommendations;
  const fresh = rest.filter((artist) => isNewSince(artist, cutoff));
  const settled = rest.filter((artist) => !isNewSince(artist, cutoff));
  const furtherOut = settled.filter(isFurtherOut);
  const direct = settled.filter((artist) => !isFurtherOut(artist));
  const strongestSeed = (artist: T) => likedSeeds(artist, seeds)[0];
  const seedCounts = new Map<string, number>();
  for (const artist of direct) {
    const seed = strongestSeed(artist);
    if (seed) seedCounts.set(seed, (seedCounts.get(seed) ?? 0) + 1);
  }
  const railSeeds = [...seedCounts]
    .filter(([, count]) => count >= SEED_RAIL_MIN)
    .sort((left, right) => right[1] - left[1])
    .slice(0, SEED_RAIL_LIMIT)
    .map(([seed]) => seed);
  return {
    topPick,
    fresh,
    seedRails: railSeeds.map((seed) => ({
      seed,
      artists: direct.filter((artist) => strongestSeed(artist) === seed),
    })),
    closeToHome: direct.filter((artist) => !railSeeds.includes(strongestSeed(artist))),
    furtherOut,
  };
}

export const matchesFilter = (
  artist: Recommendation,
  filter: RecommendedFilter,
  { cutoff, seeds }: RecommendationContext,
) => {
  switch (filter.kind) {
    case "all":
      return true;
    case "new":
      return isNewSince(artist, cutoff);
    case "close":
      return !isFurtherOut(artist);
    case "further":
      return isFurtherOut(artist);
    case "genre":
      return artistMatchesGenre(artist, filter.value);
    case "seed":
      return !isFurtherOut(artist) && likedSeeds(artist, seeds).includes(filter.value);
  }
};

export function sortRecommendedRows<T extends { rank: number; artist: Recommendation }>(
  rows: T[],
  { key, direction }: RecommendedSort,
) {
  const compare = (left: T, right: T) => {
    if (key === "name") {
      return (left.artist.name ?? "").localeCompare(right.artist.name ?? "");
    }
    if (key === "seen") {
      return (firstSeenAt(left.artist) ?? 0) - (firstSeenAt(right.artist) ?? 0);
    }
    return left.rank - right.rank;
  };
  const sign = direction === "asc" ? 1 : -1;
  return [...rows].sort((left, right) => sign * compare(left, right) || left.rank - right.rank);
}

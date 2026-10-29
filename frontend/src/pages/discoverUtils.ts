import type { InferResponseType } from "hono/client";
import type { LibraryArtistImage } from "../../../backend/services/libraryQueryService.ts";
import type { discoveryClient } from "../utils/api/clients/discovery.ts";
import {
  DISCOVER_SECTION_IDS,
  normalizeDiscoverLayout as normalizeLayoutEntries,
  type DiscoverLayoutEntry,
  type DiscoverSectionId,
} from "../../../lib/discoverLayout.ts";

export type DiscoverResponse = InferResponseType<typeof discoveryClient.$get, 200>;
export type DiscoverArtist = DiscoverResponse["recommendations"][number];

export type DiscoverUserId = number | string | null | undefined;

export interface DiscoverSection extends DiscoverLayoutEntry {
  label: string;
}

export const TAG_COLORS = [
  "#845336",
  "#57553c",
  "#a17e3e",
  "#43454f",
  "#604848",
  "#5c6652",
  "#a18b62",
  "#8c4f4a",
  "#898471",
  "#c8b491",
  "#65788f",
  "#755e4a",
  "#718062",
  "#bc9d66",
];

export const getTagColor = (name: string | null | undefined) => {
  if (!name) return "#211f27";
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return TAG_COLORS[Math.abs(hash) % TAG_COLORS.length];
};

export const DISCOVER_LAYOUT_KEY = "discoverLayout";
const DISCOVERY_CACHE_KEY = "discoverData";
const DISCOVER_RECENTLY_ADDED_KEY = "discoverRecentlyAdded";
const DISCOVER_RECENT_RELEASES_KEY = "discoverRecentReleases";

const DISCOVER_SECTION_LABELS: Record<DiscoverSectionId, string> = {
  recentlyAdded: "Recently added",
  playlists: "Playlists",
  recommendedShows: "Shows near you",
  recentReleases: "Recent releases",
  news: "Artist news",
  recommended: "Recommended",
  globalTop: "Trending artists",
  genreSections: "Because you like",
};

export const DEFAULT_DISCOVER_SECTIONS: DiscoverSection[] = DISCOVER_SECTION_IDS.map((id) => ({
  id,
  label: DISCOVER_SECTION_LABELS[id],
  enabled: true,
}));

export const DISCOVER_NEARBY_MODE_KEY = "discoverNearbyMode";
export const DISCOVER_NEARBY_ZIP_KEY = "discoverNearbyZip";
export const DISCOVER_NEARBY_COUNTRY_KEY = "discoverNearbyCountry";
export const DISCOVER_PREVIEW_ITEM_LIMIT = 12;

export const shuffleWithSeed = <T>(items: T[], seed: string | null | undefined) => {
  let state = 2166136261;
  for (const char of String(seed || "")) {
    state = Math.imul(state ^ char.charCodeAt(0), 16777619);
  }
  const random = () => {
    state = Math.imul(state ^ (state >>> 15), 2246822507);
    state = Math.imul(state ^ (state >>> 13), 3266489909);
    return ((state ^= state >>> 16) >>> 0) / 4294967296;
  };
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
};

export const artistMatchesGenre = (
  artist: { matchedTags?: unknown[] | null; tags?: unknown[] | null } | null | undefined,
  genre: string | null | undefined,
) => {
  const normalizedGenre = String(genre || "").toLowerCase();
  return (artist?.matchedTags || artist?.tags || []).some((tag) =>
    String(tag).toLowerCase().includes(normalizedGenre),
  );
};

const getDiscoverLayoutStorageKey = (userId: DiscoverUserId) =>
  userId ? `${DISCOVER_LAYOUT_KEY}:${userId}` : DISCOVER_LAYOUT_KEY;

const getDiscoveryCacheStorageKey = (userId: DiscoverUserId) =>
  userId ? `${DISCOVERY_CACHE_KEY}:${userId}` : DISCOVERY_CACHE_KEY;

const getDiscoverRecentlyAddedStorageKey = (userId: DiscoverUserId) =>
  userId ? `${DISCOVER_RECENTLY_ADDED_KEY}:${userId}` : DISCOVER_RECENTLY_ADDED_KEY;

const getDiscoverRecentReleasesStorageKey = (userId: DiscoverUserId) =>
  userId ? `${DISCOVER_RECENT_RELEASES_KEY}:${userId}` : DISCOVER_RECENT_RELEASES_KEY;

const markStoredAt = (key: string) => {
  try {
    localStorage.setItem(`${key}:at`, String(Date.now()));
  } catch {}
};

const readStoredAt = (key: string) => {
  try {
    const at = Number(localStorage.getItem(`${key}:at`));
    return Number.isFinite(at) ? at : 0;
  } catch {
    return 0;
  }
};

const getStoredArraySourceKey = (primaryKey: string, fallbackKey: string) => {
  try {
    const primary = JSON.parse(localStorage.getItem(primaryKey) || "null");
    if (Array.isArray(primary)) return primaryKey;
    if (primaryKey === fallbackKey) return null;
    const fallback = JSON.parse(localStorage.getItem(fallbackKey) || "null");
    return Array.isArray(fallback) ? fallbackKey : null;
  } catch {
    return null;
  }
};

const readStoredArray = (primaryKey: string, fallbackKey: string) => {
  const sourceKey = getStoredArraySourceKey(primaryKey, fallbackKey);
  if (!sourceKey) return null;
  try {
    return JSON.parse(localStorage.getItem(sourceKey) || "null");
  } catch {
    return null;
  }
};

const readStoredArrayAt = (primaryKey: string, fallbackKey: string) => {
  const sourceKey = getStoredArraySourceKey(primaryKey, fallbackKey);
  return sourceKey ? readStoredAt(sourceKey) : 0;
};

export const getStoredRecentlyAddedAt = (userId: DiscoverUserId) =>
  readStoredArrayAt(getDiscoverRecentlyAddedStorageKey(userId), DISCOVER_RECENTLY_ADDED_KEY);

export const getStoredRecentReleasesAt = (userId: DiscoverUserId) =>
  readStoredArrayAt(getDiscoverRecentReleasesStorageKey(userId), DISCOVER_RECENT_RELEASES_KEY);

export type NearbyLocationMode = "ip" | "zip";

export const readStoredNearbyLocation = (): {
  mode: NearbyLocationMode;
  zip: string;
  country: string;
} => {
  try {
    const storedMode = localStorage.getItem(DISCOVER_NEARBY_MODE_KEY);
    const storedZip = localStorage.getItem(DISCOVER_NEARBY_ZIP_KEY) || "";
    const storedCountry = localStorage.getItem(DISCOVER_NEARBY_COUNTRY_KEY) || "";
    const mode = storedMode === "zip" || storedMode === "ip" ? storedMode : "ip";
    return { mode, zip: storedZip, country: storedCountry };
  } catch {
    return { mode: "ip", zip: "", country: "" };
  }
};

export const writeStoredNearbyLocation = ({
  mode,
  zip,
  country,
}: { mode?: string; zip?: string; country?: string } = {}) => {
  try {
    if (mode === "zip" || mode === "ip") {
      localStorage.setItem(DISCOVER_NEARBY_MODE_KEY, mode);
    }
    if (typeof zip === "string") {
      localStorage.setItem(DISCOVER_NEARBY_ZIP_KEY, zip);
    }
    if (typeof country === "string") {
      localStorage.setItem(DISCOVER_NEARBY_COUNTRY_KEY, country);
    }
  } catch {}
};

export const readStoredRecentlyAdded = (userId: DiscoverUserId) => {
  return readStoredArray(getDiscoverRecentlyAddedStorageKey(userId), DISCOVER_RECENTLY_ADDED_KEY);
};

export const writeStoredRecentlyAdded = (value: unknown, userId: DiscoverUserId) => {
  if (!Array.isArray(value)) return;
  try {
    localStorage.setItem(getDiscoverRecentlyAddedStorageKey(userId), JSON.stringify(value));
    markStoredAt(getDiscoverRecentlyAddedStorageKey(userId));
  } catch {
    console.warn("Failed to write discover recently-added");
  }
};

export const readStoredRecentReleases = (userId: DiscoverUserId) => {
  return readStoredArray(getDiscoverRecentReleasesStorageKey(userId), DISCOVER_RECENT_RELEASES_KEY);
};

export const writeStoredRecentReleases = (value: unknown, userId: DiscoverUserId) => {
  if (!Array.isArray(value)) return;
  try {
    localStorage.setItem(getDiscoverRecentReleasesStorageKey(userId), JSON.stringify(value));
    markStoredAt(getDiscoverRecentReleasesStorageKey(userId));
  } catch {
    console.warn("Failed to write discover recent-releases");
  }
};

type StoredDiscoveryData = { [K in keyof DiscoverResponse]?: DiscoverResponse[K] | null };

export const normalizeDiscoveryData = (value: StoredDiscoveryData | null | undefined) => {
  if (!value || typeof value !== "object") return null;
  return {
    recommendations: Array.isArray(value.recommendations) ? value.recommendations : [],
    globalTop: Array.isArray(value.globalTop) ? value.globalTop : [],
    basedOn: Array.isArray(value.basedOn) ? value.basedOn : [],
    topTags: Array.isArray(value.topTags) ? value.topTags : [],
    topGenres: Array.isArray(value.topGenres) ? value.topGenres : [],
    provider: value.provider || null,
    lastUpdated: value.lastUpdated || null,
    recommendationQuality:
      value.recommendationQuality === "initial" ||
      value.recommendationQuality === "enriching" ||
      value.recommendationQuality === "enriched"
        ? value.recommendationQuality
        : null,
    isEnriching: value.isEnriching === true,
    discoveryRunId: value.discoveryRunId || null,
    enrichmentStartedAt: value.enrichmentStartedAt || null,
    enrichmentCompletedAt: value.enrichmentCompletedAt || null,
    enrichmentProgressMessage: value.enrichmentProgressMessage || null,
    discoveryMode:
      value.discoveryMode === "safer" || value.discoveryMode === "deeper"
        ? value.discoveryMode
        : "balanced",
    configured: typeof value.configured === "boolean" ? value.configured : true,
  };
};

export const readStoredDiscoveryData = (userId: DiscoverUserId) => {
  const fromStorage = normalizeDiscoveryData;
  try {
    const primaryKey = getDiscoveryCacheStorageKey(userId);
    const primary = fromStorage(JSON.parse(localStorage.getItem(primaryKey) || "null"));
    if (primary) return primary;
    if (primaryKey === DISCOVERY_CACHE_KEY) return null;
    return fromStorage(JSON.parse(localStorage.getItem(DISCOVERY_CACHE_KEY) || "null"));
  } catch {
    return null;
  }
};

export const writeStoredDiscoveryData = (
  value: Parameters<typeof normalizeDiscoveryData>[0],
  userId: DiscoverUserId,
) => {
  const normalized = normalizeDiscoveryData(value);
  if (!normalized) return;
  try {
    localStorage.setItem(getDiscoveryCacheStorageKey(userId), JSON.stringify(normalized));
    markStoredAt(getDiscoveryCacheStorageKey(userId));
  } catch {
    console.warn("Failed to write discover discovery-data");
  }
};

export const normalizeDiscoverLayout = (value: unknown): DiscoverSection[] | null =>
  normalizeLayoutEntries(value)?.map((entry) => ({
    ...entry,
    label: DISCOVER_SECTION_LABELS[entry.id],
  })) ?? null;

export const readStoredDiscoverLayout = (userId: DiscoverUserId) => {
  try {
    const primaryKey = getDiscoverLayoutStorageKey(userId);
    const primary = normalizeDiscoverLayout(JSON.parse(localStorage.getItem(primaryKey) || "null"));
    if (primary) return primary;
    if (primaryKey === DISCOVER_LAYOUT_KEY) return null;
    return normalizeDiscoverLayout(JSON.parse(localStorage.getItem(DISCOVER_LAYOUT_KEY) || "null"));
  } catch {
    return null;
  }
};

export const writeStoredDiscoverLayout = (layout: DiscoverSection[], userId: DiscoverUserId) => {
  try {
    localStorage.setItem(getDiscoverLayoutStorageKey(userId), JSON.stringify(layout));
  } catch {
    console.warn("Failed to write discover layout");
  }
};

export const getLibraryArtistImage = (
  artist: { images?: LibraryArtistImage[] | null } | null | undefined,
) => {
  const images = (Array.isArray(artist?.images) ? artist.images : []).filter(
    (image) => image?.remoteUrl || image?.url || image?.Url,
  );
  const kind = (image: LibraryArtistImage) =>
    String(image.coverType || image.kind || image.CoverType || "").toLowerCase();
  const image =
    images.find((image) => kind(image) === "poster") ||
    images.find((image) => kind(image) === "fanart") ||
    images[0];
  return image?.remoteUrl || image?.url || image?.Url || null;
};

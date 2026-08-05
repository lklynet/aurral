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

export const getTagColor = (name) => {
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

export const DEFAULT_DISCOVER_SECTIONS = [
  { id: "recentlyAdded", label: "Recently Added", enabled: true },
  { id: "playlists", label: "Playlists for you", enabled: true },
  { id: "recommendedShows", label: "Shows Near You", enabled: true },
  { id: "recentReleases", label: "Recent Releases", enabled: true },
  { id: "news", label: "Artist News", enabled: true },
  { id: "recommended", label: "Recommended for You", enabled: true },
  { id: "globalTop", label: "Global Trending", enabled: true },
  { id: "genreSections", label: "Because You Like", enabled: true },
];

export const FALLBACK_GENRE_SECTION_PREFIX = "fallbackGenre:";

export const getFallbackGenreSectionId = (genre) =>
  `${FALLBACK_GENRE_SECTION_PREFIX}${String(genre || "").trim()}`;

export const getFallbackGenreFromSectionId = (id) =>
  String(id || "").startsWith(FALLBACK_GENRE_SECTION_PREFIX)
    ? String(id).slice(FALLBACK_GENRE_SECTION_PREFIX.length)
    : null;

export const DISCOVER_NEARBY_MODE_KEY = "discoverNearbyMode";
export const DISCOVER_NEARBY_ZIP_KEY = "discoverNearbyZip";
export const DISCOVER_PREVIEW_ITEM_LIMIT = 12;

const getDiscoverLayoutStorageKey = (userId) =>
  userId ? `${DISCOVER_LAYOUT_KEY}:${userId}` : DISCOVER_LAYOUT_KEY;

const getDiscoveryCacheStorageKey = (userId) =>
  userId ? `${DISCOVERY_CACHE_KEY}:${userId}` : DISCOVERY_CACHE_KEY;

const getDiscoverRecentlyAddedStorageKey = (userId) =>
  userId
    ? `${DISCOVER_RECENTLY_ADDED_KEY}:${userId}`
    : DISCOVER_RECENTLY_ADDED_KEY;

const getDiscoverRecentReleasesStorageKey = (userId) =>
  userId
    ? `${DISCOVER_RECENT_RELEASES_KEY}:${userId}`
    : DISCOVER_RECENT_RELEASES_KEY;

export const DISCOVER_CACHE_FRESH_TTL_MS = 5 * 60 * 1000;

const markStoredAt = (key) => {
  try {
    localStorage.setItem(`${key}:at`, String(Date.now()));
  } catch {}
};

const isStoredFresh = (key) => {
  try {
    const at = Number(localStorage.getItem(`${key}:at`));
    return Number.isFinite(at) && Date.now() - at < DISCOVER_CACHE_FRESH_TTL_MS;
  } catch {
    return false;
  }
};

export const isStoredRecentlyAddedFresh = (userId) =>
  isStoredFresh(getDiscoverRecentlyAddedStorageKey(userId));

export const isStoredRecentReleasesFresh = (userId) =>
  isStoredFresh(getDiscoverRecentReleasesStorageKey(userId));

export const readStoredNearbyLocation = () => {
  try {
    const storedMode = localStorage.getItem(DISCOVER_NEARBY_MODE_KEY);
    const storedZip = localStorage.getItem(DISCOVER_NEARBY_ZIP_KEY) || "";
    const mode =
      storedMode === "zip" || storedMode === "ip" ? storedMode : "ip";
    return { mode, zip: storedZip };
  } catch {
    return { mode: "ip", zip: "" };
  }
};

export const writeStoredNearbyLocation = ({ mode, zip } = {}) => {
  try {
    if (mode === "zip" || mode === "ip") {
      localStorage.setItem(DISCOVER_NEARBY_MODE_KEY, mode);
    }
    if (typeof zip === "string") {
      localStorage.setItem(DISCOVER_NEARBY_ZIP_KEY, zip);
    }
  } catch {}
};

export const readStoredRecentlyAdded = (userId) => {
  try {
    const primaryKey = getDiscoverRecentlyAddedStorageKey(userId);
    const primary = JSON.parse(localStorage.getItem(primaryKey) || "null");
    if (Array.isArray(primary)) return primary;
    if (primaryKey === DISCOVER_RECENTLY_ADDED_KEY) return null;
    const fallback = JSON.parse(
      localStorage.getItem(DISCOVER_RECENTLY_ADDED_KEY) || "null",
    );
    return Array.isArray(fallback) ? fallback : null;
  } catch {
    return null;
  }
};

export const writeStoredRecentlyAdded = (value, userId) => {
  if (!Array.isArray(value)) return;
  try {
    localStorage.setItem(
      getDiscoverRecentlyAddedStorageKey(userId),
      JSON.stringify(value),
    );
    markStoredAt(getDiscoverRecentlyAddedStorageKey(userId));
  } catch {
    console.warn("Failed to write discover recently-added");
  }
};

export const readStoredRecentReleases = (userId) => {
  try {
    const primaryKey = getDiscoverRecentReleasesStorageKey(userId);
    const primary = JSON.parse(localStorage.getItem(primaryKey) || "null");
    if (Array.isArray(primary)) return primary;
    if (primaryKey === DISCOVER_RECENT_RELEASES_KEY) return null;
    const fallback = JSON.parse(
      localStorage.getItem(DISCOVER_RECENT_RELEASES_KEY) || "null",
    );
    return Array.isArray(fallback) ? fallback : null;
  } catch {
    return null;
  }
};

export const writeStoredRecentReleases = (value, userId) => {
  if (!Array.isArray(value)) return;
  try {
    localStorage.setItem(
      getDiscoverRecentReleasesStorageKey(userId),
      JSON.stringify(value),
    );
    markStoredAt(getDiscoverRecentReleasesStorageKey(userId));
  } catch {
    console.warn("Failed to write discover recent-releases");
  }
};

export const stripDiscoverPlaylistAdoptionFields = (playlists) =>
  (Array.isArray(playlists) ? playlists : []).map((playlist) => {
    const rest = { ...playlist };
    delete rest.adoptedFlowId;
    delete rest.adoptedPlaylistId;
    return rest;
  });

export const normalizeDiscoveryData = (value) => {
  if (!value || typeof value !== "object") return null;
  return {
    recommendations: Array.isArray(value.recommendations)
      ? value.recommendations
      : [],
    globalTop: Array.isArray(value.globalTop) ? value.globalTop : [],
    basedOn: Array.isArray(value.basedOn) ? value.basedOn : [],
    topTags: Array.isArray(value.topTags) ? value.topTags : [],
    topGenres: Array.isArray(value.topGenres) ? value.topGenres : [],
    fallbackGenres: Array.isArray(value.fallbackGenres)
      ? value.fallbackGenres
      : [],
    discoverPlaylists: Array.isArray(value.discoverPlaylists)
      ? value.discoverPlaylists
      : [],
    provider: value.provider || "lastfm",
    capabilities:
      value.capabilities && typeof value.capabilities === "object"
        ? value.capabilities
        : null,
    lastUpdated: value.lastUpdated || null,
    isUpdating: !!value.isUpdating,
    updatePhase: value.updatePhase || null,
    updateProgress:
      typeof value.updateProgress === "number" ? value.updateProgress : null,
    updateProgressMessage: value.updateProgressMessage || null,
    playlistsUpdating: !!value.playlistsUpdating,
    playlistsUpdateMessage: value.playlistsUpdateMessage || null,
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
    stale: !!value.stale,
    discoveryMode:
      value.discoveryMode === "safer" || value.discoveryMode === "deeper"
        ? value.discoveryMode
        : "balanced",
    configured: typeof value.configured === "boolean" ? value.configured : true,
  };
};

export const stripDiscoveryStatusForStorage = (value) => {
  const normalized = normalizeDiscoveryData(value);
  if (!normalized) return null;
  return {
    ...normalized,
    isUpdating: false,
    updatePhase: null,
    updateProgress: null,
    updateProgressMessage: null,
    playlistsUpdating: false,
    playlistsUpdateMessage: null,
    isEnriching: false,
    enrichmentProgressMessage: null,
    stale: false,
  };
};

export const mergeDiscoveryHttp = (
  prev,
  http,
  { allowClearStatus = true } = {},
) => {
  const next = normalizeDiscoveryData(http);
  if (!next) return prev || null;
  if (allowClearStatus || !prev) return next;
  if (prev.isUpdating && !next.isUpdating) {
    next.isUpdating = true;
    next.updatePhase = prev.updatePhase;
    next.updateProgress = prev.updateProgress;
    next.updateProgressMessage = prev.updateProgressMessage;
  }
  if (prev.playlistsUpdating && !next.playlistsUpdating) {
    next.playlistsUpdating = true;
    next.playlistsUpdateMessage = prev.playlistsUpdateMessage;
  }
  if (prev.isEnriching && !next.isEnriching) {
    next.isEnriching = true;
    next.enrichmentProgressMessage = prev.enrichmentProgressMessage;
  }
  return next;
};

export const readStoredDiscoveryData = (userId) => {
  const fromStorage = (raw) => {
    const normalized = stripDiscoveryStatusForStorage(raw);
    if (!normalized) return null;
    return {
      ...normalized,
      discoverPlaylists: stripDiscoverPlaylistAdoptionFields(
        normalized.discoverPlaylists,
      ),
    };
  };
  try {
    const primaryKey = getDiscoveryCacheStorageKey(userId);
    const primary = fromStorage(
      JSON.parse(localStorage.getItem(primaryKey) || "null"),
    );
    if (primary) return primary;
    if (primaryKey === DISCOVERY_CACHE_KEY) return null;
    return fromStorage(
      JSON.parse(localStorage.getItem(DISCOVERY_CACHE_KEY) || "null"),
    );
  } catch {
    return null;
  }
};

export const writeStoredDiscoveryData = (value, userId) => {
  const normalized = stripDiscoveryStatusForStorage(value);
  if (!normalized) return;
  try {
    localStorage.setItem(
      getDiscoveryCacheStorageKey(userId),
      JSON.stringify({
        ...normalized,
        discoverPlaylists: stripDiscoverPlaylistAdoptionFields(
          normalized.discoverPlaylists,
        ),
      }),
    );
    markStoredAt(getDiscoveryCacheStorageKey(userId));
  } catch {
    console.warn("Failed to write discover discovery-data");
  }
};

export const normalizeDiscoverLayout = (value) => {
  if (!Array.isArray(value)) return null;
  const defaultsById = new Map(
    DEFAULT_DISCOVER_SECTIONS.map((item) => [item.id, item]),
  );
  const seenDynamicIds = new Set();
  const normalized = [];
  value.forEach((item) => {
    const id = String(item?.id || "").trim();
    if (!id) return;
    const enabled =
      typeof item?.enabled === "boolean" ? item.enabled : undefined;
    const fallbackGenre = getFallbackGenreFromSectionId(id);
    if (fallbackGenre) {
      if (seenDynamicIds.has(id)) return;
      seenDynamicIds.add(id);
      normalized.push({
        id,
        label: `Top ${fallbackGenre} Artists`,
        enabled: enabled ?? true,
      });
      return;
    }
    if (!defaultsById.has(id)) return;
    const base = defaultsById.get(id);
    normalized.push({
      ...base,
      enabled: enabled ?? base.enabled,
    });
    defaultsById.delete(id);
  });
  defaultsById.forEach((item) => normalized.push({ ...item }));
  return normalized;
};

export const readStoredDiscoverLayout = (userId) => {
  try {
    const primaryKey = getDiscoverLayoutStorageKey(userId);
    const primary = normalizeDiscoverLayout(
      JSON.parse(localStorage.getItem(primaryKey) || "null"),
    );
    if (primary) return primary;
    if (primaryKey === DISCOVER_LAYOUT_KEY) return null;
    return normalizeDiscoverLayout(
      JSON.parse(localStorage.getItem(DISCOVER_LAYOUT_KEY) || "null"),
    );
  } catch {
    return null;
  }
};

export const writeStoredDiscoverLayout = (layout, userId) => {
  try {
    localStorage.setItem(
      getDiscoverLayoutStorageKey(userId),
      JSON.stringify(layout),
    );
  } catch {
    console.warn("Failed to write discover layout");
  }
};

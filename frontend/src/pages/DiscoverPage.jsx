import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import {
  Loader,
  Music,
  Sparkles,
  Clock,
  LayoutTemplate,
} from "lucide-react";
import {
  addArtistToLibrary,
  getBootstrapStatus,
  getDiscovery,
  getNearbyShows,
  getMyDiscoverLayout,
  getRecentlyAdded,
  getRecentReleases,
  getReleaseGroupCover,
  getArtistCover,
  lookupArtistsInLibraryBatch,
  readLibraryLookupCache,
  updateMyDiscoverLayout,
  downloadAlbum,
  updateLibraryAlbum,
} from "../utils/api";
import { useWebSocketChannel } from "../hooks/useWebSocket";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { useAuth } from "../contexts/AuthContext";
import { getArtistFeedbackFlags } from "../utils/discoveryFeedback";
import { useArtistTasteFeedback } from "../hooks/useArtistTasteFeedback";
import { getArtistRecordId } from "../utils/artistTaste";
import NearbyLocationControl from "../components/NearbyLocationControl";
import ShowCard from "../components/ShowCard";
import LastfmBanner from "../components/LastfmBanner";
import { useToast } from "../contexts/ToastContext";
import { DiscoverRail } from "../components/DiscoverRail";
import { DiscoverLayoutModal } from "./DiscoverLayoutModal";
import { DiscoverPlaylistSection } from "./DiscoverPlaylistSection";
import { AlbumCard, ArtistCard, ViewAllCard } from "./DiscoverCards";
import { useDiscoverLayoutState } from "./useDiscoverLayoutState";

const TAG_COLORS = [
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

const getTagColor = (name) => {
  if (!name) return "#211f27";
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return TAG_COLORS[Math.abs(hash) % TAG_COLORS.length];
};

const DISCOVER_LAYOUT_KEY = "discoverLayout";
const DISCOVERY_CACHE_KEY = "discoverData";
const DISCOVER_RECENTLY_ADDED_KEY = "discoverRecentlyAdded";
const DISCOVER_RECENT_RELEASES_KEY = "discoverRecentReleases";
const DISCOVER_NEARBY_SHOWS_KEY = "discoverNearbyShows";

const DEFAULT_DISCOVER_SECTIONS = [
  { id: "recentlyAdded", label: "Recently Added", enabled: true },
  { id: "playlists", label: "Playlists for you", enabled: true },
  { id: "recommendedShows", label: "Shows Near You", enabled: true },
  { id: "recentReleases", label: "Recent Releases", enabled: true },
  { id: "recommended", label: "Recommended for You", enabled: true },
  { id: "globalTop", label: "Global Trending", enabled: true },
  { id: "genreSections", label: "Because You Like", enabled: true },
];

const FALLBACK_GENRE_SECTION_PREFIX = "fallbackGenre:";

const getFallbackGenreSectionId = (genre) =>
  `${FALLBACK_GENRE_SECTION_PREFIX}${String(genre || "").trim()}`;

const getFallbackGenreFromSectionId = (id) =>
  String(id || "").startsWith(FALLBACK_GENRE_SECTION_PREFIX)
    ? String(id).slice(FALLBACK_GENRE_SECTION_PREFIX.length)
    : null;

const DISCOVER_NEARBY_MODE_KEY = "discoverNearbyMode";
const DISCOVER_NEARBY_ZIP_KEY = "discoverNearbyZip";
const DISCOVER_PREVIEW_ITEM_LIMIT = 12;
const getArtistId = (artist) => getArtistRecordId(artist);
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

const getDiscoverNearbyShowsStorageKey = (userId, locationMode, zip) => {
  const base = userId
    ? `${DISCOVER_NEARBY_SHOWS_KEY}:${userId}`
    : DISCOVER_NEARBY_SHOWS_KEY;
  const locationKey =
    locationMode === "zip" ? `zip:${String(zip || "").trim()}` : "ip";
  return `${base}:${locationKey}`;
};

const readStoredNearbyLocation = () => {
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

const readStoredRecentlyAdded = (userId) => {
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

const writeStoredRecentlyAdded = (value, userId) => {
  if (!Array.isArray(value)) return;
  try {
    localStorage.setItem(
      getDiscoverRecentlyAddedStorageKey(userId),
      JSON.stringify(value),
    );
  } catch {}
};

const readStoredRecentReleases = (userId) => {
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

const writeStoredRecentReleases = (value, userId) => {
  if (!Array.isArray(value)) return;
  try {
    localStorage.setItem(
      getDiscoverRecentReleasesStorageKey(userId),
      JSON.stringify(value),
    );
  } catch {}
};

const normalizeNearbyShowsData = (value) => {
  if (!value || typeof value !== "object") return null;
  if (!Array.isArray(value.shows)) return null;
  return value;
};

const readStoredNearbyShows = (userId, locationMode, zip) => {
  try {
    const primaryKey = getDiscoverNearbyShowsStorageKey(
      userId,
      locationMode,
      zip,
    );
    const primary = normalizeNearbyShowsData(
      JSON.parse(localStorage.getItem(primaryKey) || "null"),
    );
    if (primary) return primary;
    if (!userId) return null;
    const legacyKey = getDiscoverNearbyShowsStorageKey(null, locationMode, zip);
    return normalizeNearbyShowsData(
      JSON.parse(localStorage.getItem(legacyKey) || "null"),
    );
  } catch {
    return null;
  }
};

const writeStoredNearbyShows = (value, userId, locationMode, zip) => {
  const normalized = normalizeNearbyShowsData(value);
  if (!normalized) return;
  try {
    localStorage.setItem(
      getDiscoverNearbyShowsStorageKey(userId, locationMode, zip),
      JSON.stringify(normalized),
    );
  } catch {}
};

const stripDiscoverPlaylistAdoptionFields = (playlists) =>
  (Array.isArray(playlists) ? playlists : []).map((playlist) => {
    const rest = { ...playlist };
    delete rest.adoptedFlowId;
    delete rest.adoptedPlaylistId;
    return rest;
  });

const normalizeDiscoveryData = (value) => {
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
    stale: !!value.stale,
    discoveryMode:
      value.discoveryMode === "safer" || value.discoveryMode === "deeper"
        ? value.discoveryMode
        : "balanced",
    configured: typeof value.configured === "boolean" ? value.configured : true,
  };
};

const readStoredDiscoveryData = (userId) => {
  const fromStorage = (raw) => {
    const normalized = normalizeDiscoveryData(raw);
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

const writeStoredDiscoveryData = (value, userId) => {
  const normalized = normalizeDiscoveryData(value);
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
  } catch {}
};

const normalizeDiscoverLayout = (value) => {
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

const readStoredDiscoverLayout = (userId) => {
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

const writeStoredDiscoverLayout = (layout, userId) => {
  try {
    localStorage.setItem(
      getDiscoverLayoutStorageKey(userId),
      JSON.stringify(layout),
    );
  } catch {}
};

function DiscoverPage() {
  useDocumentTitle("Discover");
  const { user: authUser, hasPermission } = useAuth();
  const initialNearbyLocation = useMemo(() => readStoredNearbyLocation(), []);
  const [data, setData] = useState(() => readStoredDiscoveryData(authUser?.id));
  const [recentlyAdded, setRecentlyAdded] = useState(
    () => readStoredRecentlyAdded(authUser?.id) || [],
  );
  const [recentReleases, setRecentReleases] = useState(
    () => readStoredRecentReleases(authUser?.id) || [],
  );
  const [releaseCovers, setReleaseCovers] = useState({});
  const [artistCovers, setArtistCovers] = useState({});
  const [pendingRecentReleaseIds, setPendingRecentReleaseIds] = useState({});
  const [error, setError] = useState(null);
  const [libraryLookup, setLibraryLookup] = useState({});
  const { lookup: artistFeedbackLookup, submitFeedback } =
    useArtistTasteFeedback();
  const [nearbyShowsData, setNearbyShowsData] = useState(() =>
    readStoredNearbyShows(
      authUser?.id,
      initialNearbyLocation.mode,
      initialNearbyLocation.zip,
    ),
  );
  const [ticketmasterConfigured, setTicketmasterConfigured] = useState(true);
  const [nearbyShowsLoading, setNearbyShowsLoading] = useState(
    () =>
      !readStoredNearbyShows(
        authUser?.id,
        initialNearbyLocation.mode,
        initialNearbyLocation.zip,
      ),
  );
  const [nearbyShowsError, setNearbyShowsError] = useState(null);
  const [nearbyLocationMode, setNearbyLocationMode] = useState(
    initialNearbyLocation.mode,
  );
  const [appliedNearbyZip, setAppliedNearbyZip] = useState(
    initialNearbyLocation.zip,
  );
  const [showFullBasedOnList, setShowFullBasedOnList] = useState(false);
  const requestedReleaseCoversRef = useRef(new Set());
  const requestedArtistCoversRef = useRef(new Set());
  const lastDiscoveryWsMessageAtRef = useRef(0);
  const navigate = useNavigate();
  const { showSuccess, showError } = useToast();
  const canAddArtist = hasPermission("addArtist");
  const canAddAlbum = hasPermission("addAlbum");
  const canAdoptPlaylist = hasPermission("accessFlow");
  const {
    discoverSections,
    draftSections,
    setDraftSections,
    showDiscoverModal,
    setShowDiscoverModal,
    isSavingDiscoverLayout,
    saveDiscoverLayout,
  } = useDiscoverLayoutState({
    defaultSections: DEFAULT_DISCOVER_SECTIONS,
    userId: authUser?.id,
    normalizeLayout: normalizeDiscoverLayout,
    readStoredLayout: readStoredDiscoverLayout,
    writeStoredLayout: writeStoredDiscoverLayout,
    loadServerLayout: getMyDiscoverLayout,
    saveServerLayout: updateMyDiscoverLayout,
    showSuccess,
    showError,
  });

  const applyDiscoveryData = useCallback(
    (nextValue) => {
      const normalizedData = normalizeDiscoveryData(nextValue);
      if (!normalizedData) return;
      setData(normalizedData);
      writeStoredDiscoveryData(normalizedData, authUser?.id);
    },
    [authUser?.id],
  );

  const { isConnected: isDiscoverySocketConnected } = useWebSocketChannel(
    "discovery",
    (msg) => {
      if (msg.type !== "discovery_update") return;

      if (msg.phase === "error") {
        setData((prev) =>
          normalizeDiscoveryData({
            ...(prev || {}),
            isUpdating: false,
            updatePhase: "error",
            updateProgress: null,
            updateProgressMessage:
              msg.progressMessage || "Discovery refresh failed",
          }),
        );
        return;
      }

      if (msg.playlistsUpdating || msg.phase === "playlists_building") {
        lastDiscoveryWsMessageAtRef.current = Date.now();
        setData((prev) =>
          normalizeDiscoveryData({
            ...(prev || {}),
            playlistsUpdating: true,
            playlistsUpdateMessage:
              msg.playlistsUpdateMessage ||
              msg.progressMessage ||
              "Updating recommended playlists...",
            isUpdating: false,
            configured: true,
            stale: false,
          }),
        );
        return;
      }

      if (msg.phase === "playlists_completed") {
        lastDiscoveryWsMessageAtRef.current = Date.now();
        setData((prev) =>
          normalizeDiscoveryData({
            ...(prev || {}),
            discoverPlaylists: Array.isArray(msg.discoverPlaylists)
              ? msg.discoverPlaylists
              : prev?.discoverPlaylists || [],
            playlistsUpdating: false,
            playlistsUpdateMessage: null,
            lastUpdated: msg.lastUpdated || prev?.lastUpdated || null,
            configured: true,
            stale: false,
          }),
        );
        getDiscovery(true)
          .then((discoveryData) => {
            applyDiscoveryData(discoveryData);
            setError(null);
          })
          .catch(() => {});
        return;
      }

      if (msg.phase === "playlists_error") {
        setData((prev) =>
          normalizeDiscoveryData({
            ...(prev || {}),
            playlistsUpdating: false,
            playlistsUpdateMessage: null,
          }),
        );
        return;
      }

      if (msg.isUpdating) {
        lastDiscoveryWsMessageAtRef.current = Date.now();
        setData((prev) =>
          normalizeDiscoveryData({
            ...(prev || {}),
            isUpdating: true,
            updatePhase: msg.phase || prev?.updatePhase || null,
            updateProgress:
              typeof msg.progress === "number"
                ? msg.progress
                : prev?.updateProgress ?? null,
            updateProgressMessage:
              msg.progressMessage || prev?.updateProgressMessage || null,
            provider: msg.provider || prev?.provider || "lastfm",
            capabilities: msg.capabilities || prev?.capabilities || null,
            configured: true,
            stale: false,
          }),
        );
        return;
      }

      if (msg.phase === "completed" || Array.isArray(msg.recommendations)) {
        lastDiscoveryWsMessageAtRef.current = Date.now();
        if (Array.isArray(msg.recommendations)) {
          setData((prev) => {
            const normalized = normalizeDiscoveryData({
              recommendations: msg.recommendations || [],
              globalTop: msg.globalTop || [],
              basedOn: msg.basedOn || [],
              topTags: msg.topTags || [],
              topGenres: msg.topGenres || [],
              fallbackGenres: msg.fallbackGenres || [],
              discoverPlaylists: msg.discoverPlaylists || [],
              provider: msg.provider || "lastfm",
              capabilities: msg.capabilities || null,
              lastUpdated: msg.lastUpdated || null,
              isUpdating: false,
              updatePhase: null,
              updateProgress: null,
              updateProgressMessage: null,
              playlistsUpdating:
                typeof msg.playlistsUpdating === "boolean"
                  ? msg.playlistsUpdating
                  : prev?.playlistsUpdating,
              playlistsUpdateMessage:
                msg.playlistsUpdateMessage ??
                prev?.playlistsUpdateMessage ??
                null,
              stale: false,
              discoveryMode:
                msg.discoveryMode === "safer" || msg.discoveryMode === "deeper"
                  ? msg.discoveryMode
                  : "balanced",
              configured: true,
            });
            writeStoredDiscoveryData(normalized, authUser?.id);
            return normalized;
          });
        } else {
          setData((prev) =>
            normalizeDiscoveryData({
              ...(prev || {}),
              isUpdating: false,
              updatePhase: null,
              updateProgress: null,
              updateProgressMessage: null,
              playlistsUpdating:
                typeof msg.playlistsUpdating === "boolean"
                  ? msg.playlistsUpdating
                  : prev?.playlistsUpdating,
              playlistsUpdateMessage:
                msg.playlistsUpdateMessage ?? prev?.playlistsUpdateMessage ?? null,
              stale: false,
            }),
          );
        }
        getDiscovery(true)
          .then((discoveryData) => {
            applyDiscoveryData(discoveryData);
            setError(null);
          })
          .catch(() => {});
      }
    },
  );

  useEffect(() => {
    if (!isDiscoverySocketConnected) return;
    if (!data?.isUpdating && !data?.stale) return;
    getDiscovery()
      .then((discoveryData) => {
        const normalizedData = normalizeDiscoveryData(discoveryData);
        setData(normalizedData);
        writeStoredDiscoveryData(normalizedData, authUser?.id);
        setError(null);
      })
      .catch(() => {});
  }, [authUser?.id, isDiscoverySocketConnected, data?.isUpdating, data?.stale]);

  useEffect(() => {
    if (!isDiscoverySocketConnected) return;
    if (!data?.playlistsUpdating) return;
    getDiscovery(true)
      .then((discoveryData) => {
        const normalizedData = normalizeDiscoveryData(discoveryData);
        setData(normalizedData);
        writeStoredDiscoveryData(normalizedData, authUser?.id);
        setError(null);
      })
      .catch(() => {});
  }, [authUser?.id, isDiscoverySocketConnected, data?.playlistsUpdating]);

  useEffect(() => {
    if (!data?.isUpdating) return;
    const hasRecentWsUpdate =
      Date.now() - lastDiscoveryWsMessageAtRef.current < 20000;
    if (isDiscoverySocketConnected && hasRecentWsUpdate) return;
    const pollDiscovery = () => {
      getDiscovery(true)
        .then((next) => {
          const normalizedData = normalizeDiscoveryData(next);
          setData(normalizedData);
          writeStoredDiscoveryData(normalizedData, authUser?.id);
          setError(null);
        })
        .catch(() => {});
    };
    pollDiscovery();
    const id = setInterval(pollDiscovery, 10000);
    return () => clearInterval(id);
  }, [authUser?.id, data?.isUpdating, isDiscoverySocketConnected]);

  useEffect(() => {
    if (!data?.stale || data?.isUpdating) return;
    if (isDiscoverySocketConnected) return;
    const id = setTimeout(() => {
      getDiscovery(true)
        .then((next) => {
          const normalizedData = normalizeDiscoveryData(next);
          setData(normalizedData);
          writeStoredDiscoveryData(normalizedData, authUser?.id);
          setError(null);
        })
        .catch(() => {});
    }, 15000);
    return () => clearTimeout(id);
  }, [authUser?.id, data?.stale, data?.isUpdating, isDiscoverySocketConnected]);

  useEffect(() => {
    if (!data) return;
    if (data.isUpdating && !data.stale) {
      lastDiscoveryWsMessageAtRef.current = 0;
    }
  }, [data, data?.isUpdating, data?.stale]);

  useEffect(() => {
    getDiscovery()
      .then((discoveryData) => {
        const normalizedData = normalizeDiscoveryData(discoveryData);
        setData(normalizedData);
        writeStoredDiscoveryData(normalizedData, authUser?.id);
        setError(null);
      })
      .catch((err) => {
        setError(
          err.response?.data?.message || "Failed to load discovery data",
        );
        setData({
          recommendations: [],
          globalTop: [],
          basedOn: [],
          topTags: [],
          topGenres: [],
          fallbackGenres: [],
          provider: "lastfm",
          capabilities: null,
          lastUpdated: null,
          isUpdating: false,
          stale: false,
          discoveryMode: "balanced",
          configured: false,
        });
      });

    getRecentlyAdded()
      .then((items) => {
        setRecentlyAdded(items);
        writeStoredRecentlyAdded(items, authUser?.id);
      })
      .catch(() => {});

    getRecentReleases()
      .then((items) => {
        setRecentReleases(items);
        writeStoredRecentReleases(items, authUser?.id);
      })
      .catch(() => {});
  }, [authUser?.id]);

  useEffect(() => {
    let cancelled = false;
    const loadBootstrapStatus = async () => {
      try {
        const bootstrap = await getBootstrapStatus();
        if (!cancelled) {
          setTicketmasterConfigured(!!bootstrap.ticketmasterConfigured);
        }
      } catch {
        if (!cancelled) {
          setTicketmasterConfigured(true);
        }
      }
    };
    loadBootstrapStatus();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    try {
      const storedMode = localStorage.getItem(DISCOVER_NEARBY_MODE_KEY);
      const storedZip = localStorage.getItem(DISCOVER_NEARBY_ZIP_KEY) || "";
      if (storedMode === "zip" || storedMode === "ip") {
        setNearbyLocationMode(storedMode);
      }
      setAppliedNearbyZip(storedZip);
    } catch {}
  }, [authUser?.id]);

  useEffect(() => {
    if (!ticketmasterConfigured) {
      setNearbyShowsData(null);
      setNearbyShowsError(null);
      setNearbyShowsLoading(false);
      return;
    }
    const shouldUseZip = nearbyLocationMode === "zip";
    if (shouldUseZip && !appliedNearbyZip.trim()) {
      setNearbyShowsData(null);
      setNearbyShowsError(null);
      setNearbyShowsLoading(false);
      return;
    }
    const locationMode = shouldUseZip ? "zip" : "ip";
    const locationZip = shouldUseZip ? appliedNearbyZip : "";
    const cachedNearbyShows = readStoredNearbyShows(
      authUser?.id,
      locationMode,
      locationZip,
    );
    if (cachedNearbyShows) {
      setNearbyShowsData(cachedNearbyShows);
    }
    let cancelled = false;
    setNearbyShowsLoading(!cachedNearbyShows);
    setNearbyShowsError(null);
    getNearbyShows(locationZip)
      .then((response) => {
        if (cancelled) return;
        setNearbyShowsData(response);
        writeStoredNearbyShows(
          response,
          authUser?.id,
          locationMode,
          locationZip,
        );
        setNearbyShowsError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        if (!cachedNearbyShows) {
          setNearbyShowsError(
            err.response?.data?.message || "Failed to load nearby shows",
          );
        }
      })
      .finally(() => {
        if (!cancelled) {
          setNearbyShowsLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    authUser?.id,
    nearbyLocationMode,
    appliedNearbyZip,
    ticketmasterConfigured,
  ]);

  useEffect(() => {
    const ids = recentReleases
      .filter((album) => !album.coverUrl)
      .map((album) => album.mbid || album.foreignAlbumId)
      .filter(Boolean);
    const missing = ids.filter(
      (id) => !releaseCovers[id] && !requestedReleaseCoversRef.current.has(id),
    );
    missing.forEach((id) => {
      requestedReleaseCoversRef.current.add(id);
      const release = recentReleases.find(
        (album) => (album.mbid || album.foreignAlbumId) === id,
      );
      getReleaseGroupCover(id, {
        artistName:
          release?.artistName || release?.artist || release?.artistCredit || "",
        albumTitle: release?.title || release?.albumName || "",
      })
        .then((data) => {
          if (data?.images?.length > 0) {
            const front =
              data.images.find((img) => img.front) || data.images[0];
            const url = front?.image;
            if (url) {
              setReleaseCovers((prev) => ({ ...prev, [id]: url }));
            }
          }
        })
        .catch(() => {})
        .finally(() => {
          requestedReleaseCoversRef.current.delete(id);
        });
    });
  }, [recentReleases, releaseCovers]);

  useEffect(() => {
    const missingArtistCovers = recentReleases.filter((album) => {
      const artistId = album.artistMbid || album.foreignArtistId;
      if (!artistId) return false;
      if (album.coverUrl) return false;
      const releaseId = album.mbid || album.foreignAlbumId;
      if (releaseId && releaseCovers[releaseId]) return false;
      if (artistCovers[artistId]) return false;
      return !requestedArtistCoversRef.current.has(artistId);
    });

    missingArtistCovers.forEach((album) => {
      const artistId = album.artistMbid || album.foreignArtistId;
      if (!artistId) return;
      requestedArtistCoversRef.current.add(artistId);
      getArtistCover(artistId, album.artistName)
        .then((data) => {
          if (data?.images?.length > 0) {
            const front =
              data.images.find((img) => img.front) || data.images[0];
            const url = front?.image;
            if (url) {
              setArtistCovers((prev) => ({ ...prev, [artistId]: url }));
            }
          }
        })
        .catch(() => {})
        .finally(() => {
          requestedArtistCoversRef.current.delete(artistId);
        });
    });
  }, [recentReleases, releaseCovers, artistCovers]);

  const getLibraryArtistImage = (artist) => {
    if (artist.images && artist.images.length > 0) {
      const posterImage = artist.images.find(
        (img) => img.coverType === "poster" || img.coverType === "fanart",
      );
      const image = posterImage || artist.images[0];
      return image?.remoteUrl || image?.url || null;
    }
    return null;
  };

  const genreSections = useMemo(() => {
    if (Array.isArray(data?.fallbackGenres) && data.fallbackGenres.length > 0) {
      return data.fallbackGenres
        .map((section) => ({
          genre: section.name,
          artists: Array.isArray(section.artists) ? section.artists : [],
          fallback: true,
        }))
        .filter((section) => section.genre && section.artists.length > 0)
        .slice(0, 6);
    }

    if (!data?.topGenres || !data?.recommendations) return [];

    const sections = [];
    const usedArtistIds = new Set(
      (data.recommendations || [])
        .slice(0, DISCOVER_PREVIEW_ITEM_LIMIT)
        .map((artist) => getArtistId(artist))
        .filter(Boolean),
    );

    const sortedGenres = [...data.topGenres];
    const candidatePool = [...(data.recommendations || [])].slice(8);

    for (const genre of sortedGenres) {
      if (sections.length >= 4) break;

      const genreArtists = candidatePool.filter((artist) => {
        const artistId = getArtistId(artist);
        if (artistId && usedArtistIds.has(artistId)) return false;

        const artistTags = artist.matchedTags || artist.tags || [];
        return artistTags.some((tag) =>
          tag.toLowerCase().includes(genre.toLowerCase()),
        );
      });

      if (genreArtists.length >= 4) {
        const selectedArtists = genreArtists
          .sort((left, right) => {
            const leftScore = Number(left.scoreTotal || left.score || 0);
            const rightScore = Number(right.scoreTotal || right.score || 0);
            if (rightScore !== leftScore) return rightScore - leftScore;
            return String(left.name || "").localeCompare(
              String(right.name || ""),
            );
          })
          .slice(0, DISCOVER_PREVIEW_ITEM_LIMIT);

        selectedArtists.forEach((artist) => {
          const artistId = getArtistId(artist);
          if (artistId) usedArtistIds.add(artistId);
        });

        sections.push({
          genre,
          artists: selectedArtists,
        });
      }
    }

    return sections;
  }, [data]);

  const hasData =
    data &&
    ((data.recommendations && data.recommendations.length > 0) ||
      (data.globalTop && data.globalTop.length > 0) ||
      (data.topGenres && data.topGenres.length > 0) ||
      (data.fallbackGenres && data.fallbackGenres.length > 0));
  const isActuallyUpdating = data?.isUpdating && !hasData;

  const {
    recommendations = [],
    globalTop = [],
    topGenres = [],
    basedOn = [],
    discoverPlaylists = [],
    provider = "lastfm",
    capabilities,
    lastUpdated,
    isUpdating,
    updateProgressMessage,
    playlistsUpdating,
    playlistsUpdateMessage,
    configured = true,
  } = data || {};
  const [adoptedFlowIds, setAdoptedFlowIds] = useState({});
  const [adoptedStaticPlaylistIds, setAdoptedStaticPlaylistIds] = useState({});
  const isListenBrainzFallback = provider === "listenbrainz-fallback";

  const nearbyShows = nearbyShowsData?.shows || [];
  const nearbyLocationLabel =
    nearbyShowsData?.location?.label ||
    nearbyShowsData?.location?.postalCode ||
    "your area";
  const displayDiscoverPlaylists = useMemo(
    () =>
      discoverPlaylists.map((playlist) => ({
        ...playlist,
        adoptedFlowId:
          playlist.adoptedFlowId || adoptedFlowIds[playlist.presetId] || null,
        adoptedPlaylistId:
          playlist.adoptedPlaylistId ||
          adoptedStaticPlaylistIds[playlist.presetId] ||
          null,
      })),
    [adoptedFlowIds, adoptedStaticPlaylistIds, discoverPlaylists],
  );

  useEffect(() => {
    setAdoptedFlowIds((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const playlist of discoverPlaylists) {
        if (playlist.adoptedFlowId) {
          if (next[playlist.presetId] !== playlist.adoptedFlowId) {
            next[playlist.presetId] = playlist.adoptedFlowId;
            changed = true;
          }
        } else if (next[playlist.presetId]) {
          delete next[playlist.presetId];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    setAdoptedStaticPlaylistIds((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const playlist of discoverPlaylists) {
        if (playlist.adoptedPlaylistId) {
          if (next[playlist.presetId] !== playlist.adoptedPlaylistId) {
            next[playlist.presetId] = playlist.adoptedPlaylistId;
            changed = true;
          }
        } else if (next[playlist.presetId]) {
          delete next[playlist.presetId];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [discoverPlaylists]);

  const handleFlowAdopted = useCallback((presetId, flowId) => {
    if (!presetId || !flowId) return;
    setAdoptedFlowIds((prev) => ({ ...prev, [presetId]: flowId }));
  }, []);

  const handleStaticPlaylistAdopted = useCallback((presetId, playlistId) => {
    if (!presetId || !playlistId) return;
    setAdoptedStaticPlaylistIds((prev) => ({
      ...prev,
      [presetId]: playlistId,
    }));
  }, []);

  const sectionAvailability = useMemo(
    () => ({
      recentlyAdded: recentlyAdded.length > 0,
      playlists: displayDiscoverPlaylists.length > 0 || !!playlistsUpdating,
      recentReleases: recentReleases.length > 0,
      recommended:
        !isListenBrainzFallback &&
        (recommendations.length > 0 ||
          isUpdating ||
          capabilities?.personalizedRecommendations !== false),
      recommendedShows: ticketmasterConfigured,
      globalTop: globalTop.length > 0,
      genreSections: genreSections.length > 0,
    }),
    [
      recentlyAdded,
      displayDiscoverPlaylists,
      playlistsUpdating,
      recentReleases,
      globalTop,
      genreSections,
      recommendations,
      capabilities,
      isListenBrainzFallback,
      isUpdating,
      ticketmasterConfigured,
    ],
  );

  const fallbackGenreSections = useMemo(
    () =>
      isListenBrainzFallback
        ? genreSections.map((section) => ({
            id: getFallbackGenreSectionId(section.genre),
            label: `Top ${section.genre} Artists`,
            enabled: true,
          }))
        : [],
    [genreSections, isListenBrainzFallback],
  );

  const displayDiscoverSections = useMemo(() => {
    const sectionsById = new Map(
      discoverSections.map((item) => [item.id, item]),
    );
    if (!isListenBrainzFallback) {
      return discoverSections.filter(
        (item) => !getFallbackGenreFromSectionId(item.id),
      );
    }

    const dynamicGenresById = new Map(
      fallbackGenreSections.map((section) => [section.id, section]),
    );
    const nextSections = [];
    const seenGenreIds = new Set();
    let lastGenreIndex = -1;

    for (const item of discoverSections) {
      if (
        item.id === "recommended" ||
        item.id === "recommendedShows" ||
        item.id === "genreSections"
      ) {
        continue;
      }

      const fallbackGenre = getFallbackGenreFromSectionId(item.id);
      if (fallbackGenre) {
        const dynamicSection = dynamicGenresById.get(item.id);
        if (!dynamicSection || seenGenreIds.has(item.id)) continue;
        seenGenreIds.add(item.id);
        lastGenreIndex = nextSections.length;
        nextSections.push({
          ...dynamicSection,
          enabled: item.enabled,
        });
        continue;
      }

      nextSections.push(item);
    }

    const missingGenreSections = fallbackGenreSections
      .filter((section) => !seenGenreIds.has(section.id))
      .map((section) => ({
        ...section,
        enabled:
          sectionsById.get("genreSections")?.enabled ??
          sectionsById.get(section.id)?.enabled ??
          section.enabled,
      }));

    const insertionIndex = lastGenreIndex >= 0 ? lastGenreIndex + 1 : -1;
    nextSections.splice(
      insertionIndex === -1 ? nextSections.length : insertionIndex,
      0,
      ...missingGenreSections,
    );
    return nextSections;
  }, [discoverSections, fallbackGenreSections, isListenBrainzFallback]);

  const heroBasedOn = useMemo(() => {
    if (basedOn && basedOn.length > 0) return basedOn;
    const seen = new Set();
    const names = [];
    for (const r of recommendations || []) {
      const name = r.sourceArtist || r.source;
      if (name && !seen.has(name)) {
        seen.add(name);
        names.push({ name });
      }
    }
    return names;
  }, [basedOn, recommendations]);

  const navigateToBasedOnArtist = useCallback(
    (artist) => {
      const routeId =
        artist?.id ||
        artist?.mbid ||
        (artist?.name ? encodeURIComponent(artist.name) : "");
      if (!routeId) return;
      navigate(`/artist/${routeId}`, {
        state: { artistName: artist.name },
      });
    },
    [navigate],
  );

  const discoverArtistIds = useMemo(() => {
    const ids = new Set();
    for (const artist of data?.recommendations || []) {
      const id = getArtistId(artist);
      if (id) ids.add(id);
    }
    for (const artist of data?.globalTop || []) {
      const id = getArtistId(artist);
      if (id) ids.add(id);
    }
    for (const section of genreSections) {
      for (const artist of section.artists || []) {
        const id = getArtistId(artist);
        if (id) ids.add(id);
      }
    }
    for (const artist of recentlyAdded) {
      const id = artist?.foreignArtistId || artist?.mbid || artist?.id;
      if (id) ids.add(id);
    }
    return [...ids];
  }, [data, genreSections, recentlyAdded]);

  const discoverArtistIdsKey = discoverArtistIds.join(",");

  useEffect(() => {
    if (discoverArtistIds.length === 0) return;
    const cached = readLibraryLookupCache(discoverArtistIds);
    if (Object.keys(cached).length > 0) {
      setLibraryLookup((prev) => ({ ...prev, ...cached }));
    }
    const missing = discoverArtistIds.filter((id) => cached[id] === undefined);
    if (missing.length === 0) return;
    let cancelled = false;
    const fetchLookup = async () => {
      try {
        const lookup = await lookupArtistsInLibraryBatch(missing);
        if (!cancelled && lookup) {
          setLibraryLookup((prev) => ({ ...prev, ...lookup }));
        }
      } catch {}
    };
    fetchLookup();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [discoverArtistIdsKey]);

  const openDiscoverModal = () => {
    setDraftSections(displayDiscoverSections.map((item) => ({ ...item })));
    setShowDiscoverModal(true);
  };

  const handleDiscoverSave = () => {
    saveDiscoverLayout(draftSections).catch(() => {});
  };

  const handleDiscoverReset = () => {
    setDraftSections(
      isListenBrainzFallback
        ? displayDiscoverSections.map((item) => ({ ...item, enabled: true }))
        : DEFAULT_DISCOVER_SECTIONS.map((item) => ({ ...item })),
    );
  };

  const handleAddArtistToLibrary = useCallback(
    async (artist) => {
      const artistId = getArtistId(artist);
      if (!artist?.name || !artistId) return false;
      try {
        await addArtistToLibrary({
          foreignArtistId: artistId,
          artistName: artist.name,
        });
        setLibraryLookup((prev) => ({
          ...prev,
          [artistId]: true,
        }));
        showSuccess(`Adding ${artist.name}...`);
        return true;
      } catch (err) {
        showError(
          err.response?.data?.message ||
            err.response?.data?.error ||
            err.message ||
            "Failed to add artist to library",
        );
        return false;
      }
    },
    [showError, showSuccess],
  );

  const getRecentReleaseKey = useCallback(
    (album) => album.mbid || album.foreignAlbumId || album.id,
    [],
  );

  const handleRecentReleaseAlbumAction = useCallback(
    async (album) => {
      const albumKey = getRecentReleaseKey(album);
      if (!album?.id || !album?.artistId || !albumKey) return;
      setPendingRecentReleaseIds((prev) => ({ ...prev, [albumKey]: true }));
      try {
        await updateLibraryAlbum(album.id, {
          ...album,
          monitored: true,
        });
        await downloadAlbum(album.artistId, album.id, {
          artistMbid: album.artistMbid || album.foreignArtistId,
          artistName: album.artistName,
        });
        showSuccess(`Searching for ${album.albumName || "album"}`);
      } catch (err) {
        showError(
          err.response?.data?.message ||
            err.response?.data?.error ||
            err.message ||
            "Failed to request album",
        );
      } finally {
        setPendingRecentReleaseIds((prev) => {
          const next = { ...prev };
          delete next[albumKey];
          return next;
        });
      }
    },
    [getRecentReleaseKey, showError, showSuccess],
  );

  const handleDiscoveryFeedback = useCallback(
    (artist, action, options = {}) => submitFeedback(artist, action, options),
    [submitFeedback],
  );

  const renderSection = (id) => {
    const fallbackGenre = getFallbackGenreFromSectionId(id);
    if (fallbackGenre) {
      const section = genreSections.find(
        (item) => item.genre === fallbackGenre,
      );
      if (!section || section.artists.length === 0) return null;
      return (
        <DiscoverRail
          key={id}
          title={`Top ${section.genre} Artists`}
          mobileTitle={section.genre}
          onViewAll={() =>
            navigate(
              `/search?q=${encodeURIComponent(`#${section.genre}`)}&type=tag`,
            )
          }
        >
          <>
            {section.artists
              .slice(0, DISCOVER_PREVIEW_ITEM_LIMIT)
              .map((artist) => (
                <div
                  key={`${section.genre}-${artist.id}`}
                  className="artist-discover-shelf-card"
                >
                  <ArtistCard
                    artist={artist}
                    isInLibrary={!!libraryLookup[getArtistId(artist)]}
                    canAddArtist={canAddArtist}
                    onNavigate={navigate}
                    onAddToLibrary={handleAddArtistToLibrary}
                    onFeedback={handleDiscoveryFeedback}
                    feedbackUsed={getArtistFeedbackFlags(
                      artistFeedbackLookup,
                      artist,
                    )}
                  />
                </div>
              ))}
            <div className="artist-discover-shelf-card">
              <ViewAllCard
                onClick={() =>
                  navigate(
                    `/search?q=${encodeURIComponent(`#${section.genre}`)}&type=tag`,
                  )
                }
              />
            </div>
          </>
        </DiscoverRail>
      );
    }

    if (id === "recentlyAdded") {
      if (!sectionAvailability.recentlyAdded) return null;
      return (
        <DiscoverRail key="recentlyAdded" title="Recently Added">
          <>
            {recentlyAdded
              .slice(0, DISCOVER_PREVIEW_ITEM_LIMIT)
              .map((artist) => {
                const artistId =
                  artist.foreignArtistId || artist.mbid || artist.id;
                return (
                  <div
                    key={`artist-${artist.id}`}
                    className="artist-discover-shelf-card"
                  >
                    <ArtistCard
                      status="available"
                      isInLibrary={!!libraryLookup[artistId]}
                      canAddArtist={false}
                      onNavigate={navigate}
                      artist={{
                        id: artistId,
                        name: artist.artistName,
                        image: getLibraryArtistImage(artist),
                        type: "Artist",
                        metaText: "",
                        subtitle: `Added ${new Date(
                          artist.added || artist.addedAt,
                        ).toLocaleDateString()}`,
                      }}
                    />
                  </div>
                );
              })}
          </>
        </DiscoverRail>
      );
    }

    if (id === "playlists") {
      if (!sectionAvailability.playlists) return null;
      return (
        <DiscoverPlaylistSection
          key="playlists"
          playlists={displayDiscoverPlaylists}
          artworkVersion={lastUpdated}
          canAdopt={canAdoptPlaylist}
          playlistsUpdating={playlistsUpdating}
          playlistsUpdateMessage={playlistsUpdateMessage}
          onFlowAdopted={handleFlowAdopted}
          onPlaylistAdopted={handleStaticPlaylistAdopted}
        />
      );
    }

    if (id === "recentReleases") {
      if (!sectionAvailability.recentReleases) return null;
      return (
        <DiscoverRail key="recentReleases" title="Recent & Upcoming Releases">
          <>
            {recentReleases
              .slice(0, DISCOVER_PREVIEW_ITEM_LIMIT)
              .map((album) => (
                <div
                  key={album.id || album.mbid || album.foreignAlbumId}
                  className="artist-discover-shelf-card"
                >
                  <AlbumCard
                    album={album}
                    releaseCovers={releaseCovers}
                    artistCovers={artistCovers}
                    onNavigate={navigate}
                    canAddAlbum={canAddAlbum}
                    isPending={!!pendingRecentReleaseIds[getRecentReleaseKey(album)]}
                    onAlbumAction={handleRecentReleaseAlbumAction}
                  />
                </div>
              ))}
          </>
        </DiscoverRail>
      );
    }

    if (id === "recommended") {
      if (!sectionAvailability.recommended) return null;
      if (recommendations.length > 0) {
        return (
          <DiscoverRail
            key="recommended"
            title="Recommended for You"
            onViewAll={() => navigate("/search?type=recommended")}
          >
            <>
              {recommendations
                .slice(0, DISCOVER_PREVIEW_ITEM_LIMIT)
                .map((artist) => (
                  <div key={artist.id} className="artist-discover-shelf-card">
                    <ArtistCard
                      artist={artist}
                      isInLibrary={!!libraryLookup[getArtistId(artist)]}
                      canAddArtist={canAddArtist}
                      onNavigate={navigate}
                      onAddToLibrary={handleAddArtistToLibrary}
                      onFeedback={handleDiscoveryFeedback}
                      feedbackUsed={getArtistFeedbackFlags(
                        artistFeedbackLookup,
                        artist,
                      )}
                    />
                  </div>
                ))}
              <div className="artist-discover-shelf-card">
                <ViewAllCard
                  onClick={() => navigate("/search?type=recommended")}
                />
              </div>
            </>
          </DiscoverRail>
        );
      }

      const recommendedStatusTitle = isUpdating
        ? "Building your recommendations"
        : "Not enough listening data yet";
      const recommendedStatusMessage = isUpdating
        ? updateProgressMessage ||
          "Scanning your library and Last.fm history. The first setup can take up to 10 minutes."
        : provider === "lastfm"
          ? "Add artists to your library or keep scrobbling on Last.fm. Recommendations improve as Aurral learns your taste."
          : "Add artists to your library or connect Last.fm in Settings to unlock personalized recommendations.";

      return (
        <section key="recommended" className="artist-discover-section">
          <h2 className="artist-section-title--discover discover-recommended-status__title">
            <span className="artist-section-title--discover-mobile">
              Recommended
            </span>
            <span className="artist-section-title--discover-desktop">
              Recommended for You
            </span>
          </h2>
          <div
            className={`discover-recommended-status${isUpdating ? " discover-recommended-status--loading" : ""}`}
          >
            {isUpdating ? (
              <Loader className="discover-recommended-status__spinner animate-spin" />
            ) : (
              <div
                className="discover-recommended-status__icon"
                aria-hidden="true"
              >
                <Music className="artist-icon-lg" />
              </div>
            )}
            <h3 className="discover-recommended-status__heading">
              {recommendedStatusTitle}
            </h3>
            <p className="discover-recommended-status__message">
              {recommendedStatusMessage}
            </p>
            {!isUpdating ? (
              <div className="discover-recommended-status__actions">
                <button
                  type="button"
                  onClick={() => navigate("/search")}
                  className="btn btn-primary btn--bold btn-min-h"
                >
                  Search Artists
                </button>
                <button
                  type="button"
                  onClick={() => navigate("/library")}
                  className="btn btn-secondary btn--bold btn-min-h"
                >
                  Browse Library
                </button>
              </div>
            ) : null}
          </div>
        </section>
      );
    }

    if (id === "recommendedShows") {
      if (!sectionAvailability.recommendedShows) return null;
      const zipModeActive = nearbyLocationMode === "zip";
      const nearbyHeaderActions =
        nearbyShowsData?.configured !== false ? (
          <NearbyLocationControl
            locationMode={nearbyLocationMode}
            appliedZip={appliedNearbyZip}
            location={nearbyShowsData?.location}
            onSelectYourLocation={() => {
              setNearbyLocationMode("ip");
              try {
                localStorage.setItem(DISCOVER_NEARBY_MODE_KEY, "ip");
              } catch {}
            }}
            onStartCustomLocation={() => {
              setNearbyLocationMode("zip");
              try {
                localStorage.setItem(DISCOVER_NEARBY_MODE_KEY, "zip");
              } catch {}
            }}
            onApplyZip={(sanitized) => {
              setAppliedNearbyZip(sanitized);
              setNearbyLocationMode("zip");
              try {
                localStorage.setItem(DISCOVER_NEARBY_MODE_KEY, "zip");
                localStorage.setItem(DISCOVER_NEARBY_ZIP_KEY, sanitized);
              } catch {}
            }}
          />
        ) : null;
      if (nearbyShowsData?.configured === false) {
        return (
          <section key="recommendedShows" className="artist-discover-section">
            <div className="artist-nearby-status">
              <h3 className="artist-nearby-status__title">
                Ticketmaster not configured
              </h3>
              <p className="artist-nearby-status__text">
                Add a Ticketmaster Consumer Key in Settings to enable local show
                discovery on this page.
              </p>
              <button
                type="button"
                onClick={() => navigate("/settings")}
                className="btn btn-primary"
                style={{ marginTop: "1rem" }}
              >
                Open Settings
              </button>
            </div>
          </section>
        );
      }

      if (nearbyShowsLoading && !nearbyShowsData) {
        return (
          <section key="recommendedShows" className="artist-discover-section">
            <div className="artist-nearby-status artist-nearby-status--loading">
              <Loader className="artist-nearby-status__spinner animate-spin" />
            </div>
          </section>
        );
      }

      if (nearbyShowsError) {
        return (
          <section key="recommendedShows" className="artist-discover-section">
            <div className="artist-nearby-status">
              <h3 className="artist-nearby-status__title">
                Unable to load nearby shows
              </h3>
              <p className="artist-nearby-status__text">{nearbyShowsError}</p>
            </div>
          </section>
        );
      }

      if (zipModeActive && !appliedNearbyZip.trim()) {
        return (
          <DiscoverRail
            key="recommendedShows"
            title="Shows Near You"
            onViewAll={() => navigate("/shows")}
            headerActions={nearbyHeaderActions}
          >
            <div className="artist-nearby-status">
              <h3 className="artist-nearby-status__title">Location not set</h3>
              <p className="artist-nearby-status__text">
                Open the location menu and enter a ZIP or postal code, or choose
                Your location.
              </p>
            </div>
          </DiscoverRail>
        );
      }

      if (nearbyShows.length > 0) {
        return (
          <DiscoverRail
            key="recommendedShows"
            title="Shows Near You"
            onViewAll={() => navigate("/shows")}
            headerActions={nearbyHeaderActions}
          >
            <>
              {nearbyShows.slice(0, DISCOVER_PREVIEW_ITEM_LIMIT).map((show) => (
                <div
                  key={`${show.id}-${show.artistName}-${show.sourceType || show.matchType || "show"}`}
                  className="artist-discover-show-rail-card"
                >
                  <ShowCard show={show} />
                </div>
              ))}
            </>
          </DiscoverRail>
        );
      }

      return (
        <section key="recommendedShows" className="artist-discover-section">
          <div className="artist-nearby-status">
            <h3 className="artist-nearby-status__title">
              No upcoming nearby matches
            </h3>
            <p className="artist-nearby-status__text">
              We could not find local Ticketmaster shows tied to your library or
              current recommendations around {nearbyLocationLabel}.
            </p>
          </div>
        </section>
      );
    }

    if (id === "globalTop") {
      if (!sectionAvailability.globalTop) return null;
      return (
        <DiscoverRail
          key="globalTop"
          title="Global Trending"
          onViewAll={() => navigate("/search?type=trending")}
        >
          <>
            {globalTop.slice(0, DISCOVER_PREVIEW_ITEM_LIMIT).map((artist) => (
              <div key={artist.id} className="artist-discover-shelf-card">
                <ArtistCard
                  artist={{
                    ...artist,
                    metaText: "",
                  }}
                  isInLibrary={!!libraryLookup[getArtistId(artist)]}
                  canAddArtist={canAddArtist}
                  onNavigate={navigate}
                  onAddToLibrary={handleAddArtistToLibrary}
                  onFeedback={handleDiscoveryFeedback}
                  feedbackUsed={getArtistFeedbackFlags(
                    artistFeedbackLookup,
                    artist,
                  )}
                />
              </div>
            ))}
            <div className="artist-discover-shelf-card">
              <ViewAllCard onClick={() => navigate("/search?type=trending")} />
            </div>
          </>
        </DiscoverRail>
      );
    }

    if (id === "genreSections") {
      if (!sectionAvailability.genreSections) return null;
      return (
        <div key="genreSections">
          {genreSections.map((section) => (
            <DiscoverRail
              key={section.genre}
              title={
                section.fallback
                  ? `Top ${section.genre} Artists`
                  : `Because You Like ${section.genre}`
              }
              mobileTitle={section.genre}
              onViewAll={() =>
                navigate(
                  `/search?q=${encodeURIComponent(`#${section.genre}`)}&type=tag`,
                )
              }
            >
              <>
                {section.artists
                  .slice(0, DISCOVER_PREVIEW_ITEM_LIMIT)
                  .map((artist) => (
                    <div
                      key={`${section.genre}-${artist.id}`}
                      className="artist-discover-shelf-card"
                    >
                      <ArtistCard
                        artist={artist}
                        isInLibrary={!!libraryLookup[getArtistId(artist)]}
                        canAddArtist={canAddArtist}
                        onNavigate={navigate}
                        onAddToLibrary={handleAddArtistToLibrary}
                        onFeedback={handleDiscoveryFeedback}
                        feedbackUsed={getArtistFeedbackFlags(
                          artistFeedbackLookup,
                          artist,
                        )}
                      />
                    </div>
                  ))}
                <div className="artist-discover-shelf-card">
                  <ViewAllCard
                    onClick={() =>
                      navigate(
                        `/search?q=${encodeURIComponent(`#${section.genre}`)}&type=tag`,
                      )
                    }
                  />
                </div>
              </>
            </DiscoverRail>
          ))}
        </div>
      );
    }

    return null;
  };

  if (data === null && !error) {
    return (
      <div className="artist-loading--discover">
        <Loader className="artist-spinner--discover animate-spin" />
        <h2 className="artist-error-title--discover">
          Loading recommendations...
        </h2>
        <p className="artist-error-copy--discover">
          Recommendations will appear as they load.
        </p>
      </div>
    );
  }

  if (isActuallyUpdating) {
    return (
      <div className="artist-loading--discover">
        <Loader className="artist-spinner--discover animate-spin" />
        <h2 className="artist-error-title--discover">
          {isListenBrainzFallback
            ? "Loading ListenBrainz discovery..."
            : "Building your recommendations..."}
        </h2>
        <p className="artist-error-copy--discover">
          {isListenBrainzFallback
            ? "The app is loading trending artists and default genre shelves."
            : "The app is scanning your library and Last.fm data. Please wait. This can take up to 10 minutes when Last.fm is configured. The page will update when ready."}
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="artist-error-panel--discover">
        <Sparkles className="artist-error-icon--discover" />
        <h2 className="artist-error-title--discover">
          Unable to load discovery
        </h2>
        <p className="artist-empty-message--discover">{error}</p>
        <button
          onClick={() => window.location.reload()}
          className="btn btn-primary"
        >
          Try Again
        </button>
      </div>
    );
  }

  if (
    configured === false &&
    !recommendations.length &&
    !globalTop.length &&
    !topGenres.length
  ) {
    return (
      <div className="artist-empty-panel--discover-not-configured">
        <div className="artist-error-icon">
          <Sparkles className="artist-icon-lg" />
        </div>
        <h2 className="artist-error-title">Discovery Not Configured</h2>
        <p className="artist-empty-message">
          To see music recommendations, you need at least one of:
        </p>
        <ul>
          <li>
            <span>•</span>
            <span>Add artists to your library, or</span>
          </li>
          <li>
            <span>•</span>
            <span>Configure Last.fm (API key and username) in Settings</span>
          </li>
        </ul>
        <button
          onClick={() => navigate("/settings")}
          className="btn btn-primary"
        >
          Go to Settings
        </button>
      </div>
    );
  }

  return (
    <div className="artist-discover-page">
      <LastfmBanner />
      <section className="artist-discover-hero">
        <div className="artist-discover-hero__content">
          <div className="artist-discover-hero__header">
            <div className="artist-discover-hero__title-wrap">
              <div className="artist-discover-hero__title-row">
                <h1 className="artist-discover-hero__title">Discover</h1>
                {(isUpdating || lastUpdated) && (
                  <span
                    className={`artist-discover-hero__updated${isUpdating ? " artist-discover-hero__updated--refreshing" : ""}`}
                  >
                    {isUpdating ? (
                      <Loader className="artist-discover-hero__updated-icon animate-spin" />
                    ) : (
                      <Clock className="artist-discover-hero__updated-icon" />
                    )}
                    {isUpdating
                      ? updateProgressMessage || "Refreshing discovery..."
                      : `Updated ${new Date(lastUpdated).toLocaleDateString()}`}
                  </span>
                )}
              </div>
              <p className="artist-discover-hero__description">
                Your daily mix, curated from your library.
              </p>
              {heroBasedOn.length > 0 && (
                <div className="artist-discover-hero__based-on">
                  <div className="artist-discover-hero__based-on-intro">
                    Based on:
                  </div>
                  {showFullBasedOnList ? (
                    <div className="artist-discover-hero__artists-expanded">
                      {heroBasedOn.map((artist, index) => (
                        <button
                          key={index}
                          onClick={() => navigateToBasedOnArtist(artist)}
                          className="artist-discover-hero__artist-tag"
                        >
                          {artist.name}
                        </button>
                      ))}
                      <button
                        onClick={() => setShowFullBasedOnList(false)}
                        className="artist-discover-hero__view-toggle-badge"
                      >
                        view less
                      </button>
                    </div>
                  ) : (
                    <div className="artist-discover-hero__artists-collapsed">
                      {heroBasedOn.length === 1 ? (
                        <button
                          onClick={() =>
                            navigateToBasedOnArtist(heroBasedOn[0])
                          }
                          className="artist-discover-hero__artist-tag"
                        >
                          {heroBasedOn[0].name}
                        </button>
                      ) : heroBasedOn.length === 4 ? (
                        <>
                          <button
                            onClick={() =>
                              navigateToBasedOnArtist(heroBasedOn[0])
                            }
                            className="artist-discover-hero__artist-tag"
                          >
                            {heroBasedOn[0].name}
                          </button>
                          <button
                            onClick={() =>
                              navigateToBasedOnArtist(heroBasedOn[1])
                            }
                            className="artist-discover-hero__artist-tag"
                          >
                            {heroBasedOn[1].name}
                          </button>
                          <button
                            onClick={() =>
                              navigateToBasedOnArtist(heroBasedOn[2])
                            }
                            className="artist-discover-hero__artist-tag"
                          >
                            {heroBasedOn[2].name}
                          </button>
                          <button
                            onClick={() =>
                              navigateToBasedOnArtist(heroBasedOn[3])
                            }
                            className="artist-discover-hero__artist-tag"
                          >
                            {heroBasedOn[3].name}
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            onClick={() =>
                              navigateToBasedOnArtist(heroBasedOn[0])
                            }
                            className="artist-discover-hero__artist-tag"
                          >
                            {heroBasedOn[0].name}
                          </button>
                          <button
                            onClick={() =>
                              navigateToBasedOnArtist(heroBasedOn[1])
                            }
                            className="artist-discover-hero__artist-tag"
                          >
                            {heroBasedOn[1].name}
                          </button>
                          <button
                            onClick={() =>
                              navigateToBasedOnArtist(heroBasedOn[2])
                            }
                            className="artist-discover-hero__artist-tag"
                          >
                            {heroBasedOn[2].name}
                          </button>
                          <button
                            onClick={() =>
                              navigateToBasedOnArtist(heroBasedOn[3])
                            }
                            className="artist-discover-hero__artist-tag"
                          >
                            {heroBasedOn[3].name}
                          </button>
                          <button
                            onClick={() => setShowFullBasedOnList(true)}
                            className="artist-discover-hero__view-toggle-badge"
                          >
                            +{heroBasedOn.length - 4} more
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

            <button
              type="button"
              onClick={openDiscoverModal}
              className="btn btn-sm btn-surface discover-page__customize-btn"
            >
              <LayoutTemplate className="artist-discover-hero__customize-icon" />
              <span>Customize</span>
            </button>
          </div>

          <div className="artist-discover-hero__tags-section">
            {topGenres.length > 0 && (
              <div>
                <h3 className="artist-discover-hero__tags-section-title">
                  Top tags:
                </h3>
                <div className="artist-tag-list--discover">
                  {topGenres.slice(0, 30).map((genre, i) => (
                    <button
                      key={i}
                      onClick={() =>
                        navigate(
                          `/search?q=${encodeURIComponent(`#${genre}`)}&type=tag`,
                        )
                      }
                      className="artist-tag--discover"
                      style={{
                        backgroundColor: getTagColor(genre),
                      }}
                    >
                      #{genre}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </section>

      {displayDiscoverSections
        .filter((section) => section.enabled)
        .map((section) => renderSection(section.id))}

      <DiscoverLayoutModal
        open={showDiscoverModal}
        sections={draftSections}
        onSectionsChange={setDraftSections}
        sectionAvailability={sectionAvailability}
        isSaving={isSavingDiscoverLayout}
        onClose={() => setShowDiscoverModal(false)}
        onSave={handleDiscoverSave}
        onReset={handleDiscoverReset}
      />
    </div>
  );
}

export default DiscoverPage;

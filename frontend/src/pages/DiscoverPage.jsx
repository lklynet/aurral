import {
  useState,
  useEffect,
  useLayoutEffect,
  useMemo,
  memo,
  useCallback,
  useRef,
} from "react";
import { createPortal } from "react-dom";
import PropTypes from "prop-types";
import { useNavigate } from "react-router-dom";
import {
  Loader,
  Music,
  Sparkles,
  Clock,
  ChevronLeft,
  ChevronRight,
  LayoutTemplate,
  CheckCircle2,
  MoreVertical,
  Ban,
  Loader2,
  Library,
  ThumbsUp,
  ThumbsDown,
  EyeOff,
} from "lucide-react";
import {
  addArtistToLibrary,
  addDiscoveryFeedback,
  getDiscoveryFeedback,
  removeDiscoveryFeedback,
  getBlocklist,
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
  updateBlocklist,
} from "../utils/api";
import { useWebSocketChannel } from "../hooks/useWebSocket";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { useAuth } from "../contexts/AuthContext";
import {
  applyArtistDiscoveryFeedback,
  buildArtistFeedbackLookup,
  getArtistFeedbackFlags,
  getDiscoveryFeedbackLabel,
  normalizeDiscoveryFeedbackList,
} from "../utils/discoveryFeedback";
import ArtistImage from "../components/ArtistImage";
import NearbyLocationControl from "../components/NearbyLocationControl";
import ShowCard from "../components/ShowCard";
import LastfmBanner from "../components/LastfmBanner";
import { useToast } from "../contexts/ToastContext";
import { DiscoverLayoutModal } from "./DiscoverLayoutModal";

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
const MAIN_CONTENT_PORTAL_SELECTOR = ".app-main-wrap";

const getMainContentPortalRoot = () =>
  document.querySelector(MAIN_CONTENT_PORTAL_SELECTOR);

const getArtistId = (artist) =>
  artist?.id || artist?.mbid || artist?.foreignArtistId;
const MBID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const normalizeBlocklistArtists = (artists) => {
  const source = Array.isArray(artists) ? artists : [];
  const seen = new Set();
  const out = [];
  for (const entry of source) {
    if (!entry) continue;
    const entryMbid =
      typeof entry.mbid === "string" && MBID_REGEX.test(entry.mbid.trim())
        ? entry.mbid.trim()
        : null;
    const entryName = String(entry.name || "").trim();
    if (!entryMbid && !entryName) continue;
    const key = entryMbid
      ? `mbid:${entryMbid.toLowerCase()}`
      : `name:${entryName.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ mbid: entryMbid, name: entryName || null });
  }
  return out;
};

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
    provider: value.provider || "lastfm",
    capabilities:
      value.capabilities && typeof value.capabilities === "object"
        ? value.capabilities
        : null,
    lastUpdated: value.lastUpdated || null,
    isUpdating: !!value.isUpdating,
    stale: !!value.stale,
    discoveryMode:
      value.discoveryMode === "safer" || value.discoveryMode === "deeper"
        ? value.discoveryMode
        : "balanced",
    configured: typeof value.configured === "boolean" ? value.configured : true,
  };
};

const readStoredDiscoveryData = (userId) => {
  try {
    const primaryKey = getDiscoveryCacheStorageKey(userId);
    const primary = normalizeDiscoveryData(
      JSON.parse(localStorage.getItem(primaryKey) || "null"),
    );
    if (primary) return primary;
    if (primaryKey === DISCOVERY_CACHE_KEY) return null;
    return normalizeDiscoveryData(
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
      JSON.stringify(normalized),
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

const isArtistInEntries = (artist, entries) => {
  const list = Array.isArray(entries) ? entries : [];
  const artistMbid = String(getArtistId(artist) || "")
    .trim()
    .toLowerCase();
  const artistName = String(artist?.name || artist?.artistName || "")
    .trim()
    .toLowerCase();
  return list.some((entry) => {
    const entryMbid = String(entry?.mbid || "")
      .trim()
      .toLowerCase();
    const entryName = String(entry?.name || "")
      .trim()
      .toLowerCase();
    if (artistMbid && entryMbid && artistMbid === entryMbid) return true;
    if (artistName && entryName && artistName === entryName) return true;
    return false;
  });
};

const matchesBlockedArtist = (target, artist) => {
  const targetId = String(getArtistId(target) || "")
    .trim()
    .toLowerCase();
  const targetName = String(target?.name || target?.artistName || "")
    .trim()
    .toLowerCase();
  const artistId = String(getArtistId(artist) || "")
    .trim()
    .toLowerCase();
  const artistName = String(artist?.name || artist?.artistName || "")
    .trim()
    .toLowerCase();
  return (
    (targetId && artistId && targetId === artistId) ||
    (targetName && artistName && targetName === artistName)
  );
};

const filterDiscoveryDataByBlockedArtists = (value, blockedArtists) => {
  const normalized = normalizeDiscoveryData(value);
  if (!normalized) return normalized;
  const entries = Array.isArray(blockedArtists) ? blockedArtists : [];
  if (entries.length === 0) return normalized;
  return {
    ...normalized,
    recommendations: normalized.recommendations.filter(
      (artist) => !isArtistInEntries(artist, entries),
    ),
    globalTop: normalized.globalTop.filter(
      (artist) => !isArtistInEntries(artist, entries),
    ),
    fallbackGenres: normalized.fallbackGenres.map((section) => ({
      ...section,
      artists: (Array.isArray(section?.artists) ? section.artists : []).filter(
        (artist) => !isArtistInEntries(artist, entries),
      ),
    })),
  };
};

const parseCalendarDate = (value) => {
  if (!value) return null;
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) {
    const [, year, month, day] = match;
    return new Date(Number(year), Number(month) - 1, Number(day));
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
};

const formatReleaseStatus = (releaseDate) => {
  const date = parseCalendarDate(releaseDate);
  if (!date) return null;
  const today = new Date();
  const todayStart = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
  );
  const formattedDate = date.toLocaleDateString();
  if (date.getTime() === todayStart.getTime()) {
    return "Released today";
  }
  if (date < todayStart) {
    return `Released ${formattedDate}`;
  }
  return `Releasing ${formattedDate}`;
};

const getRecommendationReason = (artist) => {
  if (artist?.metaText !== undefined) return artist.metaText;
  const seedNames = Array.isArray(artist?.supportingSeeds)
    ? artist.supportingSeeds
        .map((seed) => seed?.artistName)
        .filter(Boolean)
        .slice(0, 2)
    : [];
  const matchedTags = Array.isArray(artist?.matchedTags)
    ? artist.matchedTags.filter(Boolean).slice(0, 2)
    : [];
  if (matchedTags.length >= 2) {
    return `${matchedTags[0]} + ${matchedTags[1]}`;
  }
  if (matchedTags.length === 1) {
    return matchedTags[0];
  }
  if (seedNames.length >= 2) {
    return `Because you listen to ${seedNames[0]} and ${seedNames[1]}`;
  }
  if (seedNames.length === 1) {
    return `Because you listen to ${seedNames[0]}`;
  }
  if (artist?.sourceArtist) {
    return `Similar to ${artist.sourceArtist}`;
  }
  return artist?.discoveryTier === "deeper"
    ? "A deeper discovery pick"
    : "Picked for your profile";
};

const ArtistCard = memo(
  ({
    artist,
    isInLibrary,
    isBlocked,
    canAddArtist,
    onNavigate,
    onAddToLibrary,
    onAddToBlocklist,
    onFeedback,
    feedbackUsed = {},
  }) => {
    const [showMenu, setShowMenu] = useState(false);
    const [pendingAction, setPendingAction] = useState(null);
    const menuRef = useRef(null);
    const menuButtonRef = useRef(null);
    const [menuPosition, setMenuPosition] = useState(null);
    const navigateTo = artist.navigateTo || artist.id;
    const hasValidMbid =
      navigateTo && navigateTo !== "null" && navigateTo !== "undefined";
    const artistMetaText = getRecommendationReason(artist);
    const handleClick = useCallback(() => {
      if (hasValidMbid) {
        onNavigate(`/artist/${navigateTo}`, {
          state: {
            artistName: artist.name,
            inLibrary: isInLibrary,
          },
        });
      }
    }, [navigateTo, hasValidMbid, artist.name, isInLibrary, onNavigate]);

    useEffect(() => {
      if (!showMenu) return;
      const handleClickOutside = (event) => {
        const clickedMenu = menuRef.current?.contains(event.target);
        const clickedButton = menuButtonRef.current?.contains(event.target);
        if (!clickedMenu && !clickedButton) {
          setShowMenu(false);
        }
      };
      document.addEventListener("mousedown", handleClickOutside);
      return () => {
        document.removeEventListener("mousedown", handleClickOutside);
      };
    }, [showMenu]);

    const estimateDiscoverMenuHeight = useCallback(() => {
      let items = 1;
      if (canAddArtist) items += 1;
      if (onFeedback) items += 4;
      return items * 42 + 8;
    }, [canAddArtist, onFeedback]);

    const updateMenuPosition = useCallback(() => {
      const button = menuButtonRef.current;
      const portalRoot = getMainContentPortalRoot();
      if (!button || !portalRoot) return;
      const wrapRect = portalRoot.getBoundingClientRect();
      const rect = button.getBoundingClientRect();
      const gap = 8;
      const menuHeight =
        menuRef.current?.offsetHeight || estimateDiscoverMenuHeight();
      const spaceAbove = rect.top - wrapRect.top - gap;
      const spaceBelow = wrapRect.bottom - rect.bottom - gap;
      let placement = "above";
      if (spaceAbove < menuHeight && spaceBelow >= menuHeight) {
        placement = "below";
      } else if (spaceAbove < menuHeight && spaceBelow < menuHeight) {
        placement = spaceBelow > spaceAbove ? "below" : "above";
      }
      const top =
        placement === "below"
          ? rect.bottom - wrapRect.top + gap
          : rect.top - wrapRect.top - gap;
      const left = Math.max(rect.right - wrapRect.left - 176, 12);
      setMenuPosition((prev) => {
        if (
          prev &&
          prev.top === top &&
          prev.left === left &&
          prev.placement === placement
        ) {
          return prev;
        }
        return { top, left, placement };
      });
    }, [estimateDiscoverMenuHeight]);

    useEffect(() => {
      if (!showMenu) {
        setMenuPosition(null);
        return;
      }
      updateMenuPosition();
      const scrollRoot = document.querySelector(".app-main");
      window.addEventListener("resize", updateMenuPosition);
      scrollRoot?.addEventListener("scroll", updateMenuPosition, {
        passive: true,
      });
      window.addEventListener("scroll", updateMenuPosition, true);
      return () => {
        window.removeEventListener("resize", updateMenuPosition);
        scrollRoot?.removeEventListener("scroll", updateMenuPosition);
        window.removeEventListener("scroll", updateMenuPosition, true);
      };
    }, [showMenu, updateMenuPosition]);

    useLayoutEffect(() => {
      if (!showMenu) return;
      updateMenuPosition();
    }, [showMenu, updateMenuPosition]);

    const handleAddToLibraryClick = async (event) => {
      event.stopPropagation();
      if (isInLibrary || !canAddArtist || pendingAction) return;
      setPendingAction("library");
      const added = await onAddToLibrary(artist);
      if (added) setShowMenu(false);
      setPendingAction(null);
    };

    const handleBlocklistClick = async (event) => {
      event.stopPropagation();
      if (isBlocked || pendingAction) return;
      setPendingAction("blocklist");
      const blocked = await onAddToBlocklist(artist);
      if (blocked) setShowMenu(false);
      setPendingAction(null);
    };

    const handleFeedbackClick = async (event, action) => {
      event.stopPropagation();
      if (!onFeedback || pendingAction) return;
      setPendingAction(action);
      const saved = await onFeedback(artist, action, {
        isSelected: !!feedbackUsed[action],
      });
      if (saved && action === "hide_for_now") setShowMenu(false);
      setPendingAction(null);
    };

    return (
      <div className="artist-discover-card">
        <div
          onClick={handleClick}
          className={`artist-discover-card__cover${hasValidMbid ? "" : " is-disabled"}`}
        >
          <ArtistImage
            src={artist.image || artist.imageUrl}
            mbid={artist.id}
            artistName={artist.name}
            alt={artist.name}
            className="artist-discover-card__image"
            showLoading={false}
          />
        </div>

        <div className="artist-discover-card__content">
          <div className="artist-discover-card__text">
            <div className="artist-card-title-row--discover">
              <h3
                onClick={handleClick}
                className={`artist-card-title--discover${hasValidMbid ? "" : " is-disabled"}`}
                title={artist.name}
              >
                {artist.name}
              </h3>
              {isInLibrary && (
                <CheckCircle2 className="artist-library-check--discover" />
              )}
            </div>
            {artistMetaText ? (
              <p
                className="artist-card-meta--discover"
                title={artistMetaText || undefined}
              >
                {artistMetaText}
              </p>
            ) : null}
            {artist.subtitle && (
              <p className="artist-card-meta--discover" title={artist.subtitle}>
                {artist.subtitle}
              </p>
            )}
          </div>
          {(canAddArtist || onAddToBlocklist || onFeedback) && (
            <div style={{ position: "relative", flexShrink: 0 }}>
              <button
                ref={menuButtonRef}
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  setShowMenu((prev) => !prev);
                }}
                className="btn btn-surface btn-icon-square"
                aria-label={`Artist options for ${artist.name}`}
              >
                <MoreVertical className="artist-icon-sm" />
              </button>
            </div>
          )}
        </div>
        {showMenu && menuPosition && getMainContentPortalRoot()
          ? createPortal(
              <div
                ref={menuRef}
                className={`artist-options-menu--discover${menuPosition.placement === "below" ? " is-below" : ""}`}
                style={{
                  top: menuPosition.top,
                  left: menuPosition.left,
                }}
                onClick={(event) => event.stopPropagation()}
              >
                {canAddArtist && (
                  <button
                    type="button"
                    onClick={handleAddToLibraryClick}
                    disabled={isInLibrary || !!pendingAction}
                    className="artist-menu-item--discover"
                  >
                    <div className="artist-menu-item__main--discover">
                      {pendingAction === "library" ? (
                        <Loader2 className="artist-icon-sm animate-spin" />
                      ) : (
                        <Library className="artist-icon-sm" />
                      )}
                      {isInLibrary ? "In Library" : "Add to Library"}
                    </div>
                  </button>
                )}
                <button
                  type="button"
                  onClick={handleBlocklistClick}
                  disabled={isBlocked || !!pendingAction}
                  className={`artist-menu-item--discover ${isBlocked ? "" : "artist-menu-item--danger"}`}
                >
                  <div className="artist-menu-item__main--discover">
                    {pendingAction === "blocklist" ? (
                      <Loader2 className="artist-icon-sm animate-spin" />
                    ) : (
                      <Ban className="artist-icon-sm" />
                    )}
                    {isBlocked ? "In Blocklist" : "Blocklist Artist"}
                  </div>
                </button>
                {onFeedback && (
                  <>
                    <button
                      type="button"
                      onClick={(event) =>
                        handleFeedbackClick(event, "more_like_this")
                      }
                      disabled={!!pendingAction}
                      className={`artist-menu-item--discover${feedbackUsed.more_like_this ? " is-selected" : ""}`}
                    >
                      <div className="artist-menu-item__main--discover">
                        {pendingAction === "more_like_this" ? (
                          <Loader2 className="artist-icon-sm animate-spin" />
                        ) : (
                          <ThumbsUp className="artist-icon-sm" />
                        )}
                        {getDiscoveryFeedbackLabel("more_like_this")}
                      </div>
                    </button>
                    <button
                      type="button"
                      onClick={(event) =>
                        handleFeedbackClick(event, "less_like_this")
                      }
                      disabled={!!pendingAction}
                      className={`artist-menu-item--discover${feedbackUsed.less_like_this ? " is-selected" : ""}`}
                    >
                      <div className="artist-menu-item__main--discover">
                        {pendingAction === "less_like_this" ? (
                          <Loader2 className="artist-icon-sm animate-spin" />
                        ) : (
                          <ThumbsDown className="artist-icon-sm" />
                        )}
                        {getDiscoveryFeedbackLabel("less_like_this")}
                      </div>
                    </button>
                    <button
                      type="button"
                      onClick={(event) =>
                        handleFeedbackClick(event, "already_known")
                      }
                      disabled={!!pendingAction}
                      className={`artist-menu-item--discover${feedbackUsed.already_known ? " is-selected" : ""}`}
                    >
                      <div className="artist-menu-item__main--discover">
                        {pendingAction === "already_known" ? (
                          <Loader2 className="artist-icon-sm animate-spin" />
                        ) : (
                          <CheckCircle2 className="artist-icon-sm" />
                        )}
                        {getDiscoveryFeedbackLabel("already_known")}
                      </div>
                    </button>
                    <button
                      type="button"
                      onClick={(event) =>
                        handleFeedbackClick(event, "hide_for_now")
                      }
                      disabled={!!pendingAction}
                      className="artist-menu-item--discover artist-menu-item--danger"
                    >
                      <div className="artist-menu-item__main--discover">
                        <EyeOff className="artist-icon-sm" />
                        Hide for now
                      </div>
                    </button>
                  </>
                )}
              </div>,
              getMainContentPortalRoot(),
            )
          : null}
      </div>
    );
  },
  (prevProps, nextProps) => {
    return (
      prevProps.artist.id === nextProps.artist.id &&
      prevProps.artist.image === nextProps.artist.image &&
      prevProps.artist.imageUrl === nextProps.artist.imageUrl &&
      prevProps.artist.name === nextProps.artist.name &&
      prevProps.status === nextProps.status &&
      prevProps.isInLibrary === nextProps.isInLibrary &&
      prevProps.isBlocked === nextProps.isBlocked &&
      prevProps.canAddArtist === nextProps.canAddArtist &&
      prevProps.feedbackUsed?.more_like_this ===
        nextProps.feedbackUsed?.more_like_this &&
      prevProps.feedbackUsed?.less_like_this ===
        nextProps.feedbackUsed?.less_like_this &&
      prevProps.feedbackUsed?.already_known ===
        nextProps.feedbackUsed?.already_known &&
      prevProps.onNavigate === nextProps.onNavigate &&
      prevProps.onAddToLibrary === nextProps.onAddToLibrary &&
      prevProps.onAddToBlocklist === nextProps.onAddToBlocklist &&
      prevProps.onFeedback === nextProps.onFeedback
    );
  },
);

ArtistCard.displayName = "ArtistCard";
ArtistCard.propTypes = {
  artist: PropTypes.shape({
    id: PropTypes.string,
    name: PropTypes.string.isRequired,
    image: PropTypes.string,
    imageUrl: PropTypes.string,
    type: PropTypes.string,
    sourceArtist: PropTypes.string,
    metaText: PropTypes.string,
    subtitle: PropTypes.string,
    navigateTo: PropTypes.string,
    matchedTags: PropTypes.arrayOf(PropTypes.string),
    reasonCodes: PropTypes.arrayOf(PropTypes.string),
    discoveryTier: PropTypes.string,
    supportingSeeds: PropTypes.arrayOf(
      PropTypes.shape({
        artistName: PropTypes.string,
      }),
    ),
  }).isRequired,
  status: PropTypes.string,
  isInLibrary: PropTypes.bool,
  isBlocked: PropTypes.bool,
  canAddArtist: PropTypes.bool,
  onNavigate: PropTypes.func.isRequired,
  onAddToLibrary: PropTypes.func,
  onAddToBlocklist: PropTypes.func,
  onFeedback: PropTypes.func,
  feedbackUsed: PropTypes.shape({
    more_like_this: PropTypes.bool,
    less_like_this: PropTypes.bool,
    already_known: PropTypes.bool,
  }),
};

const AlbumCard = memo(
  ({ album, releaseCovers, artistCovers, onNavigate }) => {
    const coverId = album.mbid || album.foreignAlbumId;
    const releaseCover = coverId ? releaseCovers[coverId] : null;
    const artistId = album.artistMbid || album.foreignArtistId;
    const artistCover = artistId ? artistCovers[artistId] : null;
    const coverUrl = album.coverUrl || releaseCover || artistCover;
    const navigateTo = album.artistMbid || album.foreignArtistId;
    const hasValidMbid =
      navigateTo && navigateTo !== "null" && navigateTo !== "undefined";
    const albumArtistText = album.artistName || "Unknown Artist";
    const albumReleaseText = formatReleaseStatus(album.releaseDate);
    const handleClick = useCallback(() => {
      if (hasValidMbid) {
        onNavigate(`/artist/${navigateTo}`, {
          state: { artistName: album.artistName },
        });
      }
    }, [navigateTo, hasValidMbid, album.artistName, onNavigate]);

    return (
      <div className="artist-discover-card">
        <div
          onClick={handleClick}
          className={`artist-discover-card__cover${hasValidMbid ? "" : " is-disabled"}`}
        >
          {coverUrl ? (
            <img
              src={coverUrl}
              alt={album.albumName}
              className="artist-discover-card__image"
              loading="lazy"
              decoding="async"
            />
          ) : (
            <div className="artist-media-placeholder--discover">
              <Music className="artist-icon-lg" />
            </div>
          )}
        </div>

        <div className="artist-discover-card__content">
          <div className="artist-discover-card__text">
            <div className="artist-card-title-row--discover">
              <h3
                onClick={handleClick}
                className={`artist-card-title--discover${hasValidMbid ? "" : " is-disabled"}`}
                title={album.albumName}
              >
                {album.albumName}
              </h3>
            </div>
            <p className="artist-card-meta--discover" title={albumArtistText}>
              {albumArtistText}
            </p>
            {albumReleaseText && (
              <p
                className="artist-card-meta--discover"
                title={albumReleaseText}
              >
                {albumReleaseText}
              </p>
            )}
          </div>
        </div>
      </div>
    );
  },
  (prevProps, nextProps) => {
    const prevId = prevProps.album.mbid || prevProps.album.foreignAlbumId;
    const nextId = nextProps.album.mbid || nextProps.album.foreignAlbumId;
    return (
      prevId === nextId &&
      prevProps.album.albumName === nextProps.album.albumName &&
      prevProps.album.artistName === nextProps.album.artistName &&
      prevProps.album.coverUrl === nextProps.album.coverUrl &&
      prevProps.album.releaseDate === nextProps.album.releaseDate &&
      prevProps.onNavigate === nextProps.onNavigate &&
      prevProps.releaseCovers === nextProps.releaseCovers &&
      prevProps.artistCovers === nextProps.artistCovers
    );
  },
);

AlbumCard.displayName = "AlbumCard";
AlbumCard.propTypes = {
  album: PropTypes.shape({
    id: PropTypes.string,
    mbid: PropTypes.string,
    foreignAlbumId: PropTypes.string,
    albumName: PropTypes.string.isRequired,
    artistName: PropTypes.string,
    artistMbid: PropTypes.string,
    foreignArtistId: PropTypes.string,
    releaseDate: PropTypes.string,
    coverUrl: PropTypes.string,
  }).isRequired,
  releaseCovers: PropTypes.object.isRequired,
  artistCovers: PropTypes.object.isRequired,
  onNavigate: PropTypes.func.isRequired,
};

const ViewAllCard = memo(({ onClick, label = "View All" }) => {
  return (
    <button
      type="button"
      onClick={onClick}
      className="artist-view-all-card--discover"
    >
      <div className="artist-media-cell">
        <span className="artist-card-title">{label}</span>
      </div>
    </button>
  );
});

ViewAllCard.displayName = "ViewAllCard";
ViewAllCard.propTypes = {
  onClick: PropTypes.func.isRequired,
  label: PropTypes.string,
};

function DiscoverRail({
  title,
  mobileTitle,
  onViewAll,
  afterTitle,
  headerActions,
  children,
  className = "",
  headerClassName = "",
  style,
}) {
  const scrollRef = useRef(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const updateScrollState = useCallback(() => {
    const node = scrollRef.current;
    if (!node) return;
    const maxScrollLeft = Math.max(node.scrollWidth - node.clientWidth, 0);
    const nextCanScrollLeft = node.scrollLeft > 2;
    const nextCanScrollRight = node.scrollLeft < maxScrollLeft - 2;
    setCanScrollLeft(nextCanScrollLeft);
    setCanScrollRight(nextCanScrollRight);
  }, []);

  const scrollByAmount = useCallback((direction) => {
    if (!scrollRef.current) return;
    const width = scrollRef.current.clientWidth;
    scrollRef.current.scrollBy({
      left: direction * Math.max(width * 0.85, 280),
      behavior: "smooth",
    });
  }, []);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    updateScrollState();
    node.addEventListener("scroll", updateScrollState, { passive: true });
    window.addEventListener("resize", updateScrollState);
    return () => {
      node.removeEventListener("scroll", updateScrollState);
      window.removeEventListener("resize", updateScrollState);
    };
  }, [children, updateScrollState]);

  return (
    <section className={`artist-discover-rail ${className}`} style={style}>
      <div className={`artist-discover-rail__header ${headerClassName}`}>
        <div className="artist-discover-rail__title-group">
          <h2 className="artist-section-title--discover">
            <span className="artist-section-title--discover-mobile">
              {mobileTitle || title}
            </span>
            <span className="artist-section-title--discover-desktop">
              {title}
            </span>
          </h2>
          {onViewAll && (
            <button
              type="button"
              onClick={onViewAll}
              className="btn btn-ghost btn-icon-square"
              aria-label={`Open ${title}`}
            >
              →
            </button>
          )}
          {afterTitle}
        </div>
        <div className="artist-discover-rail__actions">
          {headerActions}
          <button
            type="button"
            onClick={() => scrollByAmount(-1)}
            className="btn btn-ghost btn-icon-square"
            style={{ color: canScrollLeft ? "#6f7685" : "#2d3442" }}
            aria-label={`Scroll ${title} left`}
            disabled={!canScrollLeft}
          >
            <ChevronLeft className="artist-icon-lg" />
          </button>
          <button
            type="button"
            onClick={() => scrollByAmount(1)}
            className="btn btn-ghost btn-icon-square"
            style={{ color: canScrollRight ? "#d1d5df" : "#2d3442" }}
            aria-label={`Scroll ${title} right`}
            disabled={!canScrollRight}
          >
            <ChevronRight className="artist-icon-lg" />
          </button>
        </div>
      </div>
      <div ref={scrollRef} className="artist-discover-rail__content">
        {children}
      </div>
    </section>
  );
}

DiscoverRail.propTypes = {
  title: PropTypes.string.isRequired,
  mobileTitle: PropTypes.string,
  onViewAll: PropTypes.func,
  afterTitle: PropTypes.node,
  headerActions: PropTypes.node,
  children: PropTypes.node.isRequired,
  className: PropTypes.string,
  headerClassName: PropTypes.string,
  style: PropTypes.object,
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
  const [discoverSections, setDiscoverSections] = useState(
    DEFAULT_DISCOVER_SECTIONS.map((item) => ({ ...item })),
  );
  const [draftSections, setDraftSections] = useState(
    DEFAULT_DISCOVER_SECTIONS.map((item) => ({ ...item })),
  );
  const [showDiscoverModal, setShowDiscoverModal] = useState(false);
  const [isSavingDiscoverLayout, setIsSavingDiscoverLayout] = useState(false);
  const [error, setError] = useState(null);
  const [libraryLookup, setLibraryLookup] = useState({});
  const [blockedArtists, setBlockedArtists] = useState([]);
  const [discoveryFeedback, setDiscoveryFeedback] = useState([]);
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
  const blockedArtistsRef = useRef([]);
  const navigate = useNavigate();
  const { showSuccess, showError } = useToast();
  const canAddArtist = hasPermission("addArtist");
  const artistFeedbackLookup = useMemo(
    () => buildArtistFeedbackLookup(discoveryFeedback),
    [discoveryFeedback],
  );

  useEffect(() => {
    getDiscoveryFeedback()
      .then((payload) =>
        setDiscoveryFeedback(normalizeDiscoveryFeedbackList(payload)),
      )
      .catch(() => {});
  }, [authUser?.id]);

  const { isConnected: isDiscoverySocketConnected } = useWebSocketChannel(
    "discovery",
    (msg) => {
      if (msg.type === "discovery_update" && msg.recommendations) {
        lastDiscoveryWsMessageAtRef.current = Date.now();
        const nextData = {
          recommendations: msg.recommendations || [],
          globalTop: msg.globalTop || [],
          basedOn: msg.basedOn || [],
          topTags: msg.topTags || [],
          topGenres: msg.topGenres || [],
          fallbackGenres: msg.fallbackGenres || [],
          provider: msg.provider || "lastfm",
          capabilities: msg.capabilities || null,
          lastUpdated: msg.lastUpdated || null,
          isUpdating: false,
          stale: false,
          discoveryMode:
            msg.discoveryMode === "safer" || msg.discoveryMode === "deeper"
              ? msg.discoveryMode
              : "balanced",
          configured: true,
        };
        const filteredData = filterDiscoveryDataByBlockedArtists(
          nextData,
          blockedArtistsRef.current,
        );
        setData(filteredData);
        writeStoredDiscoveryData(filteredData, authUser?.id);
      }
    },
  );

  useEffect(() => {
    if (!isDiscoverySocketConnected) return;
    if (!data?.isUpdating && !data?.stale) return;
    getDiscovery()
      .then((discoveryData) => {
        const filteredData = filterDiscoveryDataByBlockedArtists(
          discoveryData,
          blockedArtistsRef.current,
        );
        setData(filteredData);
        writeStoredDiscoveryData(filteredData, authUser?.id);
        setError(null);
      })
      .catch(() => {});
  }, [authUser?.id, isDiscoverySocketConnected, data?.isUpdating, data?.stale]);

  useEffect(() => {
    if (!data?.isUpdating) return;
    const hasRecentWsUpdate =
      Date.now() - lastDiscoveryWsMessageAtRef.current < 20000;
    if (isDiscoverySocketConnected && hasRecentWsUpdate) return;
    const pollDiscovery = () => {
      getDiscovery(true)
        .then((next) => {
          const filteredData = filterDiscoveryDataByBlockedArtists(
            next,
            blockedArtistsRef.current,
          );
          setData(filteredData);
          writeStoredDiscoveryData(filteredData, authUser?.id);
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
          const filteredData = filterDiscoveryDataByBlockedArtists(
            next,
            blockedArtistsRef.current,
          );
          setData(filteredData);
          writeStoredDiscoveryData(filteredData, authUser?.id);
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
        const filteredData = filterDiscoveryDataByBlockedArtists(
          discoveryData,
          blockedArtistsRef.current,
        );
        setData(filteredData);
        writeStoredDiscoveryData(filteredData, authUser?.id);
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
    let cancelled = false;
    const loadBlocklist = async () => {
      try {
        const data = await getBlocklist();
        if (!cancelled) {
          const nextBlockedArtists = normalizeBlocklistArtists(data?.artists);
          blockedArtistsRef.current = nextBlockedArtists;
          setBlockedArtists(nextBlockedArtists);
          setData((prev) =>
            filterDiscoveryDataByBlockedArtists(prev, nextBlockedArtists),
          );
        }
      } catch {}
    };
    loadBlocklist();
    return () => {
      cancelled = true;
    };
  }, [authUser?.id]);

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
    const stored = readStoredDiscoverLayout(authUser?.id);
    if (stored) {
      setDiscoverSections(stored);
    }
  }, [authUser?.id]);

  useEffect(() => {
    if (!authUser?.id) return;
    let cancelled = false;
    const loadDiscoverLayout = async () => {
      try {
        const response = await getMyDiscoverLayout();
        if (cancelled) return;
        const serverLayout = normalizeDiscoverLayout(response?.layout);
        if (serverLayout) {
          setDiscoverSections(serverLayout);
          writeStoredDiscoverLayout(serverLayout, authUser.id);
          return;
        }
      } catch {
        const localLayout = readStoredDiscoverLayout(authUser.id);
        if (!cancelled && localLayout) {
          setDiscoverSections(localLayout);
        }
      }
    };
    loadDiscoverLayout();
    return () => {
      cancelled = true;
    };
  }, [authUser?.id]);

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

      if (image && artist.id) {
        return null;
      }
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
    topTags = [],
    basedOn = [],
    provider = "lastfm",
    capabilities,
    lastUpdated,
    isUpdating,
    configured = true,
  } = data || {};
  const isListenBrainzFallback = provider === "listenbrainz-fallback";

  const nearbyShows = nearbyShowsData?.shows || [];
  const nearbyLocationLabel =
    nearbyShowsData?.location?.label ||
    nearbyShowsData?.location?.postalCode ||
    "your area";
  const sectionAvailability = useMemo(
    () => ({
      recentlyAdded: recentlyAdded.length > 0,
      recentReleases: recentReleases.length > 0,
      recommended:
        !isListenBrainzFallback &&
        (recommendations.length > 0 ||
          capabilities?.personalizedRecommendations !== false),
      recommendedShows: ticketmasterConfigured,
      globalTop: globalTop.length > 0,
      genreSections: genreSections.length > 0,
      topTags: topTags.length > 0,
    }),
    [
      recentlyAdded,
      recentReleases,
      globalTop,
      genreSections,
      topTags,
      recommendations,
      capabilities,
      isListenBrainzFallback,
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

    const insertionIndex =
      lastGenreIndex >= 0
        ? lastGenreIndex + 1
        : nextSections.findIndex((item) => item.id === "topTags");
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
    const nextLayout = draftSections.map((item) => ({ ...item }));
    setDiscoverSections(nextLayout);
    writeStoredDiscoverLayout(nextLayout, authUser?.id);
    setIsSavingDiscoverLayout(true);
    updateMyDiscoverLayout(nextLayout)
      .then((response) => {
        const savedLayout =
          normalizeDiscoverLayout(response?.layout) || nextLayout;
        setDiscoverSections(savedLayout);
        writeStoredDiscoverLayout(savedLayout, authUser?.id);
        showSuccess("Discover layout saved");
        setShowDiscoverModal(false);
      })
      .catch((err) => {
        showError(
          err.response?.data?.message || "Failed to save discover layout",
        );
      })
      .finally(() => {
        setIsSavingDiscoverLayout(false);
      });
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

  const handleAddArtistToBlocklist = useCallback(
    async (artist) => {
      const artistId = getArtistId(artist);
      if (!artist?.name && !artistId) return false;
      try {
        const current = await getBlocklist();
        const nextArtists = normalizeBlocklistArtists([
          ...(current?.artists || []),
          {
            mbid: artistId,
            name: artist.name || null,
          },
        ]);
        const response = await updateBlocklist({
          artists: nextArtists,
          tags: current?.tags || [],
        });
        const savedBlockedArtists = normalizeBlocklistArtists(
          response?.blocklist?.artists || nextArtists,
        );
        blockedArtistsRef.current = savedBlockedArtists;
        setBlockedArtists(savedBlockedArtists);
        setData((prev) =>
          prev
            ? {
                ...prev,
                recommendations: (prev.recommendations || []).filter(
                  (entry) => !matchesBlockedArtist(entry, artist),
                ),
                globalTop: (prev.globalTop || []).filter(
                  (entry) => !matchesBlockedArtist(entry, artist),
                ),
              }
            : prev,
        );
        showSuccess("Artist added to blocklist");
        return true;
      } catch (err) {
        showError(err.response?.data?.message || "Failed to update blocklist");
        return false;
      }
    },
    [showError, showSuccess],
  );

  const handleDiscoveryFeedback = useCallback(
    async (artist, action, { isSelected = false } = {}) => {
      try {
        const payload = {
          artistId: getArtistId(artist),
          artistName: artist.name || null,
          action,
          sourceContext: artist.sourceType || artist.discoveryTier || null,
          tagContext: artist.matchedTags || artist.tags || [],
          seedContext: Array.isArray(artist.supportingSeeds)
            ? artist.supportingSeeds
                .map((seed) => seed?.artistName)
                .filter(Boolean)
            : artist.sourceArtists || [],
        };
        const { feedbackList } = await applyArtistDiscoveryFeedback({
          feedbackList: discoveryFeedback,
          artist,
          action,
          isSelected,
          payload,
          addDiscoveryFeedback,
          removeDiscoveryFeedback,
        });
        setDiscoveryFeedback(feedbackList);
        if (action === "hide_for_now" && !isSelected) {
          setData((prev) =>
            prev
              ? {
                  ...prev,
                  recommendations: (prev.recommendations || []).filter(
                    (entry) => getArtistId(entry) !== getArtistId(artist),
                  ),
                }
              : prev,
          );
        }
        if (!isSelected) {
          showSuccess(
            action === "more_like_this"
              ? "We’ll bias future picks toward this taste"
              : action === "less_like_this"
                ? "We’ll show less like this"
                : action === "already_known"
                  ? "We’ll avoid obvious repeats like this"
                  : "Hidden from Discover for now",
          );
        }
        return true;
      } catch (err) {
        showError(
          err.response?.data?.message || "Failed to save discovery feedback",
        );
        return false;
      }
    },
    [discoveryFeedback, showError, showSuccess],
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
                    isBlocked={isArtistInEntries(artist, blockedArtists)}
                    canAddArtist={canAddArtist}
                    onNavigate={navigate}
                    onAddToLibrary={handleAddArtistToLibrary}
                    onAddToBlocklist={handleAddArtistToBlocklist}
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
                      isBlocked={isArtistInEntries(
                        { id: artistId, name: artist.artistName },
                        blockedArtists,
                      )}
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
                  />
                </div>
              ))}
          </>
        </DiscoverRail>
      );
    }

    if (id === "recommended") {
      if (!sectionAvailability.recommended) return null;
      return (
        <DiscoverRail
          key="recommended"
          title="Recommended for You"
          onViewAll={() => navigate("/search?type=recommended")}
        >
          {recommendations.length > 0 ? (
            <>
              {recommendations
                .slice(0, DISCOVER_PREVIEW_ITEM_LIMIT)
                .map((artist) => (
                  <div key={artist.id} className="artist-discover-shelf-card">
                    <ArtistCard
                      artist={artist}
                      isInLibrary={!!libraryLookup[getArtistId(artist)]}
                      isBlocked={isArtistInEntries(artist, blockedArtists)}
                      canAddArtist={canAddArtist}
                      onNavigate={navigate}
                      onAddToLibrary={handleAddArtistToLibrary}
                      onAddToBlocklist={handleAddArtistToBlocklist}
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
          ) : (
            <div className="artist-nearby-status artist-nearby-status--loading">
              <Music className="artist-media-placeholder--discover-icon" />
              <p className="discover-not-configured__text">
                Not enough data to generate recommendations yet.
              </p>
              <p className="discover-loading__text">
                If you just set up Last.fm, the first scan may take up to 10
                minutes.
              </p>
            </div>
          )}
        </DiscoverRail>
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
                  isBlocked={isArtistInEntries(artist, blockedArtists)}
                  canAddArtist={canAddArtist}
                  onNavigate={navigate}
                  onAddToLibrary={handleAddArtistToLibrary}
                  onAddToBlocklist={handleAddArtistToBlocklist}
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
                        isBlocked={isArtistInEntries(artist, blockedArtists)}
                        canAddArtist={canAddArtist}
                        onNavigate={navigate}
                        onAddToLibrary={handleAddArtistToLibrary}
                        onAddToBlocklist={handleAddArtistToBlocklist}
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

    if (id === "topTags") {
      // Disabled since all tags are now shown in the hero section
      return null;
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
                {lastUpdated && (
                  <span className="artist-discover-hero__updated">
                    <Clock className="artist-discover-hero__updated-icon" />
                    Updated {new Date(lastUpdated).toLocaleDateString()}
                    {isUpdating && (
                      <Loader className="artist-discover-hero__updated-spinner animate-spin" />
                    )}
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
                              navigateToBasedOnArtist(heroBasedOn[1])
                            }
                            className="artist-discover-hero__artist-tag"
                          >
                            {heroBasedOn[2].name}
                          </button>
                          <button
                            onClick={() =>
                              navigateToBasedOnArtist(heroBasedOn[1])
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
                              navigateToBasedOnArtist(heroBasedOn[1])
                            }
                            className="artist-discover-hero__artist-tag"
                          >
                            {heroBasedOn[2].name}
                          </button>
                          <button
                            onClick={() =>
                              navigateToBasedOnArtist(heroBasedOn[1])
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
              className="btn btn-surface btn--bold btn-min-h discover-page__customize-btn"
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

      {discoverSections
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

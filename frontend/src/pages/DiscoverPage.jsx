import { useState, useEffect, useMemo, memo, useCallback, useRef } from "react";
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
  GripVertical,
  X,
  CheckCircle2,
  MapPin,
  Pencil,
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
  getBlocklist,
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
import { useAuth } from "../contexts/AuthContext";
import ArtistImage from "../components/ArtistImage";
import LastfmBanner from "../components/LastfmBanner";
import { useToast } from "../contexts/ToastContext";

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

const getTagCardBackground = (tag) => {
  const base = getTagColor(tag);
  return {
    background: `
      linear-gradient(135deg, rgba(255,255,255,0.18), rgba(255,255,255,0.02)),
      linear-gradient(0deg, rgba(0,0,0,0.28), rgba(0,0,0,0.28)),
      radial-gradient(circle at top right, rgba(255,255,255,0.16), transparent 35%),
      linear-gradient(135deg, ${base}, #121723)
    `,
  };
};

const DISCOVER_LAYOUT_KEY = "discoverLayout";
const DISCOVERY_CACHE_KEY = "discoverData";

const DEFAULT_DISCOVER_SECTIONS = [
  { id: "recentlyAdded", label: "Recently Added", enabled: true },
  { id: "recommendedShows", label: "Shows Near You", enabled: true },
  { id: "recentReleases", label: "Recent Releases", enabled: true },
  { id: "recommended", label: "Recommended for You", enabled: true },
  { id: "globalTop", label: "Global Trending", enabled: true },
  { id: "genreSections", label: "Because You Like", enabled: true },
  { id: "topTags", label: "Explore by Tag", enabled: true },
];

const DISCOVER_NEARBY_MODE_KEY = "discoverNearbyMode";
const DISCOVER_NEARBY_ZIP_KEY = "discoverNearbyZip";
const DISCOVER_SHELF_CARD_CLASS =
  "w-[148px] shrink-0 sm:w-[calc((100%-1rem*2)/3)] md:w-[calc((100%-1rem*3)/4)] lg:w-[calc((100%-1rem*5)/6)]";

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
    lastUpdated: value.lastUpdated || null,
    isUpdating: !!value.isUpdating,
    stale: !!value.stale,
    discoveryMode:
      value.discoveryMode === "safer" || value.discoveryMode === "deeper"
        ? value.discoveryMode
        : "balanced",
    configured:
      typeof value.configured === "boolean" ? value.configured : true,
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
  const normalized = [];
  value.forEach((item) => {
    const id = String(item?.id || "").trim();
    if (!id || !defaultsById.has(id)) return;
    const base = defaultsById.get(id);
    normalized.push({
      ...base,
      enabled: typeof item?.enabled === "boolean" ? item.enabled : base.enabled,
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
    const entryMbid = String(entry?.mbid || "").trim().toLowerCase();
    const entryName = String(entry?.name || "").trim().toLowerCase();
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
  return (targetId && artistId && targetId === artistId) ||
    (targetName && artistName && targetName === artistName);
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

const formatShowDate = (show) => {
  if (!show?.date && !show?.dateTime) return null;
  const raw = show.dateTime || show.date;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return show.date || null;
  }
  const dateLabel = parsed.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  return dateLabel;
};

const formatShowLocation = (show) =>
  [show?.venueName, [show?.city, show?.region].filter(Boolean).join(", ")]
    .filter(Boolean)
    .join(" - ");

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
      status,
      isInLibrary,
      isBlocked,
      canAddArtist,
      onNavigate,
      onAddToLibrary,
      onAddToBlocklist,
      onFeedback,
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

      useEffect(() => {
        if (!showMenu) {
          setMenuPosition(null);
          return;
        }
        const updateMenuPosition = () => {
          const button = menuButtonRef.current;
          if (!button) return;
          const rect = button.getBoundingClientRect();
          setMenuPosition({
            top: rect.top - 8,
            left: Math.max(rect.right - 176, 12),
          });
        };
        updateMenuPosition();
        window.addEventListener("resize", updateMenuPosition);
        window.addEventListener("scroll", updateMenuPosition, true);
        return () => {
          window.removeEventListener("resize", updateMenuPosition);
          window.removeEventListener("scroll", updateMenuPosition, true);
        };
      }, [showMenu]);

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
        const saved = await onFeedback(artist, action);
        if (saved) setShowMenu(false);
        setPendingAction(null);
      };

    return (
      <div className="group relative flex flex-col w-full min-w-0">
        <div
          onClick={handleClick}
          className={`relative aspect-square mb-3 overflow-hidden shadow-sm group-hover:shadow-md transition-all ${hasValidMbid ? "cursor-pointer" : "cursor-not-allowed opacity-50"}`}
          style={{ backgroundColor: "#211f27" }}
        >
          <ArtistImage
            src={artist.image || artist.imageUrl}
            mbid={artist.id}
            artistName={artist.name}
            alt={artist.name}
            className="h-full w-full group-hover:scale-105 transition-transform duration-300"
            showLoading={false}
          />

          {status && (
            <div
              className={`absolute bottom-2 left-2 right-2 py-1 px-2 rounded text-[10px] font-bold uppercase text-center backdrop-blur-md shadow-lg ${
                status === "available"
                  ? "bg-green-500/90 text-white"
                  : status === "processing"
                    ? "bg-gray-700/90 text-white"
                    : "bg-yellow-500/90 text-white"
              }`}
            >
              {status}
            </div>
          )}
        </div>

        <div className="flex items-start gap-2 min-w-0">
          <div className="flex flex-col min-w-0 flex-1">
            <div className="flex items-center gap-2 min-w-0">
              <h3
                onClick={handleClick}
                className={`font-semibold truncate ${hasValidMbid ? "hover:underline cursor-pointer" : "cursor-not-allowed opacity-75"}`}
                style={{ color: "#fff" }}
                title={artist.name}
              >
                {artist.name}
              </h3>
              {isInLibrary && (
                <CheckCircle2 className="w-4 h-4 text-green-400 shrink-0" />
              )}
            </div>
            <div className="flex flex-col min-w-0">
              {artistMetaText ? (
                <p
                  className="text-sm truncate"
                  style={{ color: "#c1c1c3" }}
                  title={artistMetaText || undefined}
                >
                  {artistMetaText}
                </p>
              ) : null}
              {artist.subtitle && (
                <p
                  className="text-xs truncate"
                  style={{ color: "#c1c1c3" }}
                  title={artist.subtitle}
                >
                  {artist.subtitle}
                </p>
              )}
            </div>
          </div>
          {(canAddArtist || onAddToBlocklist || onFeedback) && (
            <div className="relative shrink-0">
              <button
                ref={menuButtonRef}
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  setShowMenu((prev) => !prev);
                }}
                className="w-8 h-8 flex items-center justify-center hover:bg-white/10"
                style={{ color: "#c1c1c3" }}
                aria-label={`Artist options for ${artist.name}`}
              >
                <MoreVertical className="w-4 h-4" />
              </button>
            </div>
          )}
        </div>
        {showMenu && menuPosition
          ? createPortal(
              <div
                ref={menuRef}
                className="fixed z-20 w-44 py-1 border border-white/10 shadow-xl"
                style={{
                  top: menuPosition.top,
                  left: menuPosition.left,
                  backgroundColor: "#2a2830",
                  transform: "translateY(-100%)",
                }}
                onClick={(event) => event.stopPropagation()}
              >
                {canAddArtist && (
                  <button
                    type="button"
                    onClick={handleAddToLibraryClick}
                    disabled={isInLibrary || !!pendingAction}
                    className="w-full px-3 py-2 text-left text-sm transition-colors hover:bg-white/10 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                    style={{ color: "#fff" }}
                  >
                    {pendingAction === "library" ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Library className="w-4 h-4" />
                    )}
                    {isInLibrary ? "In Library" : "Add to Library"}
                  </button>
                )}
                <button
                  type="button"
                  onClick={handleBlocklistClick}
                  disabled={isBlocked || !!pendingAction}
                  className="w-full px-3 py-2 text-left text-sm transition-colors hover:bg-white/10 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                  style={{ color: isBlocked ? "#c1c1c3" : "#fca5a5" }}
                >
                  {pendingAction === "blocklist" ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Ban className="w-4 h-4" />
                  )}
                  {isBlocked ? "In Blocklist" : "Blocklist Artist"}
                </button>
                {onFeedback && (
                  <>
                    <button
                      type="button"
                      onClick={(event) =>
                        handleFeedbackClick(event, "more_like_this")
                      }
                      disabled={!!pendingAction}
                      className="w-full px-3 py-2 text-left text-sm transition-colors hover:bg-white/10 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                      style={{ color: "#fff" }}
                    >
                      <ThumbsUp className="w-4 h-4" />
                      More like this
                    </button>
                    <button
                      type="button"
                      onClick={(event) =>
                        handleFeedbackClick(event, "less_like_this")
                      }
                      disabled={!!pendingAction}
                      className="w-full px-3 py-2 text-left text-sm transition-colors hover:bg-white/10 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                      style={{ color: "#fff" }}
                    >
                      <ThumbsDown className="w-4 h-4" />
                      Less like this
                    </button>
                    <button
                      type="button"
                      onClick={(event) =>
                        handleFeedbackClick(event, "already_known")
                      }
                      disabled={!!pendingAction}
                      className="w-full px-3 py-2 text-left text-sm transition-colors hover:bg-white/10 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                      style={{ color: "#fff" }}
                    >
                      <CheckCircle2 className="w-4 h-4" />
                      Already know this
                    </button>
                    <button
                      type="button"
                      onClick={(event) =>
                        handleFeedbackClick(event, "hide_for_now")
                      }
                      disabled={!!pendingAction}
                      className="w-full px-3 py-2 text-left text-sm transition-colors hover:bg-white/10 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                      style={{ color: "#fca5a5" }}
                    >
                      <EyeOff className="w-4 h-4" />
                      Hide for now
                    </button>
                  </>
                )}
              </div>,
              document.body,
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
      prevProps.onNavigate === nextProps.onNavigate
      && prevProps.onAddToLibrary === nextProps.onAddToLibrary
      && prevProps.onAddToBlocklist === nextProps.onAddToBlocklist
      && prevProps.onFeedback === nextProps.onFeedback
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
      <div className="group relative flex flex-col w-full min-w-0">
        <div
          onClick={handleClick}
          className={`relative aspect-square mb-3 overflow-hidden shadow-sm group-hover:shadow-md transition-all ${hasValidMbid ? "cursor-pointer" : "cursor-not-allowed opacity-50"}`}
          style={{ backgroundColor: "#211f27" }}
        >
          {coverUrl ? (
            <img
              src={coverUrl}
              alt={album.albumName}
              className="h-full w-full object-cover group-hover:scale-105 transition-transform duration-300"
              loading="lazy"
              decoding="async"
            />
          ) : (
            <div className="h-full w-full flex items-center justify-center">
              <Music className="w-10 h-10" style={{ color: "#c1c1c3" }} />
            </div>
          )}
        </div>

        <div className="flex flex-col min-w-0">
          <h3
            onClick={handleClick}
            className={`font-semibold truncate ${hasValidMbid ? "hover:underline cursor-pointer" : "cursor-not-allowed opacity-75"}`}
            style={{ color: "#fff" }}
            title={album.albumName}
          >
            {album.albumName}
          </h3>
          <div className="flex flex-col min-w-0">
            <p
              className="text-sm truncate"
              style={{ color: "#c1c1c3" }}
              title={albumArtistText}
            >
              {albumArtistText}
            </p>
            {albumReleaseText && (
              <p
                className="text-xs truncate"
                style={{ color: "#c1c1c3" }}
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
      className="group relative flex w-full min-w-0 flex-col text-left"
    >
      <div
        className="relative flex aspect-square items-center justify-center overflow-hidden border border-dashed border-white/15 transition-colors group-hover:border-white/30"
        style={{
          background:
            "linear-gradient(135deg, rgba(255,255,255,0.04), rgba(255,255,255,0.01)), #191820",
        }}
      >
        <span className="px-4 text-center text-2xl font-semibold text-white">
          {label}
        </span>
      </div>
    </button>
  );
});

ViewAllCard.displayName = "ViewAllCard";
ViewAllCard.propTypes = {
  onClick: PropTypes.func.isRequired,
  label: PropTypes.string,
};

const ShowCard = memo(({ show }) => {
  const showDate = formatShowDate(show);
  const showLocation = formatShowLocation(show);
  return (
    <>
      <a
        href={show.url || "#"}
        target="_blank"
        rel="noopener noreferrer"
        className="group relative overflow-hidden rounded-[28px] border border-white/10 sm:hidden"
        style={{ backgroundColor: "#191820" }}
      >
        <div className="relative aspect-[1.7/1] overflow-hidden" style={{ backgroundColor: "#211f27" }}>
          {show.image ? (
            <img
              src={show.image}
              alt={show.eventName || show.artistName}
              className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
              loading="lazy"
              decoding="async"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center">
              <Music className="h-10 w-10" style={{ color: "#c1c1c3" }} />
            </div>
          )}
          <div
            className="absolute inset-0"
            style={{
              background:
                "linear-gradient(90deg, rgba(12,15,24,0.84) 0%, rgba(12,15,24,0.66) 42%, rgba(12,15,24,0.18) 100%)",
            }}
          />
          <div className="absolute inset-0 flex flex-col justify-between p-5">
            <div />
            <div className="max-w-[74%]">
              <p className="truncate text-xs font-medium" style={{ color: "#b8bbc7" }}>
                {show.artistName}
              </p>
              <h3 className="mt-1 truncate text-[1.65rem] font-bold leading-[0.98] tracking-tight text-white">
                {show.eventName}
              </h3>
              <div className="mt-3 space-y-1.5 text-xs" style={{ color: "#d7dae4" }}>
                {showDate && (
                  <p className="flex items-center gap-2">
                    <Clock className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">{showDate}</span>
                  </p>
                )}
                {showLocation && (
                  <p className="flex items-start gap-2">
                    <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">{showLocation}</span>
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>
      </a>

      <article
        className="group hidden flex-col overflow-hidden border border-white/10 sm:flex"
        style={{ backgroundColor: "#191820" }}
      >
        <a href={show.url || "#"} target="_blank" rel="noopener noreferrer">
          <div className="relative aspect-[16/9] overflow-hidden" style={{ backgroundColor: "#211f27" }}>
            {show.image ? (
              <img
                src={show.image}
                alt={show.eventName || show.artistName}
                className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                loading="lazy"
                decoding="async"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center">
                <Music className="w-10 h-10" style={{ color: "#c1c1c3" }} />
              </div>
            )}
            <div className="absolute left-3 top-3 flex gap-2">
              {Number.isFinite(show.distance) && (
                <span
                  className="px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide"
                  style={{ backgroundColor: "rgba(20,20,26,0.82)", color: "#fff" }}
                >
                  {Math.round(show.distance)} mi
                </span>
              )}
            </div>
          </div>
        </a>
        <div className="flex flex-1 flex-col gap-3 p-4">
          <div className="min-w-0">
            <p className="text-xs uppercase tracking-[0.22em]" style={{ color: "#8a8a8f" }}>
              {show.artistName}
            </p>
            <h3 className="mt-1 truncate text-lg font-semibold leading-tight">
              <a
                href={show.url || "#"}
                target="_blank"
                rel="noopener noreferrer"
                className="block truncate transition-opacity hover:opacity-80"
                style={{ color: "#fff" }}
              >
                {show.eventName}
              </a>
            </h3>
          </div>
          <div className="space-y-2 text-sm" style={{ color: "#c1c1c3" }}>
            {showDate && (
              <p className="flex items-center gap-2">
                <Clock className="w-4 h-4 shrink-0" />
                <span>{showDate}</span>
              </p>
            )}
            {showLocation && (
              <p className="flex items-start gap-2">
                <MapPin className="w-4 h-4 shrink-0 mt-0.5" />
                <span className="truncate">{showLocation}</span>
              </p>
            )}
          </div>
        </div>
      </article>
    </>
  );
});

ShowCard.displayName = "ShowCard";
ShowCard.propTypes = {
  show: PropTypes.shape({
    id: PropTypes.string,
    artistName: PropTypes.string,
    matchType: PropTypes.string,
    eventName: PropTypes.string,
    image: PropTypes.string,
    url: PropTypes.string,
    date: PropTypes.string,
    time: PropTypes.string,
    dateTime: PropTypes.string,
    venueName: PropTypes.string,
    city: PropTypes.string,
    region: PropTypes.string,
    distance: PropTypes.number,
  }).isRequired,
};

function DiscoverRail({
  title,
  mobileTitle,
  onViewAll,
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
    <section className={className} style={style}>
      <div
        className={`mb-4 flex items-center justify-between gap-3 ${headerClassName}`}
      >
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="truncate text-2xl font-bold text-white">
            <span className="sm:hidden">{mobileTitle || title}</span>
            <span className="hidden sm:inline">{title}</span>
          </h2>
          {onViewAll && (
            <button
              type="button"
              onClick={onViewAll}
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center text-base font-medium text-white/70 transition-colors hover:text-white"
              aria-label={`Open ${title}`}
            >
              →
            </button>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => scrollByAmount(-1)}
            className="flex h-10 w-10 items-center justify-center transition-colors disabled:cursor-default"
            style={{ color: canScrollLeft ? "#6f7685" : "#2d3442" }}
            aria-label={`Scroll ${title} left`}
            disabled={!canScrollLeft}
          >
            <ChevronLeft className="h-7 w-7 stroke-[1.5]" />
          </button>
          <button
            type="button"
            onClick={() => scrollByAmount(1)}
            className="flex h-10 w-10 items-center justify-center transition-colors disabled:cursor-default"
            style={{ color: canScrollRight ? "#d1d5df" : "#2d3442" }}
            aria-label={`Scroll ${title} right`}
            disabled={!canScrollRight}
          >
            <ChevronRight className="h-7 w-7 stroke-[1.5]" />
          </button>
        </div>
      </div>
      <div
        ref={scrollRef}
        className="flex gap-4 overflow-x-auto pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {children}
      </div>
    </section>
  );
}

DiscoverRail.propTypes = {
  title: PropTypes.string.isRequired,
  mobileTitle: PropTypes.string,
  onViewAll: PropTypes.func,
  children: PropTypes.node.isRequired,
  className: PropTypes.string,
  headerClassName: PropTypes.string,
  style: PropTypes.object,
};

function DiscoverPage() {
  const { user: authUser, hasPermission } = useAuth();
  const [data, setData] = useState(() => readStoredDiscoveryData(authUser?.id));
  const [recentlyAdded, setRecentlyAdded] = useState([]);
  const [recentReleases, setRecentReleases] = useState([]);
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
  const [draggingId, setDraggingId] = useState(null);
  const [dragOverId, setDragOverId] = useState(null);
  const [error, setError] = useState(null);
  const [libraryLookup, setLibraryLookup] = useState({});
  const [blockedArtists, setBlockedArtists] = useState([]);
  const [nearbyShowsData, setNearbyShowsData] = useState(null);
  const [nearbyShowsLoading, setNearbyShowsLoading] = useState(false);
  const [nearbyShowsError, setNearbyShowsError] = useState(null);
  const [nearbyLocationMode, setNearbyLocationMode] = useState("ip");
  const [appliedNearbyZip, setAppliedNearbyZip] = useState("");
  const [showNearbyZipEditor, setShowNearbyZipEditor] = useState(false);
  const [nearbyZipDraft, setNearbyZipDraft] = useState("");
  const requestedReleaseCoversRef = useRef(new Set());
  const requestedArtistCoversRef = useRef(new Set());
  const lastDiscoveryWsMessageAtRef = useRef(0);
  const blockedArtistsRef = useRef([]);
  const navigate = useNavigate();
  const { showSuccess, showError } = useToast();
  const canAddArtist = hasPermission("addArtist");


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
          lastUpdated: null,
          isUpdating: false,
          stale: false,
          discoveryMode: "balanced",
          configured: false,
        });
      });

    getRecentlyAdded()
      .then(setRecentlyAdded)
      .catch(() => {});

    getRecentReleases()
      .then(setRecentReleases)
      .catch(() => {});

  }, [authUser?.id]);

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
      setNearbyZipDraft(storedZip);
    } catch {}
  }, [authUser?.id]);

  useEffect(() => {
    const shouldUseZip = nearbyLocationMode === "zip";
    if (shouldUseZip && !appliedNearbyZip.trim()) {
      setNearbyShowsData(null);
      setNearbyShowsError(null);
      setNearbyShowsLoading(false);
      return;
    }
    let cancelled = false;
    setNearbyShowsLoading(true);
    setNearbyShowsError(null);
    getNearbyShows(shouldUseZip ? appliedNearbyZip : "")
      .then((response) => {
        if (cancelled) return;
        setNearbyShowsData(response);
        setNearbyShowsError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setNearbyShowsError(
          err.response?.data?.message || "Failed to load nearby shows",
        );
      })
      .finally(() => {
        if (!cancelled) {
          setNearbyShowsLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [nearbyLocationMode, appliedNearbyZip]);

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
          release?.artistName ||
          release?.artist ||
          release?.artistCredit ||
          "",
        albumTitle: release?.title || release?.albumName || "",
      })
        .then((data) => {
          if (data?.images?.length > 0) {
            const front = data.images.find((img) => img.front) || data.images[0];
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
            const front = data.images.find((img) => img.front) || data.images[0];
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
    if (!data?.topGenres || !data?.recommendations) return [];

    const sections = [];
    const usedArtistIds = new Set(
      (data.recommendations || [])
        .slice(0, 12)
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
            return String(left.name || "").localeCompare(String(right.name || ""));
          })
          .slice(0, 6);

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
      (data.topGenres && data.topGenres.length > 0));
  const isActuallyUpdating = data?.isUpdating && !hasData;

  const {
    recommendations = [],
    globalTop = [],
    topGenres = [],
    topTags = [],
    basedOn = [],
    lastUpdated,
    isUpdating,
    configured = true,
  } = data || {};

  const nearbyShows = nearbyShowsData?.shows || [];
  const nearbyLocationLabel =
    nearbyShowsData?.location?.label ||
    nearbyShowsData?.location?.postalCode ||
    "your area";
  const sectionAvailability = useMemo(
    () => ({
      recentlyAdded: recentlyAdded.length > 0,
      recentReleases: recentReleases.length > 0,
      recommended: true,
      recommendedShows: true,
      globalTop: globalTop.length > 0,
      genreSections: genreSections.length > 0,
      topTags: topTags.length > 0,
    }),
    [recentlyAdded, recentReleases, globalTop, genreSections, topTags],
  );

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
    setDraftSections(discoverSections.map((item) => ({ ...item })));
    setShowDiscoverModal(true);
  };

  useEffect(() => {
    if (!showDiscoverModal) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [showDiscoverModal]);

  const handleDiscoverSave = () => {
    const nextLayout = draftSections.map((item) => ({ ...item }));
    setDiscoverSections(nextLayout);
    writeStoredDiscoverLayout(nextLayout, authUser?.id);
    setIsSavingDiscoverLayout(true);
    updateMyDiscoverLayout(nextLayout)
      .then((response) => {
        const savedLayout = normalizeDiscoverLayout(response?.layout) || nextLayout;
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
    setDraftSections(DEFAULT_DISCOVER_SECTIONS.map((item) => ({ ...item })));
  };

  const handleToggleSection = useCallback(
    (id) => {
      if (draggingId) return;
      setDraftSections((prev) =>
        prev.map((section) =>
          section.id === id ? { ...section, enabled: !section.enabled } : section,
        ),
      );
    },
    [draggingId],
  );

  const handleDragStart = (id) => {
    setDraggingId(id);
  };

  const handleDragOver = (event, id) => {
    event.preventDefault();
    if (!draggingId || id === draggingId) return;
    setDragOverId(id);
    setDraftSections((prev) => {
      const next = [...prev];
      const fromIndex = next.findIndex((item) => item.id === draggingId);
      const toIndex = next.findIndex((item) => item.id === id);
      if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) {
        return prev;
      }
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return next;
    });
  };

  const handleDrop = (event) => {
    event.preventDefault();
    setDraggingId(null);
    setDragOverId(null);
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
        showError(
          err.response?.data?.message || "Failed to update blocklist",
        );
        return false;
      }
    },
    [showError, showSuccess],
  );

  const handleDiscoveryFeedback = useCallback(
    async (artist, action) => {
      try {
        await addDiscoveryFeedback({
          artistId: getArtistId(artist),
          artistName: artist.name || null,
          action,
          sourceContext: artist.sourceType || artist.discoveryTier || null,
          tagContext: artist.matchedTags || artist.tags || [],
          seedContext: Array.isArray(artist.supportingSeeds)
            ? artist.supportingSeeds.map((seed) => seed?.artistName).filter(Boolean)
            : artist.sourceArtists || [],
        });
        if (action === "hide_for_now") {
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
        showSuccess(
          action === "more_like_this"
            ? "We’ll bias future picks toward this taste"
            : action === "less_like_this"
              ? "We’ll show less like this"
              : action === "already_known"
                ? "We’ll avoid obvious repeats like this"
                : "Hidden from Discover for now",
        );
        return true;
      } catch (err) {
        showError(
          err.response?.data?.message || "Failed to save discovery feedback",
        );
        return false;
      }
    },
    [showError, showSuccess],
  );

  const orderedSectionIds = discoverSections
    .filter((item) => item.enabled)
    .map((item) => item.id);

  const renderSection = (id) => {
    if (id === "recentlyAdded") {
      if (!sectionAvailability.recentlyAdded) return null;
      return (
        <DiscoverRail
          key="recentlyAdded"
          className="animate-slide-up"
          title="Recently Added"
          style={{ animationDelay: "0.1s" }}
        >
          <>
            {recentlyAdded.slice(0, 6).map((artist) => {
              const artistId = artist.foreignArtistId || artist.mbid || artist.id;
              return (
                <div key={`artist-${artist.id}`} className={DISCOVER_SHELF_CARD_CLASS}>
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
        <DiscoverRail
          key="recentReleases"
          className="animate-slide-up"
          title="Recent & Upcoming Releases"
          style={{ animationDelay: "0.15s" }}
        >
          <>
            {recentReleases.slice(0, 6).map((album) => (
              <div
                key={album.id || album.mbid || album.foreignAlbumId}
                className={DISCOVER_SHELF_CARD_CLASS}
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
      return (
        <DiscoverRail
          key="recommended"
          title="Recommended for You"
          onViewAll={() => navigate("/search?type=recommended")}
        >
          {recommendations.length > 0 ? (
            <>
              {recommendations.slice(0, 12).map((artist) => (
                <div key={artist.id} className={DISCOVER_SHELF_CARD_CLASS}>
                  <ArtistCard
                    artist={artist}
                    isInLibrary={!!libraryLookup[getArtistId(artist)]}
                    isBlocked={isArtistInEntries(artist, blockedArtists)}
                    canAddArtist={canAddArtist}
                    onNavigate={navigate}
                    onAddToLibrary={handleAddArtistToLibrary}
                    onAddToBlocklist={handleAddArtistToBlocklist}
                    onFeedback={handleDiscoveryFeedback}
                  />
                </div>
              ))}
              <div className={DISCOVER_SHELF_CARD_CLASS}>
                <ViewAllCard
                  onClick={() => navigate("/search?type=recommended")}
                />
              </div>
            </>
          ) : (
            <div
              className="w-full py-12 px-4 text-center"
              style={{ backgroundColor: "#211f27" }}
            >
              <Music
                className="mx-auto mb-3 h-12 w-12"
                style={{ color: "#c1c1c3" }}
              />
              <p className="mb-1" style={{ color: "#c1c1c3" }}>
                Not enough data to generate recommendations yet.
              </p>
              <p className="text-sm" style={{ color: "#8a8a8f" }}>
                If you just set up Last.fm, the first scan may take up to 10
                minutes.
              </p>
            </div>
          )}
        </DiscoverRail>
      );
    }

    if (id === "recommendedShows") {
      const zipModeActive = nearbyLocationMode === "zip";
      return (
        <section key="recommendedShows">
          <div className="mb-6 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <h2 className="text-2xl font-bold text-white">Shows Near You</h2>
              {nearbyShowsData?.configured !== false && (
                <span className="hidden rounded-full bg-white/5 px-2.5 py-1 text-xs font-medium text-white/60 sm:inline-block">
                  {nearbyLocationLabel}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <div className="inline-flex border border-white/10 p-1" style={{ backgroundColor: "#17161d" }}>
                <button
                  type="button"
                  onClick={() => {
                    setNearbyLocationMode("ip");
                    setShowNearbyZipEditor(false);
                    try {
                      localStorage.setItem(DISCOVER_NEARBY_MODE_KEY, "ip");
                    } catch {}
                  }}
                  className="px-3 py-1.5 text-xs font-medium transition-colors"
                  style={{
                    backgroundColor: !zipModeActive ? "#5a5a5f" : "transparent",
                    color: !zipModeActive ? "#0b0b0c" : "#c1c1c3",
                  }}
                >
                  Your Area
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setNearbyLocationMode("zip");
                    try {
                      localStorage.setItem(DISCOVER_NEARBY_MODE_KEY, "zip");
                    } catch {}
                  }}
                  className="px-3 py-1.5 text-xs font-medium transition-colors"
                  style={{
                    backgroundColor: zipModeActive ? "#5a5a5f" : "transparent",
                    color: zipModeActive ? "#0b0b0c" : "#c1c1c3",
                  }}
                >
                  ZIP
                </button>
              </div>
              {zipModeActive && (
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => {
                      setNearbyZipDraft(appliedNearbyZip);
                      setShowNearbyZipEditor((value) => !value);
                    }}
                    className="inline-flex h-8 w-8 items-center justify-center border border-white/10 transition-colors"
                    style={{ backgroundColor: "#17161d", color: "#c1c1c3" }}
                    aria-label="Edit ZIP"
                    title="Edit ZIP"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  {showNearbyZipEditor && (
                    <div
                      className="absolute right-0 top-10 z-20 w-52 border border-white/10 p-2"
                      style={{ backgroundColor: "#17161d" }}
                    >
                      <input
                        type="text"
                        value={nearbyZipDraft}
                        onChange={(event) => setNearbyZipDraft(event.target.value)}
                        className="input mb-2 w-full"
                        placeholder="ZIP or postal code"
                      />
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => setShowNearbyZipEditor(false)}
                          className="border border-white/10 px-2 py-1 text-xs"
                          style={{ color: "#c1c1c3" }}
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            const sanitized = nearbyZipDraft.trim();
                            if (!sanitized) return;
                            setAppliedNearbyZip(sanitized);
                            setNearbyLocationMode("zip");
                            setShowNearbyZipEditor(false);
                            try {
                              localStorage.setItem(DISCOVER_NEARBY_MODE_KEY, "zip");
                              localStorage.setItem(DISCOVER_NEARBY_ZIP_KEY, sanitized);
                            } catch {}
                          }}
                          className="px-2 py-1 text-xs"
                          style={{
                            backgroundColor: "#707e61",
                            color: "#0b0b0c",
                            opacity: nearbyZipDraft.trim() ? 1 : 0.5,
                          }}
                          disabled={!nearbyZipDraft.trim()}
                        >
                          Save
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {nearbyShowsData?.configured === false ? (
            <div className="border border-white/10 p-6" style={{ backgroundColor: "#191820" }}>
              <h3 className="text-lg font-semibold" style={{ color: "#fff" }}>
                Ticketmaster not configured
              </h3>
              <p className="mt-2 max-w-2xl text-sm" style={{ color: "#c1c1c3" }}>
                Add a Ticketmaster Consumer Key in Settings to enable local show
                discovery on this page.
              </p>
              <button
                type="button"
                onClick={() => navigate("/settings")}
                className="btn btn-primary mt-4"
              >
                Open Settings
              </button>
            </div>
          ) : nearbyShowsLoading ? (
            <div className="flex items-center justify-center py-20" style={{ backgroundColor: "#191820" }}>
              <Loader className="h-8 w-8 animate-spin" style={{ color: "#c1c1c3" }} />
            </div>
          ) : nearbyShowsError ? (
            <div className="border border-white/10 p-6" style={{ backgroundColor: "#191820" }}>
              <h3 className="text-lg font-semibold" style={{ color: "#fff" }}>
                Unable to load nearby shows
              </h3>
              <p className="mt-2 text-sm" style={{ color: "#c1c1c3" }}>
                {nearbyShowsError}
              </p>
            </div>
          ) : zipModeActive && !appliedNearbyZip.trim() ? (
            <div className="border border-white/10 p-6" style={{ backgroundColor: "#191820" }}>
              <h3 className="text-lg font-semibold" style={{ color: "#fff" }}>
                ZIP not set
              </h3>
              <p className="mt-2 max-w-2xl text-sm" style={{ color: "#c1c1c3" }}>
                Set a ZIP code from the Shows page area settings to use ZIP mode here.
              </p>
            </div>
          ) : nearbyShows.length > 0 ? (
            <DiscoverRail
              title="Shows Near You"
              onViewAll={() => navigate("/shows")}
              headerClassName="hidden"
            >
              <>
                {nearbyShows.slice(0, 8).map((show) => (
                  <div key={`${show.id}-${show.artistName}-${show.sourceType || show.matchType || "show"}`} className="w-[288px] shrink-0">
                    <ShowCard show={show} />
                  </div>
                ))}
              </>
            </DiscoverRail>
          ) : (
            <div className="border border-white/10 p-6" style={{ backgroundColor: "#191820" }}>
              <h3 className="text-lg font-semibold" style={{ color: "#fff" }}>
                No upcoming nearby matches
              </h3>
              <p className="mt-2 max-w-2xl text-sm" style={{ color: "#c1c1c3" }}>
                We could not find local Ticketmaster shows tied to your library or
                current recommendations around {nearbyLocationLabel}.
              </p>
            </div>
          )}
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
            {globalTop.slice(0, 12).map((artist) => (
              <div key={artist.id} className={DISCOVER_SHELF_CARD_CLASS}>
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
            <div className={DISCOVER_SHELF_CARD_CLASS}>
              <ViewAllCard onClick={() => navigate("/search?type=trending")} />
            </div>
          </>
        </DiscoverRail>
      );
    }

    if (id === "genreSections") {
      if (!sectionAvailability.genreSections) return null;
      return (
        <div key="genreSections" className="space-y-10">
          {genreSections.map((section) => (
            <DiscoverRail
              key={section.genre}
              title={`Because You Like ${section.genre}`}
              mobileTitle={section.genre}
              onViewAll={() =>
                navigate(
                  `/search?q=${encodeURIComponent(`#${section.genre}`)}&type=tag`,
                )
              }
            >
              <>
                {section.artists.slice(0, 6).map((artist) => (
                  <div
                    key={`${section.genre}-${artist.id}`}
                    className={DISCOVER_SHELF_CARD_CLASS}
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
                    />
                  </div>
                ))}
                <div className={DISCOVER_SHELF_CARD_CLASS}>
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
      if (!sectionAvailability.topTags) return null;
      return (
        <DiscoverRail
          key="topTags"
          className="px-4 py-6 sm:px-6"
          title="Explore by Tag"
          style={{ backgroundColor: "#211f27" }}
        >
          <>
            {topTags.map((tag, i) => (
              <div key={i} className="shrink-0">
                <button
                  onClick={() =>
                    navigate(
                      `/search?q=${encodeURIComponent(`#${tag}`)}&type=tag`,
                    )
                  }
                  className="relative h-[128px] w-[248px] overflow-hidden rounded-3xl border border-white/10 text-left sm:hidden"
                  style={{
                    ...getTagCardBackground(tag),
                    color: "#fff",
                  }}
                >
                  <div className="absolute inset-0 opacity-30 mix-blend-screen">
                    <div
                      className="h-full w-full"
                      style={{
                        background:
                          "repeating-linear-gradient(135deg, rgba(255,255,255,0.22) 0 2px, transparent 2px 18px)",
                      }}
                    />
                  </div>
                  <div className="absolute inset-0 flex items-center justify-center px-6">
                    <span className="text-4xl font-bold tracking-tight text-white">
                      {tag}
                    </span>
                  </div>
                </button>
                <button
                  onClick={() =>
                    navigate(
                      `/search?q=${encodeURIComponent(`#${tag}`)}&type=tag`,
                    )
                  }
                  className="genre-tag-pill hidden px-3 py-1.5 text-sm sm:block"
                  style={{ backgroundColor: getTagColor(tag), color: "#fff" }}
                >
                  #{tag}
                </button>
              </div>
            ))}
          </>
        </DiscoverRail>
      );
    }

    return null;
  };

  if (data === null && !error) {
    return (
      <div className="flex flex-col items-center justify-center py-32 px-4 max-w-md mx-auto text-center">
        <Loader
          className="w-12 h-12 animate-spin mb-4"
          style={{ color: "#c1c1c3" }}
        />
        <h2 className="text-xl font-semibold mb-2" style={{ color: "#fff" }}>
          Loading recommendations...
        </h2>
        <p className="text-sm" style={{ color: "#c1c1c3" }}>
          Recommendations will appear as they load.
        </p>
      </div>
    );
  }

  if (isActuallyUpdating) {
    return (
      <div className="flex flex-col items-center justify-center py-32 px-4 max-w-md mx-auto text-center">
        <Loader
          className="w-12 h-12 animate-spin mb-4"
          style={{ color: "#c1c1c3" }}
        />
        <h2 className="text-xl font-semibold mb-2" style={{ color: "#fff" }}>
          Building your recommendations...
        </h2>
        <p className="text-sm" style={{ color: "#c1c1c3" }}>
          The app is scanning your library and Last.fm data. Please wait — this
          can take up to 10 minutes when Last.fm is configured. The page will
          update when ready.
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <div className="bg-red-500/20 p-4 mb-4">
          <Sparkles className="w-8 h-8 text-red-400" />
        </div>
        <h2 className="text-xl font-bold mb-2" style={{ color: "#fff" }}>
          Unable to load discovery
        </h2>
        <p className="max-w-md mx-auto mb-6" style={{ color: "#c1c1c3" }}>
          {error}
        </p>
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
      <div className="flex flex-col items-center justify-center py-32 text-center">
        <div className="p-4 mb-4" style={{ backgroundColor: "#211f27" }}>
          <Sparkles className="w-12 h-12" style={{ color: "#c1c1c3" }} />
        </div>
        <h2 className="text-2xl font-bold mb-2" style={{ color: "#fff" }}>
          Discovery Not Configured
        </h2>
        <p className="max-w-md mx-auto mb-6" style={{ color: "#c1c1c3" }}>
          To see music recommendations, you need at least one of:
        </p>
        <ul
          className="text-left max-w-md mx-auto mb-6 space-y-2"
          style={{ color: "#c1c1c3" }}
        >
          <li className="flex items-start gap-2">
            <span style={{ color: "#c1c1c3" }} className="mt-1">
              •
            </span>
            <span>Add artists to your library, or</span>
          </li>
          <li className="flex items-start gap-2">
            <span style={{ color: "#c1c1c3" }} className="mt-1">
              •
            </span>
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
    <div className="space-y-4 pb-12 sm:space-y-10">
      <LastfmBanner />
      <section
        className="relative hidden overflow-hidden border border-white/10 md:block"
        style={{
          color: "#fff",
          background:
            "linear-gradient(180deg, rgba(24,23,30,0.96), rgba(16,16,21,0.96))",
        }}
      >
        <div className="relative flex flex-col gap-5 p-5 md:p-6">
          <div className="flex flex-col justify-between gap-4 md:flex-row md:items-start">
            <div className="flex max-w-2xl flex-col gap-2">
              <div className="flex flex-wrap items-center gap-3">
                <h1 className="text-3xl font-bold md:text-4xl" style={{ color: "#fff" }}>
                  Discover
                </h1>
                {lastUpdated && (
                  <span className="flex items-center rounded-full px-2 py-1 text-xs font-medium" style={{ backgroundColor: "rgba(255,255,255,0.05)", color: "#8a8a8f" }}>
                    <Clock className="mr-1.5 h-3 w-3" />
                    Updated {new Date(lastUpdated).toLocaleDateString()}
                    {isUpdating && <Loader className="ml-2 h-3 w-3 animate-spin" />}
                  </span>
                )}
              </div>
              <p className="text-sm md:text-base" style={{ color: "#c1c1c3" }}>
                Your daily mix, curated from your library.
              </p>
              {heroBasedOn.length > 0 && (
                <p className="text-xs md:text-sm" style={{ color: "#8a8a8f" }}>
                  Based on{" "}
                  {heroBasedOn.length === 1
                    ? heroBasedOn[0].name
                    : heroBasedOn.length === 2
                      ? `${heroBasedOn[0].name} and ${heroBasedOn[1].name}`
                      : heroBasedOn
                          .slice(0, 2)
                          .map((a) => a.name)
                          .join(", ") +
                        ` and ${heroBasedOn.length - 2} more`}
                </p>
              )}
            </div>

            <button
              type="button"
              onClick={openDiscoverModal}
              className="mt-1 inline-flex shrink-0 items-center gap-2 rounded-md border border-white/10 px-3 py-2 transition-colors hover:bg-white/5"
              style={{ color: "#c1c1c3" }}
            >
              <LayoutTemplate className="w-4 h-4" />
              <span className="text-sm font-medium">Customize</span>
            </button>
          </div>

          <div className="flex flex-col gap-3 border-t border-white/5 pt-4">
            {topGenres.length > 0 && (
              <div className="flex flex-col gap-2">
                <h3 className="text-[11px] font-semibold uppercase tracking-[0.22em]" style={{ color: "#8a8a8f" }}>
                  Top Tags
                </h3>
                <div className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                  {topGenres.map((genre, i) => (
                    <button
                      key={i}
                      onClick={() => navigate(`/search?q=${encodeURIComponent(`#${genre}`)}&type=tag`)}
                      className="genre-tag-pill shrink-0 px-3 py-1.5 text-xs font-medium transition-opacity hover:opacity-90"
                      style={{ backgroundColor: getTagColor(genre), color: "#fff" }}
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

      {orderedSectionIds.map((id) => renderSection(id))}

      {showDiscoverModal &&
        createPortal(
          <div
            className="fixed inset-0 z-50 flex items-center justify-center px-4"
            style={{ backgroundColor: "rgba(0, 0, 0, 0.75)" }}
            onClick={() => setShowDiscoverModal(false)}
          >
            <div
              className="w-full max-w-2xl border border-white/10 shadow-2xl flex flex-col"
              style={{
                backgroundColor: "#14141a",
                height: "min(600px, 90vh)",
              }}
              onClick={(e) => e.stopPropagation()}
            >
            <div
              className="flex items-center justify-between px-5 py-4 border-b border-white/10"
              style={{
                background:
                  "linear-gradient(135deg, rgba(40,38,49,0.9), rgba(20,20,26,0.8))",
              }}
            >
              <div>
                <h3 className="text-xl font-bold" style={{ color: "#fff" }}>
                  Customize Discover
                </h3>
                <p className="text-sm mt-1" style={{ color: "#c1c1c3" }}>
                  Choose what shows up and arrange sections in your order.
                </p>
              </div>
              <button
                type="button"
                className="p-2 rounded transition-colors hover:bg-[#2a2a2e]"
                style={{ color: "#c1c1c3" }}
                onClick={() => setShowDiscoverModal(false)}
                aria-label="Close"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="px-5 py-4 space-y-2 flex-1 overflow-y-auto">
              {draftSections.map((item) => (
                <div
                  key={item.id}
                  draggable
                  onClick={() => handleToggleSection(item.id)}
                  onDragStart={() => handleDragStart(item.id)}
                  onDragOver={(event) => handleDragOver(event, item.id)}
                  onDrop={(event) => handleDrop(event)}
                  onDragEnd={() => {
                    setDraggingId(null);
                    setDragOverId(null);
                  }}
                  className={`flex items-center gap-4 px-4 py-3 border transition-all duration-200 ease-out cursor-grab select-none bg-[#1a191f] ${
                    item.enabled ? "text-white" : "text-[#8a8a8f] opacity-70"
                  } ${
                    draggingId === item.id
                      ? "opacity-80 scale-[0.98] cursor-grabbing"
                      : dragOverId === item.id
                        ? "border-[#707e61] bg-[#1b1c21] -translate-y-0.5"
                        : "border-transparent hover:border-[#5a6070] hover:bg-[#20222a]"
                  }`}
                  style={{
                    willChange: "transform",
                  }}
                >
                  <div
                    className="flex items-center justify-center w-9 h-9"
                    style={{
                      color: item.enabled ? "#c1c1c3" : "#6f6f78",
                    }}
                  >
                    <GripVertical className="w-4 h-4" />
                  </div>
                  <div className="flex flex-col items-start flex-1">
                    <span
                      className="text-sm font-semibold"
                      style={{ color: item.enabled ? "#fff" : "#8a8a8f" }}
                    >
                      {item.label}
                    </span>
                    {!sectionAvailability[item.id] && (
                      <span className="text-xs" style={{ color: "#8a8a8f" }}>
                        Not enough data yet
                      </span>
                    )}
                  </div>
                  <span
                    className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide"
                    style={{
                      backgroundColor: item.enabled ? "#707e61" : "#2d2c32",
                      color: item.enabled ? "#0b0b0c" : "#c1c1c3",
                    }}
                  >
                    {item.enabled ? "Active" : "Hidden"}
                  </span>
                </div>
              ))}
            </div>

            <div
              className="flex flex-wrap gap-3 justify-between items-center px-5 py-4 border-t border-white/10"
              style={{ backgroundColor: "#111117" }}
            >
              <button
                type="button"
                onClick={handleDiscoverReset}
                className="btn btn-secondary"
              >
                Reset to Default
              </button>
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => setShowDiscoverModal(false)}
                  className="btn btn-secondary"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleDiscoverSave}
                  className="btn btn-primary"
                  disabled={isSavingDiscoverLayout}
                >
                  {isSavingDiscoverLayout ? "Saving..." : "Save Layout"}
                </button>
              </div>
            </div>
          </div>
        </div>,
          document.body,
        )}
    </div>
  );
}

export default DiscoverPage;

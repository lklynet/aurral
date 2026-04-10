import { useState, useEffect, useMemo, memo, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import PropTypes from "prop-types";
import { useNavigate } from "react-router-dom";
import {
  Loader,
  Music,
  Sparkles,
  Clock,
  LayoutTemplate,
  GripVertical,
  X,
  CheckCircle2,
  MapPin,
  Pencil,
  Ticket,
} from "lucide-react";
import {
  getDiscovery,
  getNearbyShows,
  getRecentlyAdded,
  getRecentReleases,
  getReleaseGroupCover,
  getArtistCover,
  lookupArtistsInLibraryBatch,
  readLibraryLookupCache,
} from "../utils/api";
import { useWebSocketChannel } from "../hooks/useWebSocket";
import ArtistImage from "../components/ArtistImage";

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

const buildLetterRollSpans = (text) =>
  ["#", ...text.split("")].map((char, index) => (
    <span
      key={`${text}-${index}`}
      style={{ "--roll-delay": `${(index + 1) * 0.05}s` }}
    >
      {char}
    </span>
  ));

const DISCOVER_LAYOUT_KEY = "discoverLayout";

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

const getArtistId = (artist) =>
  artist?.id || artist?.mbid || artist?.foreignArtistId;

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
  if (show.time) {
    return `${dateLabel} at ${show.time}`;
  }
  return dateLabel;
};

const formatShowLocation = (show) =>
  [show?.venueName, [show?.city, show?.region].filter(Boolean).join(", ")]
    .filter(Boolean)
    .join(" - ");

const ArtistCard = memo(
    ({ artist, status, isInLibrary, onNavigate }) => {
      const navigateTo = artist.navigateTo || artist.id;
      const hasValidMbid =
        navigateTo && navigateTo !== "null" && navigateTo !== "undefined";
      const artistMetaText = [artist.sourceArtist && `Similar to ${artist.sourceArtist}`]
        .filter(Boolean)
        .join(" • ");
      const handleClick = useCallback(() => {
        if (hasValidMbid) {
          onNavigate(`/artist/${navigateTo}`, {
            state: { artistName: artist.name },
          });
        }
      }, [navigateTo, hasValidMbid, artist.name, onNavigate]);

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

        <div className="flex flex-col min-w-0">
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
            <p
              className="text-sm truncate"
              style={{ color: "#c1c1c3" }}
              title={artistMetaText || undefined}
            >
              {artistMetaText}
            </p>
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
      prevProps.onNavigate === nextProps.onNavigate
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
    subtitle: PropTypes.string,
    navigateTo: PropTypes.string,
  }).isRequired,
  status: PropTypes.string,
  isInLibrary: PropTypes.bool,
  onNavigate: PropTypes.func.isRequired,
};

const AlbumCard = memo(
  ({ album, releaseCovers, artistCovers, onNavigate }) => {
    const coverId = album.mbid || album.foreignAlbumId;
    const releaseCover = coverId ? releaseCovers[coverId] : null;
    const artistId = album.artistMbid || album.foreignArtistId;
    const artistCover = artistId ? artistCovers[artistId] : null;
    const coverUrl = releaseCover || artistCover;
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
  }).isRequired,
  releaseCovers: PropTypes.object.isRequired,
  artistCovers: PropTypes.object.isRequired,
  onNavigate: PropTypes.func.isRequired,
};

const ShowCard = memo(({ show }) => {
  const showDate = formatShowDate(show);
  const showLocation = formatShowLocation(show);
  return (
    <article
      className="group flex flex-col overflow-hidden border border-white/10"
      style={{ backgroundColor: "#191820" }}
    >
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
      <div className="flex flex-1 flex-col gap-3 p-4">
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-[0.22em]" style={{ color: "#8a8a8f" }}>
            {show.artistName}
          </p>
          <h3 className="mt-1 text-lg font-semibold leading-tight" style={{ color: "#fff" }}>
            {show.eventName}
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
              <span>{showLocation}</span>
            </p>
          )}
        </div>
        <div className="mt-auto pt-2">
          <a
            href={show.url || "#"}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-3 py-2 text-sm font-medium transition-colors hover:opacity-90"
            style={{ backgroundColor: "#707e61", color: "#0b0b0c" }}
          >
            <Ticket className="w-4 h-4" />
            Tickets
          </a>
        </div>
      </div>
    </article>
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

function DiscoverPage() {
  const [data, setData] = useState(null);
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
  const [draggingId, setDraggingId] = useState(null);
  const [dragOverId, setDragOverId] = useState(null);
  const [error, setError] = useState(null);
  const [libraryLookup, setLibraryLookup] = useState({});
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
  const navigate = useNavigate();

  const { isConnected: isDiscoverySocketConnected } = useWebSocketChannel(
    "discovery",
    (msg) => {
      if (msg.type === "discovery_update" && msg.recommendations) {
        lastDiscoveryWsMessageAtRef.current = Date.now();
        setData({
          recommendations: msg.recommendations || [],
          globalTop: msg.globalTop || [],
          basedOn: msg.basedOn || [],
          topTags: msg.topTags || [],
          topGenres: msg.topGenres || [],
          lastUpdated: msg.lastUpdated || null,
          isUpdating: false,
          stale: false,
          configured: true,
        });
      }
    },
  );

  useEffect(() => {
    if (!isDiscoverySocketConnected) return;
    if (!data?.isUpdating && !data?.stale) return;
    getDiscovery()
      .then((discoveryData) => {
        setData(discoveryData);
        setError(null);
      })
      .catch(() => {});
  }, [isDiscoverySocketConnected, data?.isUpdating, data?.stale]);

  useEffect(() => {
    if (!data?.isUpdating) return;
    const hasRecentWsUpdate =
      Date.now() - lastDiscoveryWsMessageAtRef.current < 20000;
    if (isDiscoverySocketConnected && hasRecentWsUpdate) return;
    const pollDiscovery = () => {
      getDiscovery(true)
        .then((next) => {
          setData(next);
          setError(null);
        })
        .catch(() => {});
    };
    pollDiscovery();
    const id = setInterval(pollDiscovery, 10000);
    return () => clearInterval(id);
  }, [data?.isUpdating, isDiscoverySocketConnected]);

  useEffect(() => {
    if (!data?.stale || data?.isUpdating) return;
    if (isDiscoverySocketConnected) return;
    const id = setTimeout(() => {
      getDiscovery(true)
        .then((next) => {
          setData(next);
          setError(null);
        })
        .catch(() => {});
    }, 15000);
    return () => clearTimeout(id);
  }, [data?.stale, data?.isUpdating, isDiscoverySocketConnected]);

  useEffect(() => {
    if (!data) return;
    if (data.isUpdating && !data.stale) {
      lastDiscoveryWsMessageAtRef.current = 0;
    }
  }, [data, data?.isUpdating, data?.stale]);

  useEffect(() => {
    getDiscovery()
      .then((discoveryData) => {
        setData(discoveryData);
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
          configured: false,
        });
      });

    getRecentlyAdded()
      .then(setRecentlyAdded)
      .catch(() => {});

    getRecentReleases()
      .then(setRecentReleases)
      .catch(() => {});

  }, []);

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
  }, []);

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
    try {
      const stored = localStorage.getItem(DISCOVER_LAYOUT_KEY);
      if (!stored) return;
      const parsed = JSON.parse(stored);
      if (!Array.isArray(parsed)) return;
      const byId = new Map(
        DEFAULT_DISCOVER_SECTIONS.map((item) => [item.id, item]),
      );
      const normalized = [];
      parsed.forEach((item) => {
        if (!item?.id || !byId.has(item.id)) return;
        const base = byId.get(item.id);
        normalized.push({
          ...base,
          enabled: item.enabled ?? base.enabled,
        });
        byId.delete(item.id);
      });
      byId.forEach((item) => normalized.push({ ...item }));
      setDiscoverSections(normalized);
    } catch {}
  }, []);

  useEffect(() => {
    const ids = recentReleases
      .map((album) => album.mbid || album.foreignAlbumId)
      .filter(Boolean);
    const missing = ids.filter(
      (id) => !releaseCovers[id] && !requestedReleaseCoversRef.current.has(id),
    );
    missing.forEach((id) => {
      requestedReleaseCoversRef.current.add(id);
      getReleaseGroupCover(id)
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
    const usedArtistIds = new Set();

    const sortedGenres = [...data.topGenres].sort((a, b) => a.localeCompare(b));

    for (const genre of sortedGenres) {
      if (sections.length >= 4) break;

      const genreArtists = data.recommendations.filter((artist) => {
        if (usedArtistIds.has(artist.id)) return false;

        const artistTags = artist.tags || [];
        return artistTags.some((tag) =>
          tag.toLowerCase().includes(genre.toLowerCase()),
        );
      });

      if (genreArtists.length >= 4) {
        const selectedArtists = genreArtists.slice(0, 6);

        selectedArtists.forEach((artist) => usedArtistIds.add(artist.id));

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
    for (const artist of recommendations) {
      const id = getArtistId(artist);
      if (id) ids.add(id);
    }
    for (const artist of globalTop) {
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
  }, [recommendations, globalTop, genreSections, recentlyAdded]);

  useEffect(() => {
    const cached = readLibraryLookupCache(discoverArtistIds);
    setLibraryLookup(cached);
    const missing = discoverArtistIds.filter((id) => cached[id] === undefined);
    if (missing.length === 0) return;
    let cancelled = false;
    const fetchLookup = async () => {
      try {
        const lookup = await lookupArtistsInLibraryBatch(missing);
        if (!cancelled && lookup) {
          setLibraryLookup((prev) => ({ ...prev, ...lookup }));
        }
      } catch {
        if (!cancelled) {
          setLibraryLookup((prev) => ({ ...prev }));
        }
      }
    };
    fetchLookup();
    return () => {
      cancelled = true;
    };
  }, [discoverArtistIds]);

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
    setDiscoverSections(draftSections.map((item) => ({ ...item })));
    try {
      localStorage.setItem(
        DISCOVER_LAYOUT_KEY,
        JSON.stringify(draftSections),
      );
    } catch {}
    setShowDiscoverModal(false);
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

  const orderedSectionIds = discoverSections
    .filter((item) => item.enabled)
    .map((item) => item.id);

  const renderSection = (id) => {
    if (id === "recentlyAdded") {
      if (!sectionAvailability.recentlyAdded) return null;
      return (
        <section
          key="recentlyAdded"
          className="animate-slide-up"
          style={{ animationDelay: "0.1s" }}
        >
          <div className="flex items-center justify-between mb-6">
            <h2
              className="text-2xl font-bold flex items-center"
              style={{ color: "#fff" }}
            >
              Recently Added
            </h2>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-6">
            {recentlyAdded.slice(0, 6).map((artist) => {
              const artistId = artist.foreignArtistId || artist.mbid || artist.id;
              return (
                <ArtistCard
                  key={`artist-${artist.id}`}
                  status="available"
                  isInLibrary={!!libraryLookup[artistId]}
                  onNavigate={navigate}
                  artist={{
                    id: artistId,
                    name: artist.artistName,
                    image: getLibraryArtistImage(artist),
                    type: "Artist",
                    subtitle: `Added ${new Date(
                      artist.added || artist.addedAt,
                    ).toLocaleDateString()}`,
                  }}
                />
              );
            })}
          </div>
        </section>
      );
    }

    if (id === "recentReleases") {
      if (!sectionAvailability.recentReleases) return null;
      return (
        <section
          key="recentReleases"
          className="animate-slide-up"
          style={{ animationDelay: "0.15s" }}
        >
          <div className="flex items-center justify-between mb-6">
            <h2
              className="text-2xl font-bold flex items-center"
              style={{ color: "#fff" }}
            >
              Recent & Upcoming Releases
            </h2>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-6">
            {recentReleases.slice(0, 6).map((album) => (
              <AlbumCard
                key={album.id || album.mbid || album.foreignAlbumId}
                album={album}
                releaseCovers={releaseCovers}
                artistCovers={artistCovers}
                onNavigate={navigate}
              />
            ))}
          </div>
        </section>
      );
    }

    if (id === "recommended") {
      return (
        <section key="recommended">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-2xl font-bold text-white flex items-center">
              Recommended for You
            </h2>
            <button
              onClick={() => navigate("/search?type=recommended")}
              className="text-sm font-medium hover:underline"
              style={{ color: "#c1c1c3" }}
            >
              View All
            </button>
          </div>

          {recommendations.length > 0 ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-6">
              {recommendations.slice(0, 12).map((artist) => (
                <ArtistCard
                  key={artist.id}
                  artist={artist}
                  isInLibrary={!!libraryLookup[getArtistId(artist)]}
                  onNavigate={navigate}
                />
              ))}
            </div>
          ) : (
            <div
              className="text-center py-12 px-4"
              style={{ backgroundColor: "#211f27" }}
            >
              <Music
                className="w-12 h-12 mx-auto mb-3"
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
        </section>
      );
    }

    if (id === "recommendedShows") {
      const zipModeActive = nearbyLocationMode === "zip";
      return (
        <section key="recommendedShows">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
              <h2 className="text-2xl font-bold text-white">Shows Near You</h2>
              {nearbyShowsData?.configured !== false && (
                <span className="hidden sm:inline-block px-2.5 py-1 text-xs font-medium rounded-full bg-white/5 text-white/60">
                  {nearbyLocationLabel}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <div className="inline-flex p-1 border border-white/10" style={{ backgroundColor: "#17161d" }}>
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
                    backgroundColor: !zipModeActive ? "#707e61" : "transparent",
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
                    backgroundColor: zipModeActive ? "#707e61" : "transparent",
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
                    className="inline-flex items-center justify-center w-8 h-8 border border-white/10 transition-colors"
                    style={{ backgroundColor: "#17161d", color: "#c1c1c3" }}
                    aria-label="Edit ZIP"
                    title="Edit ZIP"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                  {showNearbyZipEditor && (
                    <div
                      className="absolute right-0 top-10 z-20 w-52 p-2 border border-white/10"
                      style={{ backgroundColor: "#17161d" }}
                    >
                      <input
                        type="text"
                        value={nearbyZipDraft}
                        onChange={(event) => setNearbyZipDraft(event.target.value)}
                        className="input w-full mb-2"
                        placeholder="ZIP or postal code"
                      />
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => setShowNearbyZipEditor(false)}
                          className="px-2 py-1 text-xs border border-white/10"
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
            <div className="p-6 border border-white/10" style={{ backgroundColor: "#191820" }}>
              <h3 className="text-lg font-semibold" style={{ color: "#fff" }}>
                Ticketmaster not configured
              </h3>
              <p className="mt-2 text-sm max-w-2xl" style={{ color: "#c1c1c3" }}>
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
              <Loader className="w-8 h-8 animate-spin" style={{ color: "#c1c1c3" }} />
            </div>
          ) : nearbyShowsError ? (
            <div className="p-6 border border-white/10" style={{ backgroundColor: "#191820" }}>
              <h3 className="text-lg font-semibold" style={{ color: "#fff" }}>
                Unable to load nearby shows
              </h3>
              <p className="mt-2 text-sm" style={{ color: "#c1c1c3" }}>
                {nearbyShowsError}
              </p>
            </div>
          ) : zipModeActive && !appliedNearbyZip.trim() ? (
            <div className="p-6 border border-white/10" style={{ backgroundColor: "#191820" }}>
              <h3 className="text-lg font-semibold" style={{ color: "#fff" }}>
                ZIP not set
              </h3>
              <p className="mt-2 text-sm max-w-2xl" style={{ color: "#c1c1c3" }}>
                Set a ZIP code from the Shows page area settings to use ZIP mode here.
              </p>
            </div>
          ) : nearbyShows.length > 0 ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-5">
              {nearbyShows.slice(0, 5).map((show) => (
                <ShowCard key={`${show.id}-${show.artistName}`} show={show} />
              ))}
            </div>
          ) : (
            <div className="p-6 border border-white/10" style={{ backgroundColor: "#191820" }}>
              <h3 className="text-lg font-semibold" style={{ color: "#fff" }}>
                No upcoming nearby matches
              </h3>
              <p className="mt-2 text-sm max-w-2xl" style={{ color: "#c1c1c3" }}>
                We could not find local Ticketmaster shows for artists from your
                library around {nearbyLocationLabel}.
              </p>
            </div>
          )}
        </section>
      );
    }

    if (id === "globalTop") {
      if (!sectionAvailability.globalTop) return null;
      return (
        <section key="globalTop">
          <div className="flex items-center justify-between mb-6">
            <h2
              className="text-2xl font-bold flex items-center"
              style={{ color: "#fff" }}
            >
              Global Trending
            </h2>
            <button
              onClick={() => navigate("/search?type=trending")}
              className="text-sm font-medium hover:underline"
              style={{ color: "#c1c1c3" }}
            >
              View All
            </button>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-6">
            {globalTop.slice(0, 12).map((artist) => (
              <ArtistCard
                key={artist.id}
                artist={artist}
                isInLibrary={!!libraryLookup[getArtistId(artist)]}
                onNavigate={navigate}
              />
            ))}
          </div>
        </section>
      );
    }

    if (id === "genreSections") {
      if (!sectionAvailability.genreSections) return null;
      return (
        <div key="genreSections" className="space-y-10">
          {genreSections.map((section) => (
            <section key={section.genre}>
              <div className="flex items-center justify-between mb-2 pb-2">
                <h2
                  className="text-xl font-bold flex items-center"
                  style={{ color: "#fff" }}
                >
                  <span style={{ color: "#c1c1c3" }}>
                    Because you like{"\u00A0"}
                  </span>
                  <a
                    className="letter-roll"
                    href={`/search?q=${encodeURIComponent(section.genre)}&type=tag`}
                    aria-label={`View tag ${section.genre}`}
                  >
                    {buildLetterRollSpans(section.genre)}
                  </a>
                </h2>
                <button
                  onClick={() =>
                    navigate(
                      `/search?q=${encodeURIComponent(`#${section.genre}`)}&type=tag`,
                    )
                  }
                  className="text-sm font-medium hover:underline"
                  style={{ color: "#c1c1c3" }}
                >
                  See All
                </button>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-6">
                {section.artists.slice(0, 6).map((artist) => (
                  <ArtistCard
                    key={`${section.genre}-${artist.id}`}
                    artist={artist}
                    isInLibrary={!!libraryLookup[getArtistId(artist)]}
                    onNavigate={navigate}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      );
    }

    if (id === "topTags") {
      if (!sectionAvailability.topTags) return null;
      return (
        <section
          key="topTags"
          className="p-8"
          style={{ backgroundColor: "#211f27" }}
        >
          <div className="flex items-center mb-6">
            <h3 className="text-lg font-semibold" style={{ color: "#fff" }}>
              Explore by Tag
            </h3>
          </div>
          <div className="flex flex-wrap gap-2">
            {topTags.map((tag, i) => (
              <button
                key={i}
                onClick={() =>
                  navigate(
                    `/search?q=${encodeURIComponent(`#${tag}`)}&type=tag`,
                  )
                }
                className="genre-tag-pill px-3 py-1.5 text-sm"
                style={{ backgroundColor: getTagColor(tag), color: "#fff" }}
              >
                #{tag}
              </button>
            ))}
          </div>
        </section>
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
    <div className="space-y-10 pb-12">
      <section
        className="relative overflow-hidden"
        style={{
          color: "#fff",
          background:
            "linear-gradient(90deg, rgba(33,31,39,0.5) 50%, transparent 100%), linear-gradient(90deg, rgba(33,31,39,0.2) 0%, transparent 100%)",
        }}
      >
        <div className="relative p-6 md:p-8 flex flex-col gap-6">
          <div className="flex flex-col md:flex-row md:items-start justify-between gap-6">
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-3">
                <h1 className="text-3xl md:text-4xl font-bold" style={{ color: "#fff" }}>
                  Discover
                </h1>
                {lastUpdated && (
                  <span className="flex items-center text-xs font-medium mt-1.5 px-1.5 py-0.5 rounded-full" style={{ backgroundColor: "rgba(255,255,255,0.05)", color: "#8a8a8f" }}>
                    <Clock className="w-3 h-3 mr-1.5" />
                    Updated {new Date(lastUpdated).toLocaleDateString()}
                    {isUpdating && <Loader className="w-3 h-3 ml-2 animate-spin" />}
                  </span>
                )}
              </div>
              <p className="max-w-xl text-base" style={{ color: "#c1c1c3" }}>
                Your daily mix, curated from your library.
              </p>
            </div>
            
            <button
              type="button"
              onClick={openDiscoverModal}
              className="flex items-center gap-2 px-3 py-2 mt-1.5 rounded-md transition-colors hover:bg-white/5 border border-white/10 shrink-0"
              style={{ color: "#c1c1c3" }}
            >
              <LayoutTemplate className="w-4 h-4" />
              <span className="text-sm font-medium">Customize</span>
            </button>
          </div>

          <div className="flex flex-col gap-3 pt-4 border-t border-white/5">
            {topGenres.length > 0 && (
              <div className="flex flex-col gap-2.5">
                <h3 className="text-xs font-semibold uppercase tracking-wider" style={{ color: "#8a8a8f" }}>
                  Top Tags
                </h3>
                <div 
                  className="flex flex-wrap gap-2 max-h-[4rem] overflow-hidden"
                >
                  {topGenres.map((genre, i) => (
                    <button
                      key={i}
                      onClick={() => navigate(`/search?q=${encodeURIComponent(`#${genre}`)}&type=tag`)}
                      className="genre-tag-pill px-3 py-1.5 text-xs font-medium transition-opacity hover:opacity-90"
                      style={{ backgroundColor: getTagColor(genre), color: "#fff" }}
                    >
                      #{genre}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {heroBasedOn.length > 0 && (
              <p className="text-xs" style={{ color: "#8a8a8f" }}>
                Based on{" "}
                {heroBasedOn.length === 1
                  ? heroBasedOn[0].name
                  : heroBasedOn.length === 2
                    ? `${heroBasedOn[0].name} and ${heroBasedOn[1].name}`
                    : heroBasedOn.length === 3
                      ? `${heroBasedOn[0].name}, ${heroBasedOn[1].name} and ${heroBasedOn[2].name}`
                      : heroBasedOn
                          .slice(0, 2)
                          .map((a) => a.name)
                          .join(", ") +
                        ` and ${heroBasedOn.length - 2} other artist${heroBasedOn.length - 2 === 1 ? "" : "s"}`}
              </p>
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
                >
                  Save Layout
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

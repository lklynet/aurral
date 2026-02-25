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
} from "lucide-react";
import {
  getDiscovery,
  getRecentlyAdded,
  getRecentReleases,
  getReleaseGroupCover,
  getArtistCover,
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
  { id: "recentReleases", label: "Recent Releases", enabled: true },
  { id: "recommended", label: "Recommended for You", enabled: true },
  { id: "globalTop", label: "Global Trending", enabled: true },
  { id: "genreSections", label: "Because You Like", enabled: true },
  { id: "topTags", label: "Explore by Tag", enabled: true },
];

const ArtistCard = memo(
  ({ artist, status, onNavigate }) => {
    const navigateTo = artist.navigateTo || artist.id;
    const hasValidMbid =
      navigateTo && navigateTo !== "null" && navigateTo !== "undefined";
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
          <h3
            onClick={handleClick}
            className={`font-semibold truncate ${hasValidMbid ? "hover:underline cursor-pointer" : "cursor-not-allowed opacity-75"}`}
            style={{ color: "#fff" }}
          >
            {artist.name}
          </h3>
          <div className="flex flex-col min-w-0">
            <p className="text-sm truncate" style={{ color: "#c1c1c3" }}>
              {artist.type === "Person" ? "Artist" : artist.type}
              {artist.sourceArtist && ` • Similar to ${artist.sourceArtist}`}
            </p>
            {artist.subtitle && (
              <p className="text-xs truncate" style={{ color: "#c1c1c3" }}>
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
          >
            {album.albumName}
          </h3>
          <div className="flex flex-col min-w-0">
            <p className="text-sm truncate" style={{ color: "#c1c1c3" }}>
              {album.artistName || "Unknown Artist"}
            </p>
            {album.releaseDate && (
              <p className="text-xs truncate" style={{ color: "#c1c1c3" }}>
                Released {new Date(album.releaseDate).toLocaleDateString()}
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
  const requestedReleaseCoversRef = useRef(new Set());
  const requestedArtistCoversRef = useRef(new Set());
  const navigate = useNavigate();

  useWebSocketChannel("discovery", (msg) => {
    if (msg.type === "discovery_update" && msg.recommendations) {
      setData({
        recommendations: msg.recommendations || [],
        globalTop: msg.globalTop || [],
        basedOn: msg.basedOn || [],
        topTags: msg.topTags || [],
        topGenres: msg.topGenres || [],
        lastUpdated: msg.lastUpdated || null,
        isUpdating: false,
        configured: true,
      });
    }
  });

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

  const hasDataForPoll =
    data &&
    ((data.recommendations && data.recommendations.length > 0) ||
      (data.globalTop && data.globalTop.length > 0) ||
      (data.topGenres && data.topGenres.length > 0));

  useEffect(() => {
    if (!data?.isUpdating || hasDataForPoll) return;
    const pollDiscovery = () => {
      getDiscovery(true)
        .then(setData)
        .catch(() => {});
    };
    const id = setInterval(pollDiscovery, 8000);
    return () => clearInterval(id);
  }, [data?.isUpdating, hasDataForPoll]);

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

  const sectionAvailability = useMemo(
    () => ({
      recentlyAdded: recentlyAdded.length > 0,
      recentReleases: recentReleases.length > 0,
      recommended: true,
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
              return (
                <ArtistCard
                  key={`artist-${artist.id}`}
                  status="available"
                  onNavigate={navigate}
                  artist={{
                    id: artist.foreignArtistId || artist.mbid,
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
              Recent Releases
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
                <ArtistCard key={artist.id} artist={artist} onNavigate={navigate} />
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
              <ArtistCard key={artist.id} artist={artist} onNavigate={navigate} />
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
              <div className="flex items-center justify-between mb-6 pb-2">
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
        <div className="relative p-8 md:p-12">
          <div className="flex items-center justify-between mb-8">
            <div className="flex items-center gap-2 -ml-6 font-medium" style={{ color: "#fff" }}>
              <span>Your Daily Mix</span>
            </div>
            <button
              type="button"
              onClick={openDiscoverModal}
              className="flex items-center justify-center h-9 w-9 transition-colors"
              style={{
                color: "#c1c1c3",
              }}
              aria-label="Customize Discover layout"
            >
              <LayoutTemplate className="w-4 h-4" />
            </button>
          </div>
          <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-6 mb-8">
            <div>
              <h1
                className="text-3xl md:text-5xl font-bold mb-4"
                style={{ color: "#fff" }}
              >
                Music Discovery
              </h1>
              <p className="max-w-xl text-lg" style={{ color: "#c1c1c3" }}>
                Curated recommendations updated daily based on your library.
              </p>
            </div>

            <div className="flex flex-col items-end gap-2">
              {lastUpdated && (
                <div
                  className="flex items-center text-sm"
                  style={{ color: "#c1c1c3" }}
                >
                  <Clock className="w-3 h-3 mr-1.5" />
                  Updated {new Date(lastUpdated).toLocaleDateString()}
                  {isUpdating && (
                    <Loader className="w-3 h-3 ml-2 animate-spin" />
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="space-y-4">
            <div>
              <h3
                className="text-sm font-semibold uppercase tracking-wider mb-3"
                style={{ color: "#fff" }}
              >
                Your Top Tags
              </h3>
              <div className="flex flex-wrap gap-2 max-h-[5.5rem] overflow-hidden">
                {topGenres.map((genre, i) => (
                  <button
                    key={i}
                    onClick={() =>
                      navigate(
                        `/search?q=${encodeURIComponent(`#${genre}`)}&type=tag`,
                      )
                    }
                    className="genre-tag-pill px-4 py-2 text-sm font-medium"
                    style={{
                      backgroundColor: getTagColor(genre),
                      color: "#fff",
                    }}
                  >
                    #{genre}
                  </button>
                ))}
              </div>
            </div>

            {heroBasedOn.length > 0 && (
              <div className="pt-2">
                <p className="text-xs" style={{ color: "#c1c1c3" }}>
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
                  className={`flex items-center gap-4 px-4 py-3 border transition-transform transition-colors duration-200 ease-out cursor-grab select-none bg-[#1a191f] ${
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

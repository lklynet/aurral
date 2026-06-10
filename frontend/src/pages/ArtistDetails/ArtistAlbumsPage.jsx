import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import {
  ArrowDown,
  ArrowUp,
  CheckCircle,
  CornerUpLeft,
  Grid3X3,
  List,
  Loader,
  Music,
  SlidersHorizontal,
  Star,
} from "lucide-react";
import AddAlbumButton from "../../components/AddAlbumButton";
import { useAuth } from "../../contexts/AuthContext";
import { useToast } from "../../contexts/ToastContext";
import { useDocumentTitle } from "../../hooks/useDocumentTitle";
import { useArtistDetailsStream } from "./hooks/useArtistDetailsStream";
import { useArtistDetailsLibrary } from "./hooks/useArtistDetailsLibrary";
import { allReleaseTypes } from "./constants";
import { ArtistDetailsReleaseTrackList } from "./components/ArtistDetailsReleaseTrackList";
import {
  addSharedPlaylistTracks,
  createSharedPlaylist,
  getFlowStatus,
} from "../../utils/api";
import { getArtistPosterImage, getReleaseMetric, getReleaseYear } from "./utils";

const sortOptions = [
  { value: "date", label: "Date", defaultDirection: "desc" },
  { value: "name", label: "Name", defaultDirection: "asc" },
  { value: "popularity", label: "Popularity", defaultDirection: "desc" },
];

const releaseTabs = [
  { value: "all", label: "All" },
  { value: "albums", label: "Albums" },
  { value: "singles", label: "EP & Singles" },
  { value: "compilations", label: "Compilations" },
];

const normalizePlaylistNameKey = (value) =>
  String(value || "")
    .trim()
    .toLowerCase();

const reserveUniquePlaylistName = (playlists, baseName = "Playlist") => {
  const normalizedBase = String(baseName || "").trim() || "Playlist";
  const existing = new Set(
    (Array.isArray(playlists) ? playlists : [])
      .map((playlist) => normalizePlaylistNameKey(playlist?.name))
      .filter(Boolean),
  );
  if (!existing.has(normalizedBase.toLowerCase())) {
    return normalizedBase;
  }
  let index = 2;
  while (index < 10000) {
    const candidate = `${normalizedBase} ${index}`;
    if (!existing.has(candidate.toLowerCase())) {
      return candidate;
    }
    index += 1;
  }
  return `${normalizedBase} ${Date.now()}`;
};

const isCompilation = (releaseGroup) =>
  releaseGroup?.["primary-type"] === "Compilation" ||
  (releaseGroup?.["secondary-types"] || []).includes("Compilation");

const isSingleOrEp = (releaseGroup) =>
  releaseGroup?.["primary-type"] === "Single" ||
  releaseGroup?.["primary-type"] === "EP";

const matchesReleaseTab = (releaseGroup, tab) => {
  if (tab === "all") return true;
  if (tab === "compilations") return isCompilation(releaseGroup);
  if (tab === "singles") {
    return isSingleOrEp(releaseGroup) && !isCompilation(releaseGroup);
  }
  return releaseGroup?.["primary-type"] === "Album" && !isCompilation(releaseGroup);
};

const getReleaseTypeLabel = (releaseGroup) => {
  const types = [
    releaseGroup?.["primary-type"],
    ...(Array.isArray(releaseGroup?.["secondary-types"])
      ? releaseGroup["secondary-types"]
      : []),
  ].filter(Boolean);
  return types.length ? types.join(" · ") : "Release";
};

const sortReleaseGroups = (items, sortKey, sortDirection) =>
  [...items].sort((a, b) => {
    let diff;
    if (sortKey === "popularity") {
      diff = getReleaseMetric(a).sortValue - getReleaseMetric(b).sortValue;
    } else if (sortKey === "name") {
      diff = String(a?.title || "").localeCompare(String(b?.title || ""));
    } else {
      diff = String(a["first-release-date"] || "").localeCompare(
        String(b["first-release-date"] || ""),
      );
    }
    if (diff !== 0) return sortDirection === "asc" ? diff : -diff;
    return String(a?.title || "").localeCompare(String(b?.title || ""));
  });

const getGridColumnCount = () => {
  if (typeof window === "undefined") return 2;
  if (window.matchMedia("(min-width: 1280px)").matches) return 6;
  if (window.matchMedia("(min-width: 1024px)").matches) return 6;
  if (window.matchMedia("(min-width: 640px)").matches) return 3;
  return 2;
};

function ArtistAlbumsPage() {
  const { mbid } = useParams();
  const { state } = useLocation();
  const { showSuccess, showError } = useToast();
  const { hasPermission } = useAuth();
  const [selectedTab, setSelectedTab] = useState("all");
  const [sortKey, setSortKey] = useState("date");
  const [sortDirection, setSortDirection] = useState("desc");
  const [viewMode, setViewMode] = useState("grid");
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [gridColumnCount, setGridColumnCount] = useState(getGridColumnCount);
  const [visibleCoverIds, setVisibleCoverIds] = useState([]);
  const [sharedPlaylists, setSharedPlaylists] = useState([]);
  const [playlistModalLoading, setPlaylistModalLoading] = useState(false);
  const [playlistModalError, setPlaylistModalError] = useState("");
  const [playlistMenuSavingKey, setPlaylistMenuSavingKey] = useState("");
  const optionsMenuRef = useRef(null);
  const artistNameFromNav = state?.artistName || "";
  const canAddAlbum = hasPermission("addAlbum");

  const stream = useArtistDetailsStream(mbid, artistNameFromNav, allReleaseTypes, {
    visibleCoverIds,
    initialLibraryHint: {
      existsInLibrary:
        typeof state?.inLibrary === "boolean" ? state.inLibrary : undefined,
      libraryArtist: state?.libraryArtist || null,
    },
  });

  const {
    artist,
    libraryArtist,
    setLibraryArtist,
    libraryAlbums,
    setLibraryAlbums,
    loading,
    error,
    loadingReleases,
    existsInLibrary,
    setExistsInLibrary,
    appSettings,
    albumCovers,
    coverImages,
  } = stream;
  const artistCoverImage = getArtistPosterImage(coverImages);

  const artistDisplayName = artist?.name || artistNameFromNav || "";
  useDocumentTitle(
    artistDisplayName ? `${artistDisplayName}'s Releases` : "",
  );

  const library = useArtistDetailsLibrary({
    artist,
    libraryArtist,
    setLibraryArtist,
    libraryAlbums,
    setLibraryAlbums,
    existsInLibrary,
    setExistsInLibrary,
    appSettings,
    showSuccess,
    showError,
    selectedReleaseTypes: allReleaseTypes,
  });

  const releaseGroups = useMemo(
    () => artist?.["release-groups"] || [],
    [artist],
  );
  const filteredReleaseGroups = useMemo(
    () =>
      sortReleaseGroups(
        releaseGroups.filter((releaseGroup) =>
          matchesReleaseTab(releaseGroup, selectedTab),
        ),
        sortKey,
        sortDirection,
      ),
    [releaseGroups, selectedTab, sortDirection, sortKey],
  );

  useEffect(() => {
    setVisibleCoverIds(filteredReleaseGroups.map((item) => item.id).filter(Boolean));
  }, [filteredReleaseGroups]);

  useEffect(() => {
    const updateGridColumnCount = () => setGridColumnCount(getGridColumnCount());
    updateGridColumnCount();
    window.addEventListener("resize", updateGridColumnCount);
    return () => window.removeEventListener("resize", updateGridColumnCount);
  }, []);

  useEffect(() => {
    if (!optionsOpen) return undefined;
    const handlePointerDown = (event) => {
      if (optionsMenuRef.current?.contains(event.target)) return;
      setOptionsOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [optionsOpen]);

  const handleSortOptionClick = (option) => {
    if (sortKey === option.value) {
      setSortDirection((current) => (current === "asc" ? "desc" : "asc"));
      return;
    }
    setSortKey(option.value);
  };

  const loadSharedPlaylists = async () => {
    setPlaylistModalLoading(true);
    try {
      const data = await getFlowStatus();
      const playlists = Array.isArray(data?.sharedPlaylists)
        ? data.sharedPlaylists
        : [];
      setSharedPlaylists(playlists);
      return playlists;
    } catch (err) {
      const message =
        err.response?.data?.message ||
        err.response?.data?.error ||
        err.message ||
        "Failed to load playlists";
      setPlaylistModalError(message);
      showError(message);
      return null;
    } finally {
      setPlaylistModalLoading(false);
    }
  };

  const getDefaultTrackPlaylistName = (track) =>
    reserveUniquePlaylistName(
      sharedPlaylists,
      `${artist?.name || artistNameFromNav || track?.artistName || "Artist"} Picks`,
    );

  const buildReleaseTrackPayload = (track, releaseGroup) => {
    const year = String(releaseGroup?.["first-release-date"] || "").slice(0, 4);
    return {
      artistName: artist?.name || artistNameFromNav || "",
      trackName: track?.trackName || track?.title || "",
      albumName: releaseGroup?.title || "",
      artistMbid: mbid || "",
      albumMbid: releaseGroup?.id || "",
      trackMbid: track?.mbid || track?.id || "",
      releaseYear: year || null,
      durationMs:
        track?.length != null && Number.isFinite(Number(track.length))
          ? Number(track.length)
          : null,
      reason: null,
      artistAliases: [],
    };
  };

  const saveTrackToPlaylist = async (trackPayload, target, savingKey) => {
    if (!trackPayload?.artistName || !trackPayload?.trackName) {
      showError("Track details are incomplete");
      return;
    }
    setPlaylistModalError("");
    setPlaylistMenuSavingKey(String(savingKey || ""));
    try {
      if (target?.mode === "new") {
        const name =
          String(target?.name || "").trim() ||
          reserveUniquePlaylistName(
            sharedPlaylists,
            `${trackPayload.artistName} Picks`,
          );
        const response = await createSharedPlaylist({
          name,
          tracks: [trackPayload],
        });
        showSuccess(`Track saved to ${response?.playlist?.name || name}`);
      } else {
        const targetPlaylist = sharedPlaylists.find(
          (playlist) => playlist.id === target?.playlistId,
        );
        await addSharedPlaylistTracks(target.playlistId, {
          tracks: [trackPayload],
        });
        showSuccess(`Track added to ${targetPlaylist?.name || "playlist"}`);
      }
      const nextPlaylists = await loadSharedPlaylists();
      if (nextPlaylists) {
        setSharedPlaylists(nextPlaylists);
      }
    } catch (err) {
      const message =
        err.response?.data?.message ||
        err.response?.data?.error ||
        err.message ||
        "Failed to save track to playlist";
      setPlaylistModalError(message);
      showError(message);
    } finally {
      setPlaylistMenuSavingKey("");
    }
  };

  const handleReleaseTrackAdd = (track, releaseGroup, target) => {
    const payload = buildReleaseTrackPayload(track, releaseGroup);
    const savingKey = String(track?.id ?? track?.mbid ?? "");
    return saveTrackToPlaylist(payload, target, savingKey);
  };

  if (loading) {
    return (
      <div className="artist-loading">
        <Loader className="artist-spinner animate-spin" />
      </div>
    );
  }

  if (error || !artist) {
    return (
      <div className="artist-empty-panel">
        <p className="artist-modal__subcopy">{error || "Artist not found"}</p>
      </div>
    );
  }

  const renderReleaseCard = (releaseGroup) => {
    const status = library.getAlbumStatus(releaseGroup.id);
    const metric = getReleaseMetric(releaseGroup);
    const cover = albumCovers[releaseGroup.id] || artistCoverImage;
    const isComplete = status?.status === "available" || status?.status === "added";
    const releaseTypeLabel = getReleaseTypeLabel(releaseGroup);

    if (viewMode === "list") {
      return (
        <div
          key={releaseGroup.id}
          className="artist-release-list-item"
          onClick={() =>
            library.handleReleaseGroupAlbumClick(releaseGroup, status?.libraryId)
          }
        >
          <div className="artist-media-cell artist-list-cover">
            {cover ? (
              <img src={cover} alt="" loading="lazy" />
            ) : (
              <div className="artist-media-placeholder">
                <Music className="artist-icon-md" />
              </div>
            )}
          </div>
          <div className="artist-min-0">
            <h2 className="artist-release-card__title artist-truncate">{releaseGroup.title}</h2>
            <p className="artist-release-card__meta artist-truncate">
              {[getReleaseYear(releaseGroup), releaseTypeLabel]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </div>
          <div className="artist-row-actions">
            {metric.label && (
              <span className="artist-release-card__metric artist-hidden-mobile">
                <Star className="artist-star-icon" />
                {metric.label}
              </span>
            )}
            {isComplete ? (
              <span
                className="artist-release-card__status"
                title="Complete"
              >
                <CheckCircle className="artist-icon-sm" />
                <span className="sr-only">Complete</span>
              </span>
            ) : canAddAlbum ? (
              <div onClick={(event) => event.stopPropagation()}>
                <AddAlbumButton
                  onClick={(event) => {
                    event.stopPropagation();
                    library.handleRequestAlbum(releaseGroup.id, releaseGroup.title);
                  }}
                  isLoading={library.requestingAlbum === releaseGroup.id}
                  disabled={library.requestingAlbum === releaseGroup.id}
                />
              </div>
            ) : null}
          </div>
        </div>
      );
    }

    return (
      <article
        key={releaseGroup.id}
        className="artist-release-card"
        onClick={() =>
          library.handleReleaseGroupAlbumClick(releaseGroup, status?.libraryId)
        }
      >
        <div className="artist-release-card__cover">
          {cover ? (
            <img
              src={cover}
              alt=""
              loading="lazy"
              decoding="async"
            />
          ) : (
            <div className="artist-release-card__placeholder">
              <Music className="artist-icon-lg" />
            </div>
          )}
          <div className="artist-release-card__action">
            {isComplete ? (
              <span
                className="artist-release-card__status"
                title="Complete"
              >
                <CheckCircle className="artist-icon-sm" />
                <span className="sr-only">Complete</span>
              </span>
            ) : canAddAlbum ? (
              <div onClick={(event) => event.stopPropagation()}>
                <AddAlbumButton
                  onClick={(event) => {
                    event.stopPropagation();
                    library.handleRequestAlbum(releaseGroup.id, releaseGroup.title);
                  }}
                  isLoading={library.requestingAlbum === releaseGroup.id}
                  disabled={library.requestingAlbum === releaseGroup.id}
                />
              </div>
            ) : null}
          </div>
        </div>
        <h2 className="artist-release-card__title artist-clamp-2">
          {releaseGroup.title}
        </h2>
        <p className="artist-release-card__meta artist-truncate">
          {[getReleaseYear(releaseGroup), releaseTypeLabel]
            .filter(Boolean)
            .join(" · ")}
        </p>
        {metric.label && (
          <p className="artist-release-card__metric">
            <Star className="artist-star-icon" />
            {metric.label}
          </p>
        )}
      </article>
    );
  };

  const expandedRelease = filteredReleaseGroups.find(
    (releaseGroup) => releaseGroup.id === library.expandedReleaseGroup,
  );
  const expandedStatus = expandedRelease
    ? library.getAlbumStatus(expandedRelease.id)
    : null;
  const expandedTrackKey = expandedStatus?.libraryId || expandedRelease?.id;
  const expandedTracks = expandedTrackKey ? library.albumTracks[expandedTrackKey] : null;
  const expandedLoading = expandedTrackKey
    ? library.loadingTracks[expandedTrackKey]
    : false;
  const expandedReleaseIndex = expandedRelease
    ? filteredReleaseGroups.findIndex(
        (releaseGroup) => releaseGroup.id === expandedRelease.id,
      )
    : -1;
  const expandedRenderAfterIndex =
    expandedReleaseIndex < 0
      ? -1
      : viewMode === "grid"
        ? Math.min(
            expandedReleaseIndex +
              (gridColumnCount - 1 - (expandedReleaseIndex % gridColumnCount)),
            filteredReleaseGroups.length - 1,
          )
        : expandedReleaseIndex;

  return (
    <div className="artist-details-page">
      <div className="artist-page-header">
        <div>
          <Link
            to={`/artist/${artist.id}`}
            state={{ artistName: artist.name, inLibrary: existsInLibrary }}
            className="artist-title-link"
          >
            <span>{artist.name}</span>
            <CornerUpLeft className="artist-icon-lg" />
          </Link>
          {loadingReleases && (
            <p className="artist-meta-line">
              <Loader className="artist-icon-sm animate-spin" />
              Loading releases
            </p>
          )}
        </div>
      </div>

      <div className="artist-heading-row artist-page-header">
        <div className="artist-min-0">
          <div className="artist-tabs">
            {releaseTabs.map((tab) => {
              const active = selectedTab === tab.value;
              return (
                <button
                  key={tab.value}
                  type="button"
                  onClick={() => setSelectedTab(tab.value)}
                  className={`artist-tab${active ? " is-active" : ""}`}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>
        </div>

        <div className="artist-options" ref={optionsMenuRef}>
          <button
            type="button"
            onClick={() => setOptionsOpen((current) => !current)}
            className="btn btn-surface btn-icon-square"
            aria-label="Album display options"
            title="Album display options"
            aria-expanded={optionsOpen}
          >
            <SlidersHorizontal className="artist-icon-sm" />
          </button>
          {optionsOpen && (
            <div className="artist-options-menu">
              {sortOptions.map((option) => {
                const active = sortKey === option.value;
                const DirectionIcon = sortDirection === "asc" ? ArrowUp : ArrowDown;
                return (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => handleSortOptionClick(option)}
                    className={`artist-menu-item${active ? " is-active" : ""}`}
                  >
                    <span>{option.label}</span>
                    <span>
                      {active && <DirectionIcon className="artist-icon-xs" />}
                    </span>
                  </button>
                );
              })}
              <div className="artist-menu-section" />
              <div className="artist-options-view-grid">
                <button
                  type="button"
                  onClick={() => setViewMode("grid")}
                  className={`btn btn-icon-square btn-surface${viewMode === "grid" ? " btn-neutral-active" : ""}`}
                  aria-label="Grid view"
                  title="Grid view"
                >
                  <Grid3X3 className="artist-icon-sm" />
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode("list")}
                  className={`btn btn-icon-square btn-surface${viewMode === "list" ? " btn-neutral-active" : ""}`}
                  aria-label="List view"
                  title="List view"
                >
                  <List className="artist-icon-sm" />
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="artist-count">
        {filteredReleaseGroups.length.toLocaleString()} release
        {filteredReleaseGroups.length === 1 ? "" : "s"}
      </div>

      <div
        className={
          viewMode === "grid"
            ? "artist-albums-grid"
            : "artist-release-list"
        }
      >
        {filteredReleaseGroups.map((releaseGroup, index) => (
          <Fragment key={releaseGroup.id}>
            {renderReleaseCard(releaseGroup)}
            {expandedRelease && expandedRenderAfterIndex === index && (
              <div className={viewMode === "grid" ? "artist-grid-full" : ""}>
                <ArtistDetailsReleaseTrackList
                  release={expandedRelease}
                  trackKey={expandedTrackKey}
                  tracks={expandedTracks}
                  loading={expandedLoading}
                  playbackSource={{
                    type: "artist",
                    id: mbid,
                    label: artistDisplayName,
                  }}
                  artistName={artistDisplayName}
                  onAddTrackToPlaylist={handleReleaseTrackAdd}
                  playlists={sharedPlaylists}
                  playlistsLoading={playlistModalLoading}
                  playlistSavingKey={playlistMenuSavingKey}
                  playlistError={playlistModalError}
                  getDefaultPlaylistName={getDefaultTrackPlaylistName}
                  onLoadPlaylists={loadSharedPlaylists}
                />
              </div>
            )}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

export default ArtistAlbumsPage;

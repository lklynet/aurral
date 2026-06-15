import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import {
  ArrowDown,
  ArrowUp,
  CornerUpLeft,
  Grid3X3,
  List,
  Loader,
  Music,
  SlidersHorizontal,
  Star,
} from "lucide-react";
import AddAlbumButton from "../../components/AddAlbumButton";
import SearchLibraryCheck from "../../components/SearchLibraryCheck";
import { useAuth } from "../../contexts/AuthContext";
import { useToast } from "../../contexts/ToastContext";
import { useDocumentTitle } from "../../hooks/useDocumentTitle";
import { useArtistDetailsStream } from "./hooks/useArtistDetailsStream";
import { useArtistDetailsLibrary } from "./hooks/useArtistDetailsLibrary";
import { useArtistSearchFocus } from "./hooks/useArtistSearchFocus";
import { allReleaseTypes } from "./constants";
import { navigateToReleaseGroup } from "../../utils/searchNavigation";
import { getArtistPosterImage, getReleaseMetric, getReleaseYear, readReleaseListViewMode, writeReleaseListViewMode } from "./utils";

const APPEARS_ON_LIMIT = 250;

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

function ArtistAppearsOnPage() {
  const { mbid } = useParams();
  const { state } = useLocation();
  const navigate = useNavigate();
  const { showSuccess, showError } = useToast();
  const { hasPermission } = useAuth();
  const [selectedTab, setSelectedTab] = useState("all");
  const [sortKey, setSortKey] = useState("date");
  const [sortDirection, setSortDirection] = useState("desc");
  const [viewMode, setViewMode] = useState(() => readReleaseListViewMode());
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [visibleCoverIds, setVisibleCoverIds] = useState([]);
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
    appearsOnLimit: APPEARS_ON_LIMIT,
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
    artistDisplayName ? `Featuring ${artistDisplayName}` : "",
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
    () => artist?.["appears-on-release-groups"] || [],
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

  useArtistSearchFocus({
    navigate,
    mbid,
    locationState: state,
  });

  useEffect(() => {
    setVisibleCoverIds(filteredReleaseGroups.map((item) => item.id).filter(Boolean));
  }, [filteredReleaseGroups]);

  useEffect(() => {
    if (!optionsOpen) return undefined;
    const handlePointerDown = (event) => {
      if (optionsMenuRef.current?.contains(event.target)) return;
      setOptionsOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [optionsOpen]);

  const handleViewModeChange = (mode) => {
    setViewMode(mode);
    writeReleaseListViewMode(mode);
  };

  const handleSortOptionClick = (option) => {
    if (sortKey === option.value) {
      setSortDirection((current) => (current === "asc" ? "desc" : "asc"));
      return;
    }
    setSortKey(option.value);
  };

  const openRelease = (releaseGroup) => {
    navigateToReleaseGroup(navigate, releaseGroup, {
      artistMbid: mbid,
      artistName: artistDisplayName,
      coverUrl: albumCovers[releaseGroup.id] || artistCoverImage || "",
    });
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
    const artistCredit = releaseGroup["artist-credit"]?.[0]?.name || "";

    if (viewMode === "list") {
      return (
        <div
          key={releaseGroup.id}
          className="artist-release-list-item"
          onClick={() => openRelease(releaseGroup)}
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
              {[getReleaseYear(releaseGroup), artistCredit || releaseTypeLabel]
                .filter(Boolean)
                .join(" · ")}
            </p>
            {releaseGroup._appearsOnTrack ? (
              <p className="artist-release-card__meta artist-truncate">
                {releaseGroup._appearsOnTrack}
              </p>
            ) : null}
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
                <SearchLibraryCheck size="overlay" />
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
        onClick={() => openRelease(releaseGroup)}
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
                <SearchLibraryCheck size="overlay" />
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
          {[getReleaseYear(releaseGroup), artistCredit || releaseTypeLabel]
            .filter(Boolean)
            .join(" · ")}
        </p>
        {releaseGroup._appearsOnTrack ? (
          <p className="artist-release-card__meta artist-truncate">
            {releaseGroup._appearsOnTrack}
          </p>
        ) : null}
        {metric.label && (
          <p className="artist-release-card__metric">
            <Star className="artist-star-icon" />
            {metric.label}
          </p>
        )}
      </article>
    );
  };

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
              Loading appearances
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
            aria-label="Appears on display options"
            title="Appears on display options"
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
                  onClick={() => handleViewModeChange("grid")}
                  className={`btn btn-icon-square btn-surface${viewMode === "grid" ? " is-active" : ""}`}
                  aria-label="Grid view"
                  title="Grid view"
                  aria-pressed={viewMode === "grid"}
                >
                  <Grid3X3 className="artist-icon-sm" />
                </button>
                <button
                  type="button"
                  onClick={() => handleViewModeChange("list")}
                  className={`btn btn-icon-square btn-surface${viewMode === "list" ? " is-active" : ""}`}
                  aria-label="List view"
                  title="List view"
                  aria-pressed={viewMode === "list"}
                >
                  <List className="artist-icon-sm" />
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="artist-count">
        {filteredReleaseGroups.length.toLocaleString()} appearance
        {filteredReleaseGroups.length === 1 ? "" : "s"}
      </div>

      <div
        className={
          viewMode === "grid"
            ? "artist-albums-grid"
            : "artist-release-list"
        }
      >
        {filteredReleaseGroups.map((releaseGroup) =>
          renderReleaseCard(releaseGroup),
        )}
      </div>
    </div>
  );
}

export default ArtistAppearsOnPage;

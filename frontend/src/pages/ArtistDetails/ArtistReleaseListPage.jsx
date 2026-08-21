import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { useDiscoverNavigation } from "../../hooks/useDiscoverNavigation";
import { DotLoader } from "../../components/DotLoader";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  CornerUpLeft,
  LayoutGrid,
  List,
  Music,
  Search,
  Star,
} from "lucide-react";
import AddActionButton from "../../components/AddActionButton";
import PillToggle from "../../components/PillToggle";
import SearchLibraryCheck from "../../components/SearchLibraryCheck";
import { useAuth } from "../../contexts/AuthContext";
import { useToast } from "../../contexts/ToastContext";
import { useDocumentTitle } from "../../hooks/useDocumentTitle";
import { useArtistDetailsStream } from "./hooks/useArtistDetailsStream";
import { useArtistDetailsLibrary } from "./hooks/useArtistDetailsLibrary";
import { useArtistSearchFocus } from "./hooks/useArtistSearchFocus";
import { navigateToReleaseGroup } from "../../utils/searchNavigation";
import {
  getCoverImage,
  getReleaseGroupCoverUrl,
  getReleaseMetric,
  getReleaseYear,
  readReleaseListViewMode,
  writeReleaseListViewMode,
} from "./utils";
import {
  matchesReleaseGroupSearch,
  matchesReleaseGroupTab,
} from "./releaseFilters.js";
import { getAlbumAddButtonLabel } from "../../utils/albumAddAction";
import {
  getArtistAppearsOnPage,
  getReleaseGroupRatingsBatch,
} from "../../utils/api/endpoints/artists.js";

const RELEASE_PAGE_SIZE = 24;

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

const getReleaseTypeLabel = (releaseGroup) => {
  const types = [
    releaseGroup?.["primary-type"],
    ...(Array.isArray(releaseGroup?.["secondary-types"]) ? releaseGroup["secondary-types"] : []),
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

function ArtistReleaseListPage({ mode = "releases" }) {
  const isAppearsOn = mode === "appearsOn";
  const { mbid } = useParams();
  const { state } = useLocation();
  const navigate = useDiscoverNavigation();
  const { showSuccess, showError } = useToast();
  const { hasPermission } = useAuth();
  const [selectedTab, setSelectedTab] = useState("all");
  const [showLiveAlbums, setShowLiveAlbums] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [sortKey, setSortKey] = useState("date");
  const [sortDirection, setSortDirection] = useState("desc");
  const [viewMode, setViewMode] = useState(() => readReleaseListViewMode());
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const [visibleCoverIds, setVisibleCoverIds] = useState([]);
  const [visibleReleaseCount, setVisibleReleaseCount] = useState(RELEASE_PAGE_SIZE);
  const [hasMoreAppearances, setHasMoreAppearances] = useState(true);
  const [loadingMoreAppearances, setLoadingMoreAppearances] = useState(false);
  const toolbarRef = useRef(null);
  const requestedRatingIdsRef = useRef(new Set());
  const artistNameFromNav = state?.artistName || "";
  const canAddAlbum = hasPermission("addAlbum");

  const stream = useArtistDetailsStream(mbid, artistNameFromNav, {
    visibleCoverIds,
    initialLibraryHint: {
      existsInLibrary: typeof state?.inLibrary === "boolean" ? state.inLibrary : undefined,
      libraryArtist: state?.libraryArtist || null,
    },
    appearsOnLimit: isAppearsOn ? RELEASE_PAGE_SIZE : null,
  });

  const {
    artist,
    setArtist,
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
    fulfilledCoverIds,
    coverImages,
  } = stream;
  const artistCoverImage = getCoverImage(coverImages);

  const artistDisplayName = artist?.name || artistNameFromNav || "";
  useDocumentTitle(
    artistDisplayName
      ? isAppearsOn
        ? `Featuring ${artistDisplayName}`
        : `${artistDisplayName}'s Releases`
      : "",
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
  });

  const releaseGroups = useMemo(
    () =>
      artist?.[isAppearsOn ? "appears-on-release-groups" : "release-groups"] || [],
    [artist, isAppearsOn],
  );
  const filteredReleaseGroups = useMemo(
    () =>
      sortReleaseGroups(
        releaseGroups.filter(
          (releaseGroup) =>
            matchesReleaseGroupTab(releaseGroup, selectedTab, showLiveAlbums) &&
            matchesReleaseGroupSearch(releaseGroup, searchTerm),
        ),
        sortKey,
        sortDirection,
      ),
    [releaseGroups, searchTerm, selectedTab, showLiveAlbums, sortDirection, sortKey],
  );
  const renderedReleaseGroups = useMemo(
    () => filteredReleaseGroups.slice(0, visibleReleaseCount),
    [filteredReleaseGroups, visibleReleaseCount],
  );

  useArtistSearchFocus({
    navigate,
    mbid,
    locationState: state,
  });

  useEffect(() => {
    setVisibleCoverIds(renderedReleaseGroups.map((item) => item.id).filter(Boolean));
  }, [renderedReleaseGroups]);

  useEffect(() => {
    setVisibleReleaseCount(RELEASE_PAGE_SIZE);
  }, [searchTerm, selectedTab, showLiveAlbums]);

  useEffect(() => {
    setVisibleReleaseCount(RELEASE_PAGE_SIZE);
    setHasMoreAppearances(true);
    setLoadingMoreAppearances(false);
    requestedRatingIdsRef.current = new Set();
  }, [isAppearsOn, mbid]);

  useEffect(() => {
    if (isAppearsOn || loadingReleases) return;
    const ids = renderedReleaseGroups
      .map((item) => item?.id)
      .filter((id) => id && !requestedRatingIdsRef.current.has(id));
    if (!ids.length) return;
    ids.forEach((id) => requestedRatingIdsRef.current.add(id));
    let cancelled = false;
    getReleaseGroupRatingsBatch(ids)
      .then((data) => {
        if (cancelled) return;
        const ratings = data?.ratings || {};
        setArtist((previous) => {
          if (!previous) return previous;
          return {
            ...previous,
            "release-groups": (previous["release-groups"] || []).map((releaseGroup) => {
              const update = ratings[releaseGroup.id];
              if (!update) return releaseGroup;
              return {
                ...releaseGroup,
                rating: update.rating || releaseGroup.rating || null,
                "first-release-date":
                  releaseGroup["first-release-date"] || update.firstReleaseDate || null,
              };
            }),
          };
        });
      })
      .catch(() => {
        ids.forEach((id) => requestedRatingIdsRef.current.delete(id));
      });
    return () => {
      cancelled = true;
    };
  }, [isAppearsOn, loadingReleases, renderedReleaseGroups, setArtist]);

  const loadNextPage = useCallback(async () => {
    if (visibleReleaseCount < filteredReleaseGroups.length) {
      setVisibleReleaseCount((current) => current + RELEASE_PAGE_SIZE);
      return;
    }
    if (!isAppearsOn || !hasMoreAppearances || loadingMoreAppearances) return;

    setLoadingMoreAppearances(true);
    try {
      const data = await getArtistAppearsOnPage(mbid, {
        offset: releaseGroups.length,
        limit: RELEASE_PAGE_SIZE,
        excludeIds: releaseGroups.map((item) => item.id).filter(Boolean),
      });
      const items = Array.isArray(data?.items) ? data.items : [];
      if (items.length) {
        setArtist((previous) => {
          if (!previous) return previous;
          const existing = previous["appears-on-release-groups"] || [];
          const byId = new Map(existing.map((item) => [item.id, item]));
          items.forEach((item) => byId.set(item.id, item));
          return {
            ...previous,
            "appears-on-release-groups": [...byId.values()],
          };
        });
        setVisibleReleaseCount((current) => current + items.length);
      }
      setHasMoreAppearances(Boolean(data?.hasMore));
    } catch {
      // Keep the button available so the user can retry a transient failure.
    } finally {
      setLoadingMoreAppearances(false);
    }
  }, [
    filteredReleaseGroups.length,
    hasMoreAppearances,
    isAppearsOn,
    loadingMoreAppearances,
    mbid,
    releaseGroups,
    setArtist,
    visibleReleaseCount,
  ]);

  useEffect(() => {
    if (!sortMenuOpen) return undefined;
    const handlePointerDown = (event) => {
      if (toolbarRef.current?.contains(event.target)) return;
      setSortMenuOpen(false);
    };
    const handleKeyDown = (event) => {
      if (event.key === "Escape") setSortMenuOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [sortMenuOpen]);

  const handleViewModeChange = (next) => {
    setViewMode(next);
    writeReleaseListViewMode(next);
  };

  const handleSortOptionClick = (option) => {
    if (sortKey === option.value) {
      setSortDirection((current) => (current === "asc" ? "desc" : "asc"));
      setSortMenuOpen(false);
      return;
    }
    setSortKey(option.value);
    setSortDirection(option.defaultDirection);
    setSortMenuOpen(false);
  };

  const openRelease = (releaseGroup) => {
    navigateToReleaseGroup(navigate, releaseGroup, {
      artistMbid: mbid,
      artistName: artistDisplayName,
      coverUrl: getReleaseGroupCoverUrl(releaseGroup, albumCovers, {
        artistFallback: artistCoverImage,
        resolved: fulfilledCoverIds?.has(releaseGroup.id),
      }),
    });
  };

  if (loading) {
    return (
      <div className="artist-loading">
        <DotLoader size="xl" label={null} />
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
    const cover = getReleaseGroupCoverUrl(releaseGroup, albumCovers, {
      artistFallback: artistCoverImage,
      resolved: fulfilledCoverIds?.has(releaseGroup.id),
    });
    const isComplete = status?.status === "available" || status?.status === "added";
    const releaseTypeLabel = getReleaseTypeLabel(releaseGroup);
    const artistCredit = isAppearsOn ? releaseGroup["artist-credit"]?.[0]?.name || "" : "";
    const metaLabel = [getReleaseYear(releaseGroup), artistCredit || releaseTypeLabel]
      .filter(Boolean)
      .join(" · ");

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
            <p className="artist-release-card__meta artist-truncate">{metaLabel}</p>
            {isAppearsOn && releaseGroup._appearsOnTrack ? (
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
              <span className="artist-release-card__status" title="Complete">
                <SearchLibraryCheck size="overlay" />
                <span className="sr-only">Complete</span>
              </span>
            ) : canAddAlbum ? (
              <div onClick={(event) => event.stopPropagation()}>
                <AddActionButton
                  onClick={(event) => {
                    event.stopPropagation();
                    library.handleRequestAlbum(releaseGroup.id, releaseGroup.title);
                  }}
                  isLoading={library.requestingAlbum === releaseGroup.id}
                  disabled={library.requestingAlbum === releaseGroup.id}
                  label={getAlbumAddButtonLabel({ status: status?.status })}
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
            <img src={cover} alt="" loading="lazy" decoding="async" />
          ) : (
            <div className="artist-release-card__placeholder">
              <Music className="artist-icon-lg" />
            </div>
          )}
          <div className="artist-release-card__action">
            {isComplete ? (
              <span className="artist-release-card__status" title="Complete">
                <SearchLibraryCheck size="overlay" />
                <span className="sr-only">Complete</span>
              </span>
            ) : canAddAlbum ? (
              <div onClick={(event) => event.stopPropagation()}>
                <AddActionButton
                  onClick={(event) => {
                    event.stopPropagation();
                    library.handleRequestAlbum(releaseGroup.id, releaseGroup.title);
                  }}
                  isLoading={library.requestingAlbum === releaseGroup.id}
                  disabled={library.requestingAlbum === releaseGroup.id}
                  label={getAlbumAddButtonLabel({ status: status?.status })}
                />
              </div>
            ) : null}
          </div>
        </div>
        <h2
          className={`artist-release-card__title ${isAppearsOn ? "artist-clamp-2" : "artist-truncate"}`}
          title={releaseGroup.title}
        >
          {releaseGroup.title}
        </h2>
        <p className="artist-release-card__meta artist-truncate">{metaLabel}</p>
        {isAppearsOn && releaseGroup._appearsOnTrack ? (
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

  const noun = isAppearsOn ? "appearance" : "release";
  const selectedSort = sortOptions.find((option) => option.value === sortKey) || sortOptions[0];
  const SortDirectionIcon = sortDirection === "asc" ? ArrowUp : ArrowDown;
  const searchLabel = isAppearsOn ? "Search appearances" : "Search releases";

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
              <DotLoader size="sm" label={null} />
              {isAppearsOn ? "Loading appearances" : "Loading releases"}
            </p>
          )}
        </div>
      </div>

      <div className="artist-release-page__controls artist-page-header">
        <div ref={toolbarRef} className="library-page__toolbar global-search">
          <div className="global-search__box">
            <div className="global-search__scope-wrap">
              <button
                type="button"
                onClick={() => setSortMenuOpen((open) => !open)}
                className={`global-search__scope-button library-page__sort-button${sortMenuOpen ? " is-open" : ""}`}
                aria-haspopup="listbox"
                aria-expanded={sortMenuOpen}
                aria-controls="artist-release-sort-menu"
                aria-label={`Sort ${noun}s`}
              >
                <span className="library-page__sort-label">{selectedSort.label}</span>
                <SortDirectionIcon className="artist-icon-xs library-page__sort-direction" />
                <ChevronDown
                  className={`artist-icon-sm${sortMenuOpen ? " artist-chevron--open" : ""}`}
                />
              </button>

              {sortMenuOpen && (
                <div
                  id="artist-release-sort-menu"
                  className="artist-options-menu library-page__sort-menu"
                  role="listbox"
                  aria-label={`${noun} sort options`}
                >
                  {sortOptions.map((option) => {
                    const active = sortKey === option.value;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => handleSortOptionClick(option)}
                        className={`artist-menu-item${active ? " is-active" : ""}`}
                        role="option"
                        aria-selected={active}
                      >
                        <span>{option.label}</span>
                        <span>
                          {active && <SortDirectionIcon className="artist-icon-xs" />}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="global-search__divider" />

            <div className="global-search__input-wrap">
              <Search className="global-search__icon" />
              <input
                type="text"
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
                placeholder=""
                className="global-search__input"
                autoComplete="off"
                aria-label={searchLabel}
              />
              {!searchTerm && (
                <div className="global-search__placeholder">{searchLabel}...</div>
              )}
            </div>
          </div>

          <div className="library-page__view-controls">
            <button
              type="button"
              onClick={() => handleViewModeChange(viewMode === "grid" ? "list" : "grid")}
              className="btn btn-icon-square library-page__view-toggle"
              aria-label={viewMode === "grid" ? "Switch to list view" : "Switch to grid view"}
              title={viewMode === "grid" ? "List view" : "Grid view"}
            >
              {viewMode === "grid" ? (
                <List className="artist-icon-sm" />
              ) : (
                <LayoutGrid className="artist-icon-sm" />
              )}
            </button>
          </div>
        </div>

        <div className="artist-release-page__filters">
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
          <div className="artist-release-page__live-toggle">
            <span>Live albums</span>
            <PillToggle
              checked={showLiveAlbums}
              onChange={(event) => setShowLiveAlbums(event.target.checked)}
              aria-label="Show live albums"
            />
          </div>
        </div>
      </div>

      <div className="artist-count">
        {filteredReleaseGroups.length.toLocaleString()} {noun}
        {filteredReleaseGroups.length === 1 ? "" : "s"}
      </div>

      <div className={viewMode === "grid" ? "artist-albums-grid" : "artist-release-list"}>
        {renderedReleaseGroups.map((releaseGroup) => renderReleaseCard(releaseGroup))}
      </div>
      {visibleReleaseCount < filteredReleaseGroups.length ||
      (isAppearsOn && hasMoreAppearances) ? (
        <div className="artist-loading" aria-live="polite">
          <button
            type="button"
            className="btn btn-surface"
            onClick={loadNextPage}
            disabled={loadingMoreAppearances}
          >
            {loadingMoreAppearances ? (
              <DotLoader size="sm" label={null} />
            ) : null}
            Load more
          </button>
        </div>
      ) : null}
    </div>
  );
}

export default ArtistReleaseListPage;

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { DotLoader } from "../../components/DotLoader";
import { SkeletonReleaseCard, SkeletonStatus, SkeletonText } from "../../components/Skeletons";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  CornerUpLeft,
  LayoutGrid,
  List,
  Music,
  Search,
  AlertCircle,
} from "../../components/icons";
import { ReleaseMetric } from "./components/ReleaseMetric";
import AddActionButton from "../../components/AddActionButton";
import ReleaseWaitBadge from "../../components/ReleaseWaitBadge";
import { useActiveDownloads } from "../../hooks/useActiveDownloads";
import PillToggle from "../../components/PillToggle";
import ReleaseStatusCheck from "./components/ReleaseStatusCheck";
import { ArtistReleaseCard, ReleaseMeta } from "./components/ArtistReleaseCard";
import { useAuth } from "../../contexts/AuthContext";
import { useToast } from "../../contexts/ToastContext";
import { useDocumentTitle } from "../../hooks/useDocumentTitle";
import { useArtistDetails } from "./hooks/useArtistDetails";
import { useArtistRouteState } from "./hooks/useArtistRouteState.ts";
import { useArtistDetailsLibrary } from "./hooks/useArtistDetailsLibrary";
import { ReleaseCoverImage } from "../../components/ReleaseCoverImage";
import { getReleaseGroupLink } from "../../utils/searchNavigation";
import { OptionalLink } from "../../components/RouteLink";
import {
  getCoverImage,
  getReleaseGroupCoverUrl,
  getReleaseMetric,
  readReleaseListViewMode,
  writeReleaseListViewMode,
} from "./utils";
import { matchesReleaseGroupSearch, matchesReleaseGroupTab } from "./releaseFilters.ts";
import type { LibraryReleaseGroup, ReleaseGroup, ReleaseListViewMode } from "./utils";
import { albumPath } from "../../../../lib/albumPath.ts";
import { getAlbumAddAction } from "../../utils/albumAddAction";
import { getReleaseGroupRatingsBatch } from "../../utils/api/endpoints/artists.ts";
import TooltipButton from "../../components/TooltipButton";
import Tooltip from "../../components/Tooltip";
import StatePanel from "../../components/StatePanel";
import Pagination from "../../components/Pagination";
import { useClampPage, usePageParam } from "../../hooks/usePageParam.ts";
import "./ArtistDetailsPage.css";

const RELEASE_PAGE_SIZE = 24;

type ReleaseGroupRatings = Awaited<ReturnType<typeof getReleaseGroupRatingsBatch>>["ratings"];

const sortOptions = [
  { value: "date", label: "Date", defaultDirection: "desc" },
  { value: "name", label: "Name", defaultDirection: "asc" },
  { value: "popularity", label: "Popularity", defaultDirection: "desc" },
] as const;

type SortKey = (typeof sortOptions)[number]["value"];
type SortDirection = "asc" | "desc";

const releaseTabs = [
  { value: "all", label: "All" },
  { value: "albums", label: "Albums" },
  { value: "singles", label: "EPs & singles" },
  { value: "compilations", label: "Compilations" },
  { value: "library", label: "In Library" },
];

const getReleaseTypeLabel = (releaseGroup: ReleaseGroup | null | undefined) => {
  const types = [
    releaseGroup?.["primary-type"],
    ...(Array.isArray(releaseGroup?.["secondary-types"]) ? releaseGroup["secondary-types"] : []),
  ].filter(Boolean);
  return types.length ? types.join(" · ") : "Release";
};

const sortReleaseGroups = <T extends ReleaseGroup>(
  items: T[],
  sortKey: SortKey,
  sortDirection: SortDirection,
): T[] =>
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
  const { state, artistName: artistNameFromNav = "", inLibrary } = useArtistRouteState();
  const { showSuccess, showError, showInfo } = useToast();
  const { isAlbumDownloading } = useActiveDownloads();
  const { hasPermission } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get("tab");
  const selectedTab = releaseTabs.find((tab) => tab.value === tabParam)?.value ?? "all";
  const showLiveAlbums = searchParams.get("live") !== "0";
  const searchTerm = searchParams.get("q") ?? "";
  const sortParam = searchParams.get("sort");
  const sortOption = sortOptions.find((option) => option.value === sortParam) ?? sortOptions[0];
  const sortKey: SortKey = sortOption.value;
  const directionParam = searchParams.get("dir");
  const sortDirection: SortDirection =
    directionParam === "asc" || directionParam === "desc"
      ? directionParam
      : sortOption.defaultDirection;
  const updateFilters = (changes: Record<string, string | null>) =>
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete("page");
        for (const [key, value] of Object.entries(changes)) {
          if (value) next.set(key, value);
          else next.delete(key);
        }
        return next;
      },
      { replace: true, state },
    );
  const [viewMode, setViewMode] = useState(() => readReleaseListViewMode());
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const [pageIndex, setPageIndex] = usePageParam();
  const [ratings, setRatings] = useState<ReleaseGroupRatings>({});
  const toolbarRef = useRef<HTMLDivElement>(null);
  const requestedRatingIdsRef = useRef(new Set<string>());
  const fetchingAppearancesRef = useRef(false);
  const canAddAlbum = hasPermission("addAlbum");

  const details = useArtistDetails(mbid, artistNameFromNav, { inLibrary });
  const {
    artist,
    error,
    loadingReleases,
    loadingAppearsOn,
    loadingLibrary,
    coverImages,
    appearsOn,
  } = details;
  const loadingList = isAppearsOn ? loadingAppearsOn : loadingReleases;
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
    ...details,
    showSuccess,
    showError,
    showInfo,
  });

  const releaseGroups = useMemo(
    () =>
      (artist?.[isAppearsOn ? "appears-on-release-groups" : "release-groups"] || []).map(
        (releaseGroup) => {
          const update = ratings[releaseGroup.id];
          if (!update) return releaseGroup;
          return {
            ...releaseGroup,
            rating: update.rating || releaseGroup.rating || null,
            "first-release-date":
              releaseGroup["first-release-date"] || update.firstReleaseDate || null,
          };
        },
      ),
    [artist, isAppearsOn, ratings],
  );
  const { libraryReleaseGroups } = library;
  const libraryTab = !isAppearsOn && selectedTab === "library";
  const filteredReleaseGroups = useMemo(
    () =>
      sortReleaseGroups<LibraryReleaseGroup>(
        (libraryTab ? libraryReleaseGroups : releaseGroups).filter(
          (releaseGroup) =>
            matchesReleaseGroupTab(
              releaseGroup,
              libraryTab ? "all" : selectedTab,
              showLiveAlbums,
            ) && matchesReleaseGroupSearch(releaseGroup, searchTerm),
        ),
        sortKey,
        sortDirection,
      ),
    [
      libraryReleaseGroups,
      libraryTab,
      releaseGroups,
      searchTerm,
      selectedTab,
      showLiveAlbums,
      sortDirection,
      sortKey,
    ],
  );
  const pageCount = Math.ceil(filteredReleaseGroups.length / RELEASE_PAGE_SIZE);
  const renderedReleaseGroups = useMemo(
    () =>
      filteredReleaseGroups.slice(
        (pageIndex - 1) * RELEASE_PAGE_SIZE,
        pageIndex * RELEASE_PAGE_SIZE,
      ),
    [filteredReleaseGroups, pageIndex],
  );
  const hasMoreAppearances = isAppearsOn && appearsOn.hasNextPage;
  const loadingMoreAppearances = appearsOn.isFetchingNextPage;
  const listSettled = !loadingList && !(libraryTab && loadingLibrary);
  const needsMoreAppearances =
    hasMoreAppearances &&
    !appearsOn.isFetchNextPageError &&
    filteredReleaseGroups.length < pageIndex * RELEASE_PAGE_SIZE;
  useClampPage(
    pageIndex,
    listSettled && !needsMoreAppearances && !loadingMoreAppearances
      ? Math.max(pageCount, 1)
      : undefined,
    setPageIndex,
  );

  useEffect(() => {
    requestedRatingIdsRef.current = new Set();
  }, [isAppearsOn, mbid]);

  useEffect(() => {
    if (isAppearsOn || loadingReleases) return;
    const ids = renderedReleaseGroups
      .filter((item) => !item.libraryAlbumId)
      .map((item) => item.id)
      .filter((id) => id && !requestedRatingIdsRef.current.has(id));
    if (!ids.length) return;
    ids.forEach((id) => requestedRatingIdsRef.current.add(id));
    let cancelled = false;
    getReleaseGroupRatingsBatch(ids)
      .then((data) => {
        if (!cancelled) setRatings((previous) => ({ ...previous, ...data?.ratings }));
      })
      .catch(() => {
        ids.forEach((id) => requestedRatingIdsRef.current.delete(id));
      });
    return () => {
      cancelled = true;
    };
  }, [isAppearsOn, loadingReleases, renderedReleaseGroups]);

  const { fetchNextPage } = appearsOn;
  const fetchMoreAppearances = useCallback(async () => {
    if (fetchingAppearancesRef.current) return false;
    fetchingAppearancesRef.current = true;
    try {
      await fetchNextPage({ throwOnError: true });
      return true;
    } catch {
      return false;
    } finally {
      fetchingAppearancesRef.current = false;
    }
  }, [fetchNextPage]);

  useEffect(() => {
    if (!listSettled || !needsMoreAppearances || loadingMoreAppearances) return;
    void fetchMoreAppearances();
  }, [
    fetchMoreAppearances,
    listSettled,
    loadingMoreAppearances,
    needsMoreAppearances,
    releaseGroups.length,
  ]);

  useEffect(() => {
    if (!sortMenuOpen) return undefined;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      if (toolbarRef.current?.contains(target)) return;
      setSortMenuOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSortMenuOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [sortMenuOpen]);

  const changePage = async (next: number) => {
    if (hasMoreAppearances && filteredReleaseGroups.length < next * RELEASE_PAGE_SIZE) {
      const loaded = await fetchMoreAppearances();
      if (!loaded || filteredReleaseGroups.length < pageIndex * RELEASE_PAGE_SIZE) return;
    }
    setPageIndex(next);
  };

  const handleViewModeChange = (next: ReleaseListViewMode) => {
    setViewMode(next);
    writeReleaseListViewMode(next);
  };

  const handleSortOptionClick = (option: (typeof sortOptions)[number]) => {
    updateFilters({
      sort: option.value,
      dir:
        sortKey === option.value
          ? sortDirection === "asc"
            ? "desc"
            : "asc"
          : option.defaultDirection,
    });
    setSortMenuOpen(false);
  };

  const releaseLink = (releaseGroup: LibraryReleaseGroup, coverUrl: string) =>
    releaseGroup.libraryAlbumId
      ? { to: albumPath(releaseGroup.libraryAlbumId) }
      : getReleaseGroupLink(releaseGroup, {
          artistMbid: mbid,
          artistName: artistDisplayName,
          coverUrl,
        });

  if (error || !artist) {
    return (
      <StatePanel
        role="alert"
        icon={<AlertCircle />}
        title={error ? "Couldn't load this artist" : "Artist not found"}
        message={error}
      />
    );
  }

  const renderReleaseCard = (releaseGroup: LibraryReleaseGroup) => {
    const status = library.getAlbumStatus(releaseGroup.id);
    const metric = getReleaseMetric(releaseGroup);
    const cover = getReleaseGroupCoverUrl(releaseGroup);
    const isComplete = status?.status === "available" || status?.status === "added";
    const albumBusy =
      library.requestingAlbum === releaseGroup.id || isAlbumDownloading(releaseGroup.id);
    const releaseTypeLabel = getReleaseTypeLabel(releaseGroup);
    const artistCredit = isAppearsOn ? releaseGroup["artist-credit"]?.[0]?.name || "" : "";
    const detail = artistCredit || releaseTypeLabel;

    if (viewMode === "list") {
      return (
        <div key={releaseGroup.id} className="artist-release-list-item">
          <div className="artist-media-cell artist-list-cover">
            <ReleaseCoverImage
              src={cover}
              fallback={artistCoverImage}
              alt=""
              loading="lazy"
              placeholder={
                <div className="artist-media-placeholder">
                  <Music className="artist-icon-md" />
                </div>
              }
            />
          </div>
          <OptionalLink
            link={releaseLink(releaseGroup, cover || artistCoverImage || "")}
            className="artist-min-0 card-link"
          >
            <h2 className="artist-release-card__title artist-truncate">{releaseGroup.title}</h2>
            <p className="artist-release-card__meta artist-truncate">
              <ReleaseMeta releaseGroup={releaseGroup} detail={detail} />
            </p>
          </OptionalLink>
          <div className="artist-row-actions">
            {metric.label && (
              <Tooltip content={metric.title}>
                <span className="artist-release-card__metric artist-hidden-mobile">
                  <ReleaseMetric metric={metric} />
                </span>
              </Tooltip>
            )}
            {isComplete ? (
              <ReleaseStatusCheck partial={status?.partial} />
            ) : status?.status === "waiting" ? (
              <ReleaseWaitBadge releaseDate={releaseGroup["first-release-date"]} />
            ) : canAddAlbum ? (
              <div>
                <AddActionButton
                  {...getAlbumAddAction({ releaseDate: releaseGroup["first-release-date"] })}
                  onAdd={() =>
                    library.handleRequestAlbum(releaseGroup.id, releaseGroup.title ?? "")
                  }
                  isLoading={albumBusy}
                  loadingLabel="Downloading"
                  disabled={albumBusy}
                />
              </div>
            ) : null}
          </div>
        </div>
      );
    }

    return (
      <ArtistReleaseCard
        key={releaseGroup.id}
        releaseGroup={releaseGroup}
        coverUrl={cover}
        fallbackCoverUrl={artistCoverImage}
        link={releaseLink(releaseGroup, cover || artistCoverImage || "")}
        detail={detail}
        status={status}
        busy={albumBusy}
        onDownload={
          canAddAlbum
            ? () => library.handleRequestAlbum(releaseGroup.id, releaseGroup.title ?? "")
            : null
        }
        metric={metric}
        headingLevel="h2"
      />
    );
  };

  const noun = isAppearsOn ? "appearance" : "release";
  const awaitingReleases = loadingList && renderedReleaseGroups.length === 0;
  const selectedSort = sortOptions.find((option) => option.value === sortKey) || sortOptions[0];
  const SortDirectionIcon = sortDirection === "asc" ? ArrowUp : ArrowDown;
  const searchLabel = isAppearsOn ? "Search appearances" : "Search releases";

  return (
    <div className="artist-details-page">
      <div className="artist-page-header">
        <div>
          <Link
            to={`/artist/${artist.id}`}
            state={{ artistName: artist.name, inLibrary: details.existsInLibrary }}
            className="artist-title-link"
          >
            <span>{artist.name}</span>
            <CornerUpLeft className="artist-icon-lg" />
          </Link>
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
                        <span>{active && <SortDirectionIcon className="artist-icon-xs" />}</span>
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
                onChange={(event) => updateFilters({ q: event.target.value || null })}
                placeholder=""
                className="global-search__input"
                autoComplete="off"
                aria-label={searchLabel}
              />
              {!searchTerm && <div className="global-search__placeholder">{searchLabel}...</div>}
            </div>
          </div>

          <div className="library-page__view-controls">
            <TooltipButton
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
            </TooltipButton>
          </div>
        </div>

        <div className="artist-release-page__filters">
          <div className="artist-tabs">
            {releaseTabs.map((tab) => {
              const active = selectedTab === tab.value;
              if (
                tab.value === "library" &&
                (isAppearsOn || (!active && libraryReleaseGroups.length === 0))
              ) {
                return null;
              }
              return (
                <button
                  key={tab.value}
                  type="button"
                  onClick={() => updateFilters({ tab: tab.value === "all" ? null : tab.value })}
                  className={`artist-tab${active ? " is-active" : ""}`}
                >
                  {tab.label}
                  {tab.value === "library" && (
                    <span className="artist-tab__count">{libraryReleaseGroups.length}</span>
                  )}
                </button>
              );
            })}
          </div>
          <div className="artist-release-page__live-toggle">
            <span>Live albums</span>
            <PillToggle
              checked={showLiveAlbums}
              onChange={(event) => updateFilters({ live: event.target.checked ? null : "0" })}
              aria-label="Show live albums"
            />
          </div>
        </div>
      </div>

      <div className="artist-count">
        {awaitingReleases ? (
          <SkeletonText width="5em" />
        ) : (
          <>
            {filteredReleaseGroups.length.toLocaleString()} {noun}
            {filteredReleaseGroups.length === 1 ? "" : "s"}
            {loadingList ? (
              <span className="artist-count__loading" role="status">
                <DotLoader size="xs" label={null} />
                {isAppearsOn ? "Loading appearances" : "Loading releases"}
              </span>
            ) : null}
          </>
        )}
      </div>

      {awaitingReleases && viewMode === "grid" ? (
        <SkeletonStatus label={isAppearsOn ? "Loading appearances" : "Loading releases"}>
          <div className="artist-albums-grid">
            {Array.from({ length: 14 }, (_, index) => (
              <SkeletonReleaseCard key={index} index={index} />
            ))}
          </div>
        </SkeletonStatus>
      ) : (
        <div className={viewMode === "grid" ? "artist-albums-grid" : "artist-release-list"}>
          {renderedReleaseGroups.map((releaseGroup) => renderReleaseCard(releaseGroup))}
        </div>
      )}
      {needsMoreAppearances || loadingMoreAppearances ? (
        <div className="artist-loading">
          <DotLoader size="sm" label="Loading appearances" />
        </div>
      ) : (
        <Pagination
          page={pageIndex}
          pageCount={pageCount}
          hasMore={hasMoreAppearances}
          label={`${isAppearsOn ? "Appearance" : "Release"} pages`}
          onChange={(next) => void changePage(next)}
        />
      )}
    </div>
  );
}

export default ArtistReleaseListPage;

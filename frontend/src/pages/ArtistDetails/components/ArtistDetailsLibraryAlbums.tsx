import ArtworkImage from "../../../components/ArtworkImage";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Music,
  ChevronLeft,
  ChevronRight,
  MoreVertical,
  ExternalLink,
  Trash2,
  RefreshCw,
} from "../../../components/icons";
import { DotLoader } from "../../../components/DotLoader";
import { getLibraryAlbumLink } from "../../../utils/searchNavigation";
import { getReleaseMetric, isVisibleLibraryAlbum, type ReleaseGroup } from "../utils";
import { canSearchLibraryAlbum } from "../../../utils/libraryDestination";
import TooltipButton from "../../../components/TooltipButton";
import Tooltip from "../../../components/Tooltip";
import { OptionalLink } from "../../../components/RouteLink";
import type { ArtistDetails } from "../hooks/useArtistDetailsStream.ts";
import type {
  DownloadStatuses,
  LibraryAlbum,
  LibraryAlbumId,
} from "../hooks/useArtistDetailsLibrary.ts";

type ArtistDetailsLibraryAlbumsProps = {
  artist: ArtistDetails;
  libraryAlbums: LibraryAlbum[];
  downloadStatuses: DownloadStatuses;
  requestingAlbum: string | null;
  reSearchingAlbum: LibraryAlbumId | null;
  reSearchingMissingAlbums: boolean;
  albumCovers: Record<string, string>;
  fulfilledCoverIds: Set<string>;
  artistCoverImage: string | null | undefined;
  albumDropdownOpen: string | null | undefined;
  setAlbumDropdownOpen: (rgId: string | null | undefined) => void;
  canDeleteAlbum: boolean;
  handleDeleteAlbumClick: (
    albumId: string | null | undefined,
    title: string | null | undefined,
  ) => void;
  canReSearchAlbum: boolean;
  lidarrConnected?: boolean;
  handleReSearchAlbum: (
    libraryAlbumId: LibraryAlbumId,
    title: string | null | undefined,
  ) => Promise<void>;
  handleReSearchMissingDownloads: () => Promise<void>;
  onVisibleCoverIdsChange?: (ids: string[]) => void;
  artistName?: string;
};

export function ArtistDetailsLibraryAlbums({
  artist,
  libraryAlbums,
  downloadStatuses,
  requestingAlbum,
  reSearchingAlbum,
  reSearchingMissingAlbums,
  albumCovers,
  fulfilledCoverIds,
  artistCoverImage,
  albumDropdownOpen,
  setAlbumDropdownOpen,
  canDeleteAlbum,
  handleDeleteAlbumClick,
  canReSearchAlbum,
  lidarrConnected = false,
  handleReSearchAlbum,
  handleReSearchMissingDownloads,
  onVisibleCoverIdsChange,
  artistName = "",
}: ArtistDetailsLibraryAlbumsProps) {
  const railRef = useRef<HTMLDivElement>(null);
  const visibleCoverIdsRef = useRef(new Set<string>());
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const [completionFilter, setCompletionFilter] = useState<"all" | "incomplete" | "complete">(
    "all",
  );
  const [dropdownPosition, setDropdownPosition] = useState<{ top: number; left: number } | null>(
    null,
  );
  const downloadedAlbums = libraryAlbums.filter((album) =>
    isVisibleLibraryAlbum(album, { requestingAlbum }),
  );

  const releaseGroups: ReleaseGroup[] = artist?.["release-groups"] || [];
  const popularityById = new Map<string | null | undefined, number>(
    releaseGroups.map((rg) => [rg.id, getReleaseMetric(rg).sortValue]),
  );
  const getAlbumPopularity = (album: LibraryAlbum) => {
    const rgId = album.mbid || album.foreignAlbumId;
    return popularityById.get(rgId) || 0;
  };
  const sortedAlbums = [...downloadedAlbums].sort((a, b) => {
    const diff = getAlbumPopularity(b) - getAlbumPopularity(a);
    if (diff !== 0) return diff;
    const dateA = a.releaseDate || "";
    const dateB = b.releaseDate || "";
    return dateB.localeCompare(dateA);
  });
  const getAlbumState = (libraryAlbum: LibraryAlbum) => {
    const downloadStatus = downloadStatuses[libraryAlbum.id];
    const isComplete =
      (libraryAlbum.statistics?.percentOfTracks ?? 0) >= 100 ||
      (libraryAlbum.statistics?.sizeOnDisk ?? 0) > 0;
    const isActiveSearch =
      downloadStatus &&
      ["adding", "searching", "downloading", "moving", "processing"].includes(
        downloadStatus.status,
      );
    const canReSearch =
      canSearchLibraryAlbum(libraryAlbum, { lidarrConnected }) &&
      !isComplete &&
      !String(libraryAlbum.id ?? "").startsWith("pending-") &&
      !isActiveSearch &&
      (downloadStatus?.status === "failed" || libraryAlbum.monitored);
    return { downloadStatus, isComplete, canReSearch };
  };
  const visibleAlbums = sortedAlbums.filter((album) => {
    const { isComplete } = getAlbumState(album);
    if (completionFilter === "complete") return isComplete;
    if (completionFilter === "incomplete") return !isComplete;
    return true;
  });
  const visibleCoverSourceKey = visibleAlbums
    .map((album) => album.mbid || album.foreignAlbumId || album.id)
    .filter(Boolean)
    .join(",");
  const incompleteAlbumCount = sortedAlbums.filter(
    (album) => !getAlbumState(album).isComplete,
  ).length;
  const filterOptions = [
    {
      value: "all",
      label: "Show all library albums",
      title: "Show all library albums",
      renderIcon: () => (
        <span className="artist-status-icon-pair">
          <span className="artist-status-dot artist-status-dot--complete" />
          <span className="artist-status-dot artist-status-dot--incomplete" />
        </span>
      ),
    },
    {
      value: "incomplete",
      label: "Show incomplete downloads",
      title: "Show incomplete downloads",
      renderIcon: () => (
        <span className="artist-status-icon-pair">
          <span className="artist-status-dot" />
          <span className="artist-status-dot artist-status-dot--incomplete" />
        </span>
      ),
    },
    {
      value: "complete",
      label: "Show completed downloads",
      title: "Show completed downloads",
      renderIcon: () => (
        <span className="artist-status-icon-pair">
          <span className="artist-status-dot artist-status-dot--complete" />
          <span className="artist-status-dot" />
        </span>
      ),
    },
  ] as const;

  const updateScrollState = useCallback(() => {
    const node = railRef.current;
    if (!node) return;
    const maxScrollLeft = Math.max(node.scrollWidth - node.clientWidth, 0);
    setCanScrollLeft(node.scrollLeft > 2);
    setCanScrollRight(node.scrollLeft < maxScrollLeft - 2);
  }, []);

  const scrollByAmount = useCallback((direction: number) => {
    const node = railRef.current;
    if (!node) return;
    const width = node.clientWidth;
    node.scrollBy({
      left: direction * Math.max(width * 0.85, 280),
      behavior: "smooth",
    });
  }, []);

  const libraryAlbumLink = (libraryAlbum: LibraryAlbum, coverUrl: string) => {
    const hasFiles =
      (libraryAlbum.statistics?.sizeOnDisk ?? 0) > 0 ||
      (libraryAlbum.statistics?.trackFileCount ?? 0) > 0;
    if (libraryAlbum.canonicalId && hasFiles) {
      return { to: `/library/album/${encodeURIComponent(libraryAlbum.canonicalId)}` };
    }
    return getLibraryAlbumLink(libraryAlbum, {
      artistMbid: artist?.id,
      artistName: artistName || artist?.name || "",
      coverUrl,
    });
  };

  useEffect(() => {
    const node = railRef.current;
    if (!node) return;
    updateScrollState();
    node.addEventListener("scroll", updateScrollState, { passive: true });
    window.addEventListener("resize", updateScrollState);
    return () => {
      node.removeEventListener("scroll", updateScrollState);
      window.removeEventListener("resize", updateScrollState);
    };
  }, [visibleAlbums, updateScrollState]);

  useEffect(() => {
    if (!onVisibleCoverIdsChange || !visibleCoverSourceKey) return undefined;

    visibleCoverIdsRef.current = new Set();
    const node = railRef.current;
    if (!node) return undefined;

    const observer = new IntersectionObserver(
      (entries) => {
        let changed = false;
        for (const entry of entries) {
          const id = entry.target.getAttribute("data-cover-id");
          if (!id) continue;
          if (entry.isIntersecting) {
            if (!visibleCoverIdsRef.current.has(id)) {
              visibleCoverIdsRef.current.add(id);
              changed = true;
            }
          } else if (visibleCoverIdsRef.current.delete(id)) {
            changed = true;
          }
        }
        if (changed) {
          onVisibleCoverIdsChange(Array.from(visibleCoverIdsRef.current));
        }
      },
      {
        root: node,
        threshold: 0.6,
      },
    );

    node.querySelectorAll("[data-cover-id]").forEach((target) => {
      observer.observe(target);
    });

    return () => {
      observer.disconnect();
      visibleCoverIdsRef.current = new Set();
    };
  }, [onVisibleCoverIdsChange, visibleCoverSourceKey]);

  useEffect(() => {
    if (!onVisibleCoverIdsChange) return undefined;
    if (visibleCoverSourceKey) return undefined;
    onVisibleCoverIdsChange([]);
  }, [onVisibleCoverIdsChange, visibleCoverSourceKey]);

  if (downloadedAlbums.length === 0) return null;

  return (
    <section className="artist-section">
      <div className="artist-heading-row">
        <h2 className="artist-section-title">Your Library</h2>
        <div className="artist-row-actions">
          <div
            className="artist-segmented"
            role="group"
            aria-label="Library download completion filter"
          >
            {filterOptions.map((option) => {
              const isActive = completionFilter === option.value;
              return (
                <Tooltip key={option.value} content={option.title}>
                  <button
                    type="button"
                    onClick={() => setCompletionFilter(option.value)}
                    className={`btn btn-xs${isActive ? " btn-neutral-active" : " btn-ghost"}`}
                    aria-pressed={isActive}
                    aria-label={option.label}
                  >
                    {option.renderIcon()}
                  </button>
                </Tooltip>
              );
            })}
          </div>
          {canReSearchAlbum && (
            <TooltipButton
              type="button"
              onClick={handleReSearchMissingDownloads}
              className="btn btn-surface btn-icon-square"
              aria-label="Re-search all missing downloads"
              title={
                incompleteAlbumCount > 0
                  ? `Re-search ${incompleteAlbumCount} missing download${
                      incompleteAlbumCount === 1 ? "" : "s"
                    }`
                  : "No missing downloads to re-search"
              }
              disabled={reSearchingMissingAlbums || incompleteAlbumCount === 0}
            >
              {reSearchingMissingAlbums ? (
                <DotLoader size="sm" label={null} />
              ) : (
                <RefreshCw className="artist-icon-sm" />
              )}
            </TooltipButton>
          )}
          <TooltipButton
            type="button"
            onClick={() => scrollByAmount(-1)}
            className="btn btn-ghost btn-icon-square"
            aria-label="Scroll library albums left"
            title="Scroll library albums left"
            disabled={!canScrollLeft}
          >
            <ChevronLeft className="artist-icon-lg" />
          </TooltipButton>
          <TooltipButton
            type="button"
            onClick={() => scrollByAmount(1)}
            className="btn btn-ghost btn-icon-square"
            aria-label="Scroll library albums right"
            title="Scroll library albums right"
            disabled={!canScrollRight}
          >
            <ChevronRight className="artist-icon-lg" />
          </TooltipButton>
        </div>
      </div>

      <div ref={railRef} className="artist-library-rail">
        {visibleAlbums.map((libraryAlbum) => {
          const rgId = libraryAlbum.mbid || libraryAlbum.foreignAlbumId;
          const { downloadStatus, isComplete, canReSearch } = getAlbumState(libraryAlbum);
          const coverUrl =
            (rgId && albumCovers[rgId]) ||
            albumCovers[libraryAlbum.id] ||
            (rgId && fulfilledCoverIds?.has(rgId) ? artistCoverImage : "") ||
            "";
          const hasDownloadedStatus =
            isComplete ||
            downloadStatus?.status === "added" ||
            downloadStatus?.status === "available";
          const showIncompleteStatus =
            !hasDownloadedStatus &&
            (canReSearch ||
              downloadStatus?.status === "failed" ||
              libraryAlbum.statistics?.percentOfTracks > 0);
          const releaseYear = String(libraryAlbum.releaseDate || "").slice(0, 4);
          const metaItems = [
            /^\d{4}$/.test(releaseYear) ? releaseYear : null,
            libraryAlbum.albumType || null,
            showIncompleteStatus ? "Incomplete" : null,
          ].filter(Boolean);

          return (
            <article
              key={libraryAlbum.id}
              className="artist-library-card"
              data-cover-id={rgId}
              data-artwork-scope
            >
              <div className="artist-release-card__cover" data-artwork>
                {coverUrl ? (
                  <ArtworkImage
                    src={coverUrl}
                    alt={libraryAlbum.albumName ?? undefined}
                    loading="lazy"
                    decoding="async"
                  />
                ) : (
                  <div className="artist-release-card__placeholder">
                    <Music className="artist-icon-lg" />
                  </div>
                )}

                <div className="artist-library-card__status">
                  {requestingAlbum === rgId || reSearchingAlbum === libraryAlbum.id ? (
                    <DotLoader size="xs" label={null} />
                  ) : hasDownloadedStatus ? (
                    <Tooltip content="Downloaded">
                      <span
                        role="img"
                        aria-label="Downloaded"
                        className="artist-status-dot artist-status-dot--complete"
                      />
                    </Tooltip>
                  ) : showIncompleteStatus ? (
                    <Tooltip content="Incomplete">
                      <span className="artist-status-dot artist-status-dot--incomplete" />
                    </Tooltip>
                  ) : null}
                </div>

                <div className="artist-library-card__menu">
                  <div className="artist-relative">
                    <TooltipButton
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (albumDropdownOpen === rgId) {
                          setAlbumDropdownOpen(null);
                          setDropdownPosition(null);
                          return;
                        }
                        const rect = e.currentTarget.getBoundingClientRect();
                        const menuWidth = 192;
                        const viewportPadding = 12;
                        setDropdownPosition({
                          top: rect.bottom + 8,
                          left: Math.min(
                            Math.max(viewportPadding, rect.right - menuWidth),
                            window.innerWidth - menuWidth - viewportPadding,
                          ),
                        });
                        setAlbumDropdownOpen(rgId);
                      }}
                      className="btn btn-surface btn-icon-square"
                      title="Options"
                      aria-label={`Album options for ${libraryAlbum.albumName}`}
                    >
                      <MoreVertical className="artist-icon-sm" />
                    </TooltipButton>
                    {albumDropdownOpen === rgId && (
                      <>
                        <div
                          className="artist-backdrop-button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setAlbumDropdownOpen(null);
                            setDropdownPosition(null);
                          }}
                        />
                        <div
                          className="artist-floating-menu"
                          style={{
                            top: dropdownPosition?.top ?? 0,
                            left: dropdownPosition?.left ?? 0,
                          }}
                        >
                          <a
                            href={`https://www.last.fm/music/${encodeURIComponent(
                              String(artist.name),
                            )}/${encodeURIComponent(String(libraryAlbum.albumName))}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="artist-menu-item"
                            onClick={() => {
                              setAlbumDropdownOpen(null);
                              setDropdownPosition(null);
                            }}
                          >
                            <span className="artist-menu-item__main">
                              <ExternalLink className="artist-icon-sm" />
                              View on Last.fm
                            </span>
                          </a>
                          {canReSearch && canReSearchAlbum && (
                            <>
                              <div
                                className="native-library-item-menu__separator"
                                role="separator"
                              />
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleReSearchAlbum(libraryAlbum.id, libraryAlbum.albumName);
                                  setAlbumDropdownOpen(null);
                                  setDropdownPosition(null);
                                }}
                                className="artist-menu-item"
                                disabled={reSearchingAlbum === libraryAlbum.id}
                              >
                                <span className="artist-menu-item__main">
                                  {reSearchingAlbum === libraryAlbum.id ? (
                                    <DotLoader size="sm" label={null} />
                                  ) : (
                                    <RefreshCw className="artist-icon-sm" />
                                  )}
                                  {reSearchingAlbum === libraryAlbum.id
                                    ? "Searching..."
                                    : "Re-search"}
                                </span>
                              </button>
                            </>
                          )}
                          {canDeleteAlbum && (
                            <>
                              <div
                                className="native-library-item-menu__separator"
                                role="separator"
                              />
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleDeleteAlbumClick(rgId, libraryAlbum.albumName);
                                  setDropdownPosition(null);
                                }}
                                className="artist-menu-item artist-menu-item--danger"
                              >
                                <span className="artist-menu-item__main">
                                  <Trash2 className="artist-icon-sm" />
                                  {libraryAlbum.managedBy === "aurral"
                                    ? "Remove album"
                                    : "Delete album"}
                                </span>
                              </button>
                            </>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                </div>
              </div>

              <OptionalLink
                link={libraryAlbumLink(libraryAlbum, coverUrl)}
                className="artist-card-button card-link"
              >
                <span className="artist-card-title-row">
                  <span className="artist-release-card__title artist-clamp-2">
                    {libraryAlbum.albumName}
                  </span>
                </span>
                {metaItems.length > 0 && (
                  <span className="artist-card-meta artist-truncate">{metaItems.join(" · ")}</span>
                )}
              </OptionalLink>
            </article>
          );
        })}
      </div>

      {visibleAlbums.length === 0 && (
        <div className="artist-empty-message">
          {completionFilter === "incomplete"
            ? "No incomplete downloads in your library."
            : completionFilter === "complete"
              ? "No completed downloads in your library."
              : "No library albums match this filter."}
        </div>
      )}
    </section>
  );
}

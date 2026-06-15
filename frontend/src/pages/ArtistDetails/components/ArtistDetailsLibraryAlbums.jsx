import { useCallback, useEffect, useRef, useState } from "react";
import PropTypes from "prop-types";
import { useNavigate } from "react-router-dom";
import {
  Loader,
  Music,
  ChevronLeft,
  ChevronRight,
  MoreVertical,
  ExternalLink,
  Trash2,
  RefreshCw,
} from "lucide-react";
import { navigateToLibraryAlbum } from "../../../utils/searchNavigation";
import { getPopularityScale, isVisibleLibraryAlbum } from "../utils";

export function ArtistDetailsLibraryAlbums({
  artist,
  libraryAlbums,
  downloadStatuses,
  requestingAlbum,
  reSearchingAlbum,
  reSearchingMissingAlbums,
  albumCovers,
  artistCoverImage,
  albumDropdownOpen,
  setAlbumDropdownOpen,
  canDeleteAlbum,
  handleDeleteAlbumClick,
  canReSearchAlbum,
  handleReSearchAlbum,
  handleReSearchMissingDownloads,
  onVisibleCoverIdsChange,
  artistName = "",
}) {
  const navigate = useNavigate();
  const railRef = useRef(null);
  const visibleCoverIdsRef = useRef(new Set());
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const [completionFilter, setCompletionFilter] = useState("all");
  const [dropdownPosition, setDropdownPosition] = useState(null);
  const downloadedAlbums = libraryAlbums.filter((album) =>
    isVisibleLibraryAlbum(album, { requestingAlbum }),
  );

  const releaseGroups = artist?.["release-groups"] || [];
  getPopularityScale(releaseGroups);
  const popularityById = new Map(
    releaseGroups.map((rg) => [rg.id, typeof rg?.fans === "number" ? rg.fans : 0]),
  );
  const getAlbumFans = (album) => {
    const rgId = album.mbid || album.foreignAlbumId;
    return popularityById.get(rgId) || 0;
  };
  const sortedAlbums = [...downloadedAlbums].sort((a, b) => {
    const diff = getAlbumFans(b) - getAlbumFans(a);
    if (diff !== 0) return diff;
    const dateA = a.releaseDate || "";
    const dateB = b.releaseDate || "";
    return dateB.localeCompare(dateA);
  });
  const getAlbumState = (libraryAlbum) => {
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
  const filterTitle =
    completionFilter === "all"
      ? "Showing all library albums"
      : completionFilter === "incomplete"
        ? "Showing incomplete downloads"
        : "Showing completed downloads";

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
          <span className="artist-status-dot artist-status-dot--incomplete" />
          <span className="artist-status-dot" />
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
  ];

  const updateScrollState = useCallback(() => {
    const node = railRef.current;
    if (!node) return;
    const maxScrollLeft = Math.max(node.scrollWidth - node.clientWidth, 0);
    setCanScrollLeft(node.scrollLeft > 2);
    setCanScrollRight(node.scrollLeft < maxScrollLeft - 2);
  }, []);

  const scrollByAmount = useCallback((direction) => {
    const node = railRef.current;
    if (!node) return;
    const width = node.clientWidth;
    node.scrollBy({
      left: direction * Math.max(width * 0.85, 280),
      behavior: "smooth",
    });
  }, []);

  const openLibraryAlbum = (libraryAlbum) => {
    const rgId = libraryAlbum.mbid || libraryAlbum.foreignAlbumId;
    navigateToLibraryAlbum(navigate, libraryAlbum, {
      artistMbid: artist?.id,
      artistName: artistName || artist?.name || "",
      coverUrl: albumCovers[rgId] || albumCovers[libraryAlbum.id] || artistCoverImage || "",
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
        <h2 className="artist-section-title">
          Your Library
        </h2>
        <div className="artist-row-actions">
          <div
            className="artist-segmented"
            role="group"
            aria-label="Library download completion filter"
            title={filterTitle}
          >
            {filterOptions.map((option) => {
              const isActive = completionFilter === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setCompletionFilter(option.value)}
                  className={`btn btn-xs${isActive ? " btn-neutral-active" : " btn-ghost"}`}
                  aria-pressed={isActive}
                  aria-label={option.label}
                  title={option.title}
                >
                  {option.renderIcon()}
                </button>
              );
            })}
          </div>
          {canReSearchAlbum && (
            <button
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
                <Loader className="artist-icon-sm animate-spin" />
              ) : (
                <RefreshCw className="artist-icon-sm" />
              )}
            </button>
          )}
          <button
            type="button"
            onClick={() => scrollByAmount(-1)}
            className="btn btn-ghost btn-icon-square"
            aria-label="Scroll library albums left"
            disabled={!canScrollLeft}
          >
            <ChevronLeft className="artist-icon-lg" />
          </button>
          <button
            type="button"
            onClick={() => scrollByAmount(1)}
            className="btn btn-ghost btn-icon-square"
            aria-label="Scroll library albums right"
            disabled={!canScrollRight}
          >
            <ChevronRight className="artist-icon-lg" />
          </button>
        </div>
      </div>

      <div ref={railRef} className="artist-library-rail">
        {visibleAlbums.map((libraryAlbum) => {
          const rgId = libraryAlbum.mbid || libraryAlbum.foreignAlbumId;
          const { downloadStatus, isComplete, canReSearch } =
            getAlbumState(libraryAlbum);
          const coverUrl = albumCovers[rgId] || artistCoverImage;
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
              onClick={() => openLibraryAlbum(libraryAlbum)}
            >
              <div className="artist-release-card__cover">
                {coverUrl ? (
                  <img
                    src={coverUrl}
                    alt={libraryAlbum.albumName}
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
                    <Loader className="artist-icon-xs animate-spin" />
                  ) : hasDownloadedStatus ? (
                    <span
                      className="artist-status-dot artist-status-dot--complete"
                      title="Downloaded"
                    />
                  ) : showIncompleteStatus ? (
                    <span
                      className="artist-status-dot artist-status-dot--incomplete"
                      title="Incomplete"
                    />
                  ) : null}
                </div>

                <div className="artist-library-card__menu">
                  <div className="artist-relative">
                    <button
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
                    </button>
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
                              artist.name,
                            )}/${encodeURIComponent(libraryAlbum.albumName)}`}
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
                              <div className="artist-menu-section" />
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
                                    <Loader className="artist-icon-sm animate-spin" />
                                  ) : (
                                    <RefreshCw className="artist-icon-sm" />
                                  )}
                                  {reSearchingAlbum === libraryAlbum.id ? "Searching..." : "Re-search"}
                                </span>
                              </button>
                            </>
                          )}
                          {canDeleteAlbum && (
                            <>
                              <div className="artist-menu-section" />
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
                                  Delete Album
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

              <div className="artist-card-button">
                <span className="artist-card-title-row">
                  <span className="artist-release-card__title artist-clamp-2">
                    {libraryAlbum.albumName}
                  </span>
                </span>
                {metaItems.length > 0 && (
                  <span className="artist-card-meta artist-truncate">
                    {metaItems.join(" · ")}
                  </span>
                )}
              </div>
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

ArtistDetailsLibraryAlbums.propTypes = {
  artist: PropTypes.object,
  libraryAlbums: PropTypes.arrayOf(PropTypes.object),
  downloadStatuses: PropTypes.object,
  requestingAlbum: PropTypes.string,
  reSearchingAlbum: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
  reSearchingMissingAlbums: PropTypes.bool,
  albumCovers: PropTypes.object,
  artistCoverImage: PropTypes.string,
  albumDropdownOpen: PropTypes.string,
  setAlbumDropdownOpen: PropTypes.func,
  canDeleteAlbum: PropTypes.bool,
  handleDeleteAlbumClick: PropTypes.func,
  canReSearchAlbum: PropTypes.bool,
  handleReSearchAlbum: PropTypes.func,
  handleReSearchMissingDownloads: PropTypes.func,
  onVisibleCoverIdsChange: PropTypes.func,
  artistName: PropTypes.string,
};

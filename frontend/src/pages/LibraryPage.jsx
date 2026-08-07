import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { getLibraryArtists } from "../utils/api/endpoints/library.js";
import ArtistImage from "../components/ArtistImage";

import { useNavigate } from "react-router-dom";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { ArrowDown, ArrowUp, ChevronDown, LayoutGrid, List, Loader, Music, AlertCircle, Search } from "lucide-react";
const PAGE_SIZE = 48;
const ALPHABET = ["#", ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"];
const SORT_OPTIONS = [
  { value: "name", label: "Name" },
  { value: "added", label: "Date Added" },
  { value: "albums", label: "Album Count" },
];

const getArtistName = (artist) =>
  String(artist?.artistName || artist?.sortName || artist?.name || "").trim();

const getArtistRouteId = (artist) =>
  String(artist?.mbid || "").trim();

const letterKeyFor = (artist) => {
  const letter = (getArtistName(artist)[0] || "#").toUpperCase();
  return /^[A-Z]$/.test(letter) ? letter : "#";
};

const getAddedTime = (artist) => {
  const time = Date.parse(artist?.added || artist?.addedAt || "");
  return Number.isFinite(time) ? time : null;
};

const compareNullableNumbers = (left, right, sortDirection) => {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  const diff = left - right;
  return sortDirection === "asc" ? diff : -diff;
};

const sortArtists = (items, sortKey, sortDirection) =>
  [...items].sort((a, b) => {
    let diff = 0;
    if (sortKey === "name") {
      diff = getArtistName(a).localeCompare(getArtistName(b));
    } else if (sortKey === "added") {
      diff = compareNullableNumbers(getAddedTime(a), getAddedTime(b), sortDirection);
      if (diff !== 0) return diff;
    } else if (sortKey === "albums") {
      diff = (a.statistics?.albumCount || 0) - (b.statistics?.albumCount || 0);
    }
    if (diff !== 0) return sortDirection === "asc" ? diff : -diff;
    return getArtistName(a).localeCompare(getArtistName(b));
  });

function LibraryPage() {
  const [artists, setArtists] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [sortKey, setSortKey] = useState("name");
  const [sortDirection, setSortDirection] = useState("asc");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [retryKey, setRetryKey] = useState(0);
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const [gridColumns, setGridColumns] = useState(() => {
    const saved = localStorage.getItem("libraryGridColumns");
    const val = parseInt(saved, 10);
    return val >= 2 && val <= 10 ? val : 6;
  });
  const [viewMode, setViewMode] = useState(() =>
    localStorage.getItem("libraryViewMode") || "grid"
  );
  const [activeLetter, setActiveLetter] = useState(null);
  const activeLetterRef = useRef(null);
  const sentinelRef = useRef(null);
  const toolbarRef = useRef(null);
  const navigate = useNavigate();

  useDocumentTitle("Library");

  const selectedSort = SORT_OPTIONS.find((option) => option.value === sortKey) || SORT_OPTIONS[0];
  const SortDirectionIcon = sortDirection === "asc" ? ArrowUp : ArrowDown;

  useEffect(() => {
    const controller = new AbortController();
    const fetchArtists = async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await getLibraryArtists({ signal: controller.signal });
        if (!controller.signal.aborted) {
          setArtists(data);
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          setError(err.response?.data?.message || "Failed to fetch artists from library");
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    };
    fetchArtists();
    return () => controller.abort();
  }, [retryKey]);

  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [searchTerm, sortKey, sortDirection]);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (toolbarRef.current && !toolbarRef.current.contains(event.target)) {
        setSortMenuOpen(false);
      }
    };
    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        setSortMenuOpen(false);
      }
    };
    document.addEventListener("pointerdown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  const onSentinel = useCallback((entries) => {
    if (entries[0].isIntersecting) {
      setVisibleCount((prev) => prev + PAGE_SIZE);
    }
  }, []);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(onSentinel, { rootMargin: "200px" });
    observer.observe(el);
    return () => observer.disconnect();
  }, [onSentinel, loading, error]);

  const handleSortOptionClick = useCallback(
    (option) => {
      if (sortKey === option.value) {
        setSortDirection((current) => (current === "asc" ? "desc" : "asc"));
        setSortMenuOpen(false);
        return;
      }
      setSortKey(option.value);
      setSortMenuOpen(false);
    },
    [sortKey],
  );

  const filteredArtists = useMemo(() => {
    let filtered = artists;

    if (searchTerm.trim()) {
      const normalizedSearch = searchTerm.trim().toLowerCase();
      filtered = filtered.filter((artist) =>
        getArtistName(artist).toLowerCase().includes(normalizedSearch),
      );
    }

    return sortArtists(filtered, sortKey, sortDirection);
  }, [artists, searchTerm, sortKey, sortDirection]);

  const visibleArtists = useMemo(
    () => filteredArtists.slice(0, visibleCount),
    [filteredArtists, visibleCount],
  );

  const groupedArtists = useMemo(() => {
    if (viewMode !== "list") return null;
    const groups = new Map();
    for (const artist of visibleArtists) {
      const key = letterKeyFor(artist);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(artist);
    }
    return [...groups.entries()].sort(([a], [b]) => {
      if (a === "#" && b === "#") return 0;
      if (a === "#") return -1;
      if (b === "#") return 1;
      return a.localeCompare(b);
    });
  }, [visibleArtists, viewMode]);

  const presentLetters = useMemo(() => {
    if (viewMode !== "list") return null;
    return new Set(filteredArtists.map(letterKeyFor));
  }, [filteredArtists, viewMode]);

  const pendingLetterRef = useRef(null);

  const scrollToLetter = useCallback(
    (letter) => {
      const target = document.getElementById(`library-group-${letter}`);
      if (target) {
        target.scrollIntoView({ behavior: "smooth" });
        return;
      }
      const index = filteredArtists.findIndex((artist) => letterKeyFor(artist) === letter);
      if (index === -1) return;
      pendingLetterRef.current = letter;
      setVisibleCount(Math.ceil((index + 1) / PAGE_SIZE) * PAGE_SIZE);
    },
    [filteredArtists],
  );

  useEffect(() => {
    const letter = pendingLetterRef.current;
    if (!letter) return;
    pendingLetterRef.current = null;
    document.getElementById(`library-group-${letter}`)?.scrollIntoView({ behavior: "smooth" });
  }, [groupedArtists]);

  useEffect(() => {
    if (viewMode !== "list" || !groupedArtists) return;

    const handleScroll = () => {
      const headers = document.querySelectorAll(".library-page__list-letter");
      let active = null;
      for (const h of headers) {
        if (h.getBoundingClientRect().top <= 140) active = h.textContent.trim();
      }
      if (active !== activeLetterRef.current) {
        activeLetterRef.current = active;
        setActiveLetter(active);
      }
    };

    window.addEventListener("scroll", handleScroll, { passive: true });
    handleScroll();
    return () => window.removeEventListener("scroll", handleScroll);
  }, [viewMode, groupedArtists]);

  const navigateToArtist = useCallback(
    (artist) => {
      const routeId = getArtistRouteId(artist);
      if (!routeId) return;
      navigate(`/artist/${encodeURIComponent(routeId)}`, {
        state: {
          artistName: getArtistName(artist),
          inLibrary: true,
          libraryArtist: artist,
        },
      });
    },
    [navigate],
  );

  const artistCountLabel = loading
    ? "Loading..."
    : `${artists.length} artist${artists.length !== 1 ? "s" : ""} in your collection`;

  return (
    <div className="library-page">
      <header className="library-page__header">
        <h1 className="page-title">Your Library</h1>
        <p className="page-subtitle">{artistCountLabel}</p>

        <div ref={toolbarRef} className="library-page__toolbar global-search">
          <div className="global-search__box">
            <div className="global-search__scope-wrap">
              <button
                type="button"
                onClick={() => setSortMenuOpen((open) => !open)}
                className={`global-search__scope-button library-page__sort-button${sortMenuOpen ? " is-open" : ""}`}
                aria-haspopup="listbox"
                aria-expanded={sortMenuOpen}
                aria-controls="library-sort-menu"
                aria-label="Sort library"
              >
                <span className="library-page__sort-label">{selectedSort.label}</span>
                <SortDirectionIcon className="artist-icon-xs library-page__sort-direction" />
                <ChevronDown
                  className={`artist-icon-sm${sortMenuOpen ? " artist-chevron--open" : ""}`}
                />
              </button>

              {sortMenuOpen && (
                <div
                  id="library-sort-menu"
                  className="artist-options-menu library-page__sort-menu"
                  role="listbox"
                  aria-label="Library sort options"
                >
                  {SORT_OPTIONS.map((option) => {
                    const active = sortKey === option.value;
                    const DirectionIcon = sortDirection === "asc" ? ArrowUp : ArrowDown;
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
                        <span>{active && <DirectionIcon className="artist-icon-xs" />}</span>
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
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder=""
                className="global-search__input"
                autoComplete="off"
                aria-label="Search library"
              />
              {!searchTerm && <div className="global-search__placeholder">Search library...</div>}
            </div>

          </div>

          <div className="library-page__view-controls">
            {viewMode === "grid" && (
              <input
                type="range"
                min="2"
                max="10"
                value={gridColumns}
                onChange={(e) => {
                  const val = parseInt(e.target.value, 10);
                  setGridColumns(val);
                  localStorage.setItem("libraryGridColumns", String(val));
                }}
                className="library-page__grid-slider"
                aria-label="Grid columns"
                title={`${gridColumns} columns`}
              />
            )}
            <button
              type="button"
              onClick={() => {
                const next = viewMode === "grid" ? "list" : "grid";
                setViewMode(next);
                localStorage.setItem("libraryViewMode", next);
              }}
              className="btn btn-icon-square library-page__view-toggle"
              aria-label={viewMode === "grid" ? "Switch to list view" : "Switch to grid view"}
              title={viewMode === "grid" ? "List view" : "Grid view"}
            >
              {viewMode === "grid" ? <List className="artist-icon-sm" /> : <LayoutGrid className="artist-icon-sm" />}
            </button>
          </div>
        </div>
      </header>

      {loading && (
        <div className="artist-loading">
          <Loader className="artist-spinner artist-spinner--large animate-spin" />
        </div>
      )}

      {error && (
        <div className="artist-error-panel" role="alert">
          <AlertCircle className="artist-error-icon" aria-hidden="true" />
          <h2 className="artist-error-title">Error Loading Library</h2>
          <p className="artist-error-copy">{error}</p>
          <button
            type="button"
            onClick={() => setRetryKey((k) => k + 1)}
            className="btn btn-secondary btn--bold btn-min-h library-page__retry-button"
          >
            Try Again
          </button>
        </div>
      )}

      {!loading && !error && artists.length === 0 && (
        <div className="search-empty-panel">
          <div className="search-empty-panel__icon" aria-hidden="true">
            <Music className="artist-icon-lg" />
          </div>
          <h2 className="search-empty-panel__title">No Artists in Library</h2>
          <p className="search-empty-panel__message">
            Your library is empty. Search and add artists in Lidarr.
          </p>
          <button
            type="button"
            onClick={() => navigate("/search")}
            className="btn btn-secondary btn--bold btn-min-h library-page__empty-action"
          >
            Search for Artists
          </button>
        </div>
      )}

      {!loading && !error && filteredArtists.length > 0 && (
        <section className="library-page__content">
          {searchTerm && (
            <p className="artist-count library-page__result-count">
              Showing {filteredArtists.length.toLocaleString()} of {artists.length.toLocaleString()}{" "}
              artists
            </p>
          )}

          <div
            className={viewMode === "list" ? "library-page__list" : "artist-albums-grid"}
            style={viewMode === "grid" ? { gridTemplateColumns: `repeat(${gridColumns}, minmax(0, 1fr))` } : undefined}
          >
            {viewMode === "list" && groupedArtists
              ? <>
                  <nav className="library-page__alphabet" aria-label="Jump to letter">
                    {ALPHABET.map((letter) => {
                      const isActive = activeLetter === letter;
                      const isPresent = presentLetters?.has(letter) ?? false;
                      return (
                        <button
                          key={letter}
                          type="button"
                          className={`library-page__alphabet-letter${isActive ? " is-active" : ""}${!isPresent ? " is-missing" : ""}`}
                          onClick={() => scrollToLetter(letter)}
                          disabled={!isPresent}
                          aria-label={`Jump to ${letter}`}
                        >
                          {letter}
                        </button>
                      );
                    })}
                  </nav>
                  {groupedArtists.map(([letter, group]) => (
                  <div key={letter} id={`library-group-${letter}`} className="library-page__list-group">
                    <span className="library-page__list-letter">{letter}</span>
                    <div className="library-page__list-items">
                      {group.map((artist) => {
                        const artistName = getArtistName(artist) || "Unknown Artist";
                        const routeId = getArtistRouteId(artist);
                        const monitorOption =
                          artist.addOptions?.monitor ||
                          artist.monitorNewItems ||
                          artist.monitorOption ||
                          "none";
                        const isMonitored = artist.monitored && monitorOption !== "none";
                        return (
                          <button
                            type="button"
                            key={artist.id}
                            className="artist-release-card"
                            onClick={() => navigateToArtist(artist)}
                            disabled={!routeId}
                            aria-label={`Open ${artistName}`}
                          >
                            <div className="artist-release-card__cover">
                              <ArtistImage
                                mbid={routeId}
                                artistName={artistName}
                                alt={artistName}
                                className="artist-image-fill"
                                showLoading={false}
                                enablePreviewPlayback
                                isInLibrary
                              />
                              {isMonitored && (
                                <span
                                  className="library-page__monitored-dot artist-status-dot artist-status-dot--complete"
                                  title="Monitored"
                                />
                              )}
                            </div>
                            <span className="artist-release-card__title" title={artistName}>
                              {artistName}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
                </>
              : visibleArtists.map((artist) => {
              const artistName = getArtistName(artist) || "Unknown Artist";
              const routeId = getArtistRouteId(artist);
              const monitorOption =
                artist.addOptions?.monitor ||
                artist.monitorNewItems ||
                artist.monitorOption ||
                "none";
              const isMonitored = artist.monitored && monitorOption !== "none";

              return (
                <button
                  type="button"
                  key={artist.id}
                  className="artist-release-card"
                  onClick={() => navigateToArtist(artist)}
                  disabled={!routeId}
                  aria-label={`Open ${artistName}`}
                >
                  <div className="artist-release-card__cover">
                    <ArtistImage
                      mbid={routeId}
                      artistName={artistName}
                      alt={artistName}
                      className="artist-image-fill"
                      showLoading={false}
                      enablePreviewPlayback
                      isInLibrary
                    />
                    {isMonitored && (
                      <span
                        className="library-page__monitored-dot artist-status-dot artist-status-dot--complete"
                        title="Monitored"
                      />
                    )}
                  </div>

                  <span className="artist-release-card__title" title={artistName}>
                    {artistName}
                  </span>
                </button>
              );
            })}
          </div>

          {visibleCount < filteredArtists.length && (
            <div ref={sentinelRef} className="search-load-more">
              <span className="search-load-more__inner">
                <Loader className="artist-spinner animate-spin" />
                Loading...
              </span>
            </div>
          )}
        </section>
      )}

      {!loading && !error && artists.length > 0 && filteredArtists.length === 0 && (
        <div className="search-empty-panel">
          <div className="search-empty-panel__icon" aria-hidden="true">
            <Music className="artist-icon-lg" />
          </div>
          <h2 className="search-empty-panel__title">No Artists Found</h2>
          <p className="search-empty-panel__message">
            No artists match your search &quot;{searchTerm}&quot;
          </p>
          <button
            type="button"
            onClick={() => setSearchTerm("")}
            className="btn btn-secondary btn--bold btn-min-h library-page__empty-action"
          >
            Clear Search
          </button>
        </div>
      )}
    </div>
  );
}

export default LibraryPage;

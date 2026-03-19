import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Loader,
  Music,
  ArrowLeft,
  CheckCircle2,
  MoreVertical,
  Library,
  Ban,
  Loader2,
} from "lucide-react";
import {
  searchArtists,
  searchArtistsByTag,
  getDiscovery,
  checkHealth,
  lookupArtistsInLibraryBatch,
  addArtistToLibrary,
  getBlocklist,
  updateBlocklist,
} from "../utils/api";
import ArtistImage from "../components/ArtistImage";
import PillToggle from "../components/PillToggle";
import { useToast } from "../contexts/ToastContext";

const PAGE_SIZE = 24;
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

const isArtistInEntries = (artist, entries) => {
  const list = Array.isArray(entries) ? entries : [];
  const artistMbid = String(artist?.id || artist?.mbid || artist?.foreignArtistId || "")
    .trim()
    .toLowerCase();
  const artistName = String(artist?.name || artist?.artistName || "")
    .trim()
    .toLowerCase();
  return list.some((entry) => {
    const entryMbid = String(entry?.mbid || "")
      .trim()
      .toLowerCase();
    const entryName = String(entry?.name || "")
      .trim()
      .toLowerCase();
    if (artistMbid && entryMbid && artistMbid === entryMbid) return true;
    if (artistName && entryName && artistName === entryName) return true;
    return false;
  });
};

function ArtistActionsMenu({
  artist,
  isInLibrary,
  isBlocked,
  onAddToLibrary,
  onAddToBlocklist,
}) {
  const [showMenu, setShowMenu] = useState(false);
  const [pendingAction, setPendingAction] = useState(null);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!showMenu) return;
    const handleClickOutside = (event) => {
      if (menuRef.current && !menuRef.current.contains(event.target)) {
        setShowMenu(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [showMenu]);

  const handleAddToLibraryClick = async (event) => {
    event.stopPropagation();
    if (isInLibrary || pendingAction) return;
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

  return (
    <div
      ref={menuRef}
      className="relative shrink-0 opacity-100"
    >
      <button
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
      {showMenu && (
        <div
          className="absolute right-0 top-full mt-1 w-44 z-30 py-1 border border-white/10 shadow-xl"
          style={{ backgroundColor: "#2a2830" }}
          onClick={(event) => event.stopPropagation()}
        >
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
        </div>
      )}
    </div>
  );
}

function SearchResultsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const query = searchParams.get("q") || "";
  const type = searchParams.get("type");
  const [results, setResults] = useState([]);
  const [fullList, setFullList] = useState(null);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  const [artistImages, setArtistImages] = useState({});
  const [hasMore, setHasMore] = useState(false);
  const [searchTotalCount, setSearchTotalCount] = useState(0);
  const [lastfmConfigured, setLastfmConfigured] = useState(null);
  const [libraryLookup, setLibraryLookup] = useState({});
  const [blockedArtists, setBlockedArtists] = useState([]);
  const sentinelRef = useRef(null);
  const navigate = useNavigate();
  const { showSuccess, showError } = useToast();

  const trimmedQuery = useMemo(() => query.trim(), [query]);
  const isTagSearch = useMemo(
    () => type === "tag" || trimmedQuery.startsWith("#"),
    [type, trimmedQuery],
  );
  const tagScope = searchParams.get("scope") || "recommended";
  const showAllTagResults = isTagSearch && tagScope === "all";

  const getArtistId = useCallback(
    (artist) => artist?.id || artist?.mbid || artist?.foreignArtistId,
    [],
  );

  const dedupe = useCallback((artists) => {
    const seen = new Set();
    return artists.filter((artist) => {
      const artistId = getArtistId(artist);
      if (!artistId) return false;
      if (seen.has(artistId)) return false;
      seen.add(artistId);
      return true;
    });
  }, [getArtistId]);
  const updateTagScope = useCallback(
    (nextScope) => {
      const params = new URLSearchParams(searchParams);
      if (nextScope === "all") {
        params.set("scope", "all");
      } else {
        params.delete("scope");
      }
      setSearchParams(params);
    },
    [searchParams, setSearchParams],
  );

  useEffect(() => {
    const fetchHealth = async () => {
      try {
        const health = await checkHealth();
        setLastfmConfigured(!!health.lastfmConfigured);
      } catch {
        setLastfmConfigured(null);
      }
    };
    fetchHealth();
  }, []);

  useEffect(() => {
    let cancelled = false;
    const loadBlocklist = async () => {
      try {
        const data = await getBlocklist();
        if (!cancelled) {
          setBlockedArtists(normalizeBlocklistArtists(data?.artists));
        }
      } catch {}
    };
    loadBlocklist();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const performSearch = async () => {
      setLibraryLookup({});
      if (type === "recommended" || type === "trending") {
        setLoading(true);
        setError(null);
        try {
          const data = await getDiscovery();
          const list =
            type === "recommended"
              ? data.recommendations || []
              : data.globalTop || [];
          setFullList(list);
          setResults(list);
          setVisibleCount(PAGE_SIZE);
          setHasMore(list.length > PAGE_SIZE);
          if (list.length > 0) {
            const imagesMap = {};
            list.forEach((artist) => {
              const artistId = getArtistId(artist);
              if (artist.image && artistId) imagesMap[artistId] = artist.image;
            });
            setArtistImages(imagesMap);
          }
        } catch (err) {
          setError(
            err.response?.data?.message || "Failed to load. Please try again.",
          );
          setFullList(null);
          setResults([]);
        } finally {
          setLoading(false);
        }
        return;
      }

      if (!query.trim() && type !== "recommended" && type !== "trending") {
        setResults([]);
        setFullList(null);
        setHasMore(false);
        return;
      }

      setLoading(true);
      setError(null);
      setVisibleCount(PAGE_SIZE);

      try {
        let artists = [];
        let totalCount = 0;
        if (isTagSearch) {
          const tag = trimmedQuery.startsWith("#")
            ? trimmedQuery.substring(1)
            : trimmedQuery;
          const data = await searchArtistsByTag(tag, PAGE_SIZE, 0, tagScope);
          artists = data.recommendations || [];
        } else {
          const data = await searchArtists(trimmedQuery, PAGE_SIZE, 0);
          artists = data.artists || [];
          totalCount = data?.count ?? 0;
        }
        const uniqueArtists = dedupe(artists);
        setResults(uniqueArtists);
        setFullList(null);
        if (!isTagSearch) {
          setSearchTotalCount(totalCount);
        }
        setHasMore(
          (isTagSearch && uniqueArtists.length >= PAGE_SIZE) ||
            (!isTagSearch && totalCount > uniqueArtists.length),
        );
        if (uniqueArtists.length > 0) {
          const imagesMap = {};
          uniqueArtists.forEach((artist) => {
            const artistId = getArtistId(artist);
            if (artist.image && artistId) imagesMap[artistId] = artist.image;
          });
          setArtistImages(imagesMap);
        }
      } catch (err) {
        setError(
          err.response?.data?.message ||
            "Failed to search artists. Please try again.",
        );
        setResults([]);
        setHasMore(false);
      } finally {
        setLoading(false);
      }
    };

    performSearch();
  }, [query, type, dedupe, trimmedQuery, isTagSearch, tagScope, getArtistId]);

  useEffect(() => {
    let cancelled = false;
    const ids = results.map((artist) => getArtistId(artist)).filter(Boolean);
    if (ids.length === 0) {
      setLibraryLookup({});
      return () => {
        cancelled = true;
      };
    }
    const missing = ids.filter((id) => libraryLookup[id] === undefined);
    if (missing.length === 0) return () => {
      cancelled = true;
    };

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
  }, [results, libraryLookup, getArtistId]);

  const loadMore = useCallback(async () => {
    if (loading || loadingMore || !hasMore) return;

    if (type === "recommended" || type === "trending") {
      const next = visibleCount + PAGE_SIZE;
      setVisibleCount((c) =>
        Math.min(c + PAGE_SIZE, fullList?.length ?? c + PAGE_SIZE),
      );
      setHasMore((fullList?.length ?? 0) > next);
      return;
    }
    if (isTagSearch) {
      setLoadingMore(true);
      try {
        const tag = trimmedQuery.startsWith("#")
          ? trimmedQuery.substring(1)
          : trimmedQuery;
        const data = await searchArtistsByTag(
          tag,
          PAGE_SIZE,
          results.length,
          tagScope,
        );
        const newArtists = data.recommendations || [];
        const combined = dedupe([...results, ...newArtists]);
        setResults(combined);
        setHasMore(newArtists.length >= PAGE_SIZE);
        newArtists.forEach((artist) => {
          const artistId = getArtistId(artist);
          if (artist.image && artistId) {
            setArtistImages((prev) => ({ ...prev, [artistId]: artist.image }));
          }
        });
      } finally {
        setLoadingMore(false);
      }
      return;
    }
    setLoadingMore(true);
    try {
      const offset = results.length;
      const data = await searchArtists(query.trim(), PAGE_SIZE, offset);
      const newArtists = data.artists || [];
      const total = data.count ?? 0;
      if (newArtists.length === 0) {
        setHasMore(false);
      } else {
        setResults((prev) => dedupe([...prev, ...newArtists]));
        setSearchTotalCount(total);
        setHasMore(total > offset + newArtists.length);
        newArtists.forEach((artist) => {
          const artistId = getArtistId(artist);
          if (artist.image && artistId) {
            setArtistImages((prev) => ({ ...prev, [artistId]: artist.image }));
          }
        });
      }
    } finally {
      setLoadingMore(false);
    }
  }, [
    type,
    fullList,
    visibleCount,
    query,
    results,
    dedupe,
    trimmedQuery,
    isTagSearch,
    tagScope,
    getArtistId,
    loading,
    loadingMore,
    hasMore,
  ]);

  const handleAddArtistToLibrary = useCallback(
    async (artist) => {
      const artistId = getArtistId(artist);
      const artistName = String(artist?.name || artist?.artistName || "").trim();
      if (!artistId || !artistName) {
        showError("Artist information not available");
        return false;
      }
      try {
        const response = await addArtistToLibrary({
          foreignArtistId: artistId,
          artistName,
        });
        setLibraryLookup((prev) => ({ ...prev, [artistId]: true }));
        if (response?.queued) {
          showSuccess(`Adding ${artistName}...`);
        } else {
          showSuccess(`${artistName} added to library`);
        }
        return true;
      } catch (err) {
        showError(
          err.response?.data?.message ||
            err.response?.data?.error ||
            "Failed to add artist to library",
        );
        return false;
      }
    },
    [getArtistId, showError, showSuccess],
  );

  const handleAddArtistToBlocklist = useCallback(
    async (artist) => {
      const artistId = String(getArtistId(artist) || "").trim();
      const artistName = String(artist?.name || artist?.artistName || "").trim();
      if (!artistId && !artistName) {
        showError("Artist information not available");
        return false;
      }
      try {
        const current = await getBlocklist();
        const entries = normalizeBlocklistArtists(current?.artists);
        if (isArtistInEntries(artist, entries)) {
          setBlockedArtists(entries);
          showSuccess("Artist already in blocklist");
          return true;
        }
        const artistMbid = MBID_REGEX.test(artistId) ? artistId : null;
        const nextArtists = [...entries, { mbid: artistMbid, name: artistName || null }];
        const response = await updateBlocklist({
          artists: nextArtists,
          tags: current?.tags || [],
        });
        const savedArtists = normalizeBlocklistArtists(
          response?.blocklist?.artists || nextArtists,
        );
        setBlockedArtists(savedArtists);
        showSuccess("Artist added to blocklist");
        return true;
      } catch (err) {
        showError(err.response?.data?.message || "Failed to update blocklist");
        return false;
      }
    },
    [getArtistId, showError, showSuccess],
  );

  const onSentinel = useCallback(
    (entries) => {
      if (entries[0]?.isIntersecting) {
        loadMore();
      }
    },
    [loadMore],
  );

  const getArtistType = (artistType) => {
    const types = {
      Person: "Solo Artist",
      Group: "Band",
      Orchestra: "Orchestra",
      Choir: "Choir",
      Character: "Character",
      Other: "Other",
    };
    return types[artistType] || artistType;
  };

  const displayedArtists =
    type === "recommended" || type === "trending"
      ? results.slice(0, visibleCount)
      : results;

  const showContent =
    !loading && (query || type === "recommended" || type === "trending");
  const isEmpty = displayedArtists.length === 0;
  const showBackButton =
    type === "recommended" ||
    type === "trending" ||
    isTagSearch ||
    !!trimmedQuery;
  const showLoadMore =
    hasMore &&
    (type === "recommended" || type === "trending"
      ? results.length > PAGE_SIZE
      : isTagSearch
        ? results.length >= PAGE_SIZE
        : results.length >= PAGE_SIZE && searchTotalCount > PAGE_SIZE);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !showContent || isEmpty || !showLoadMore) return;
    const observer = new IntersectionObserver(onSentinel, {
      rootMargin: "200px",
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [onSentinel, showContent, isEmpty, showLoadMore]);

  return (
    <div className="animate-fade-in">
      <div className="mb-6">
        {showBackButton && (
          <button
            onClick={() => navigate(-1)}
            className="btn btn-secondary mb-6 inline-flex items-center"
          >
            <ArrowLeft className="w-5 h-5 mr-2" />
            Back
          </button>
        )}
        <div className="flex flex-wrap items-center gap-4">
          <h1 className="text-2xl font-bold" style={{ color: "#fff" }}>
            {type === "recommended"
              ? "Recommended for You"
              : type === "trending"
                ? "Global Trending"
                : isTagSearch
                  ? "Tag Results"
                  : trimmedQuery
                    ? loading
                      ? `Showing results for "${trimmedQuery}"`
                      : `Showing ${results.length} results for "${trimmedQuery}"`
                    : "Search Results"}
          </h1>
          {isTagSearch && (
            <div className="ml-auto inline-flex items-center gap-3">
              <span
                className="text-sm"
                style={{ color: showAllTagResults ? "#8a8a8f" : "#fff" }}
              >
                Recommended
              </span>
              <PillToggle
                checked={showAllTagResults}
                onChange={(e) =>
                  updateTagScope(e.target.checked ? "all" : "recommended")
                }
              />
              <span
                className="text-sm"
                style={{ color: showAllTagResults ? "#fff" : "#8a8a8f" }}
              >
                All
              </span>
            </div>
          )}
        </div>
        {isTagSearch && lastfmConfigured === false && (
          <div className="mt-4 bg-yellow-500/20 p-4">
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-yellow-300 text-sm">
                Tag search and discovery recommendations use Last.fm. Add an
                API key to enable full results.
              </p>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => navigate("/settings")}
              >
                Open Settings
              </button>
            </div>
          </div>
        )}
        {type === "recommended" && (
          <p style={{ color: "#c1c1c3" }}>
            {results.length} artist{results.length !== 1 ? "s" : ""} we think
            you&apos;ll like
          </p>
        )}
        {type === "trending" && (
          <p style={{ color: "#c1c1c3" }}>Trending artists right now</p>
        )}
        {isTagSearch && trimmedQuery && (
          <p
            style={{ color: "#c1c1c3" }}
          >{`${
            showAllTagResults ? "Top artists" : "Recommended artists"
          } for tag "${trimmedQuery.startsWith("#") ? trimmedQuery.substring(1) : trimmedQuery}"`}</p>
        )}
      </div>

      {error && (
        <div className="mb-6 bg-red-500/20 ">
          <p className="text-red-400">{error}</p>
        </div>
      )}

      {loading && (
        <div className="flex justify-center items-center py-20">
          <Loader
            className="w-12 h-12 animate-spin"
            style={{ color: "#c1c1c3" }}
          />
        </div>
      )}

      {showContent && (
        <div className="animate-slide-up">
          {isEmpty ? (
            <div className="card text-center py-12">
              <Music
                className="w-16 h-16 mx-auto mb-4"
                style={{ color: "#c1c1c3" }}
              />
              <h3
                className="text-xl font-semibold mb-2"
                style={{ color: "#fff" }}
              >
                No Results Found
              </h3>
              <p style={{ color: "#c1c1c3" }}>
                {type === "recommended" || type === "trending"
                  ? "Nothing to show here yet."
                  : isTagSearch
                    ? `We couldn't find any ${
                        showAllTagResults ? "artists" : "recommended artists"
                      } for tag "${trimmedQuery.startsWith("#") ? trimmedQuery.substring(1) : trimmedQuery}"`
                    : `We couldn't find any artists matching "${trimmedQuery}"`}
              </p>
              {isTagSearch && !showAllTagResults && (
                <button
                  type="button"
                  className="btn btn-primary mt-6"
                  onClick={() => updateTagScope("all")}
                >
                  Try searching all
                </button>
              )}
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-6">
                {displayedArtists.map((artist, index) => {
                  const artistId = getArtistId(artist);
                  const artistTypeText = artist.type
                    ? getArtistType(artist.type)
                    : null;
                  const artistMetaText = [
                    artistTypeText,
                    type === "recommended" &&
                      artist.sourceArtist &&
                      `Similar to ${artist.sourceArtist}`,
                  ]
                    .filter(Boolean)
                    .join(" • ");
                  const isInLibrary = !!libraryLookup[artistId];
                  const isBlocked = isArtistInEntries(artist, blockedArtists);
                  return (
                  <div
                    key={artistId || `artist-${index}`}
                    className="group relative flex flex-col w-full min-w-0"
                  >
                    <div
                      onClick={() =>
                        navigate(`/artist/${artistId}`, {
                          state: { artistName: artist.name },
                        })
                      }
                      className="relative aspect-square mb-3 overflow-hidden cursor-pointer shadow-sm group-hover:shadow-md transition-all"
                      style={{ backgroundColor: "#211f27" }}
                    >
                      <ArtistImage
                        src={
                          artistImages[artistId] ||
                          artist.image ||
                          artist.imageUrl
                        }
                        mbid={artistId}
                        artistName={artist.name}
                        alt={artist.name}
                        className="h-full w-full group-hover:scale-105 transition-transform duration-300"
                        showLoading={false}
                      />
                    </div>

                    <div className="flex items-start gap-2 min-w-0">
                      <div className="flex flex-col min-w-0 flex-1">
                        <div className="flex items-center gap-2 min-w-0">
                          <h3
                            onClick={() =>
                              navigate(`/artist/${artistId}`, {
                                state: { artistName: artist.name },
                              })
                            }
                            className="font-semibold truncate hover:underline cursor-pointer"
                            style={{ color: "#fff" }}
                            title={artist.name}
                          >
                            {artist.name}
                          </h3>
                          {isInLibrary && (
                            <CheckCircle2 className="w-4 h-4 text-green-400 shrink-0" />
                          )}
                        </div>

                        <div
                          className="flex flex-col min-w-0 text-sm"
                          style={{ color: "#c1c1c3" }}
                        >
                          {artistMetaText && (
                            <p className="truncate" title={artistMetaText}>
                              {artistMetaText}
                            </p>
                          )}

                          {artist.country && (
                            <p
                              className="truncate text-xs opacity-80"
                              title={artist.country}
                            >
                              {artist.country}
                            </p>
                          )}
                        </div>
                      </div>
                      <ArtistActionsMenu
                        artist={artist}
                        isInLibrary={isInLibrary}
                        isBlocked={isBlocked}
                        onAddToLibrary={handleAddArtistToLibrary}
                        onAddToBlocklist={handleAddArtistToBlocklist}
                      />
                    </div>
                  </div>
                  );
                })}
              </div>

              {showLoadMore && (
                <div ref={sentinelRef} className="mt-8 flex justify-center">
                  <div className="px-6 py-3 font-medium rounded-lg" style={{ color: "#c1c1c3" }}>
                    <span className="flex items-center gap-2">
                      <Loader className="w-5 h-5 animate-spin" />
                      Loading...
                    </span>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default SearchResultsPage;

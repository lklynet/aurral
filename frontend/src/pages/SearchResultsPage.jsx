import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  ArrowLeft,
  ArrowUpDown,
  ChevronDown,
  Disc,
  Disc3,
  Filter,
  FileMusic,
  Loader,
  Music,
} from "lucide-react";
import {
  addArtistToLibrary,
  addDiscoveryFeedback,
  getBlocklist,
  getDiscovery,
  getBootstrapStatus,
  getArtistCover,
  getReleaseGroupCover,
  lookupAlbumsInLibraryBatch,
  lookupArtistsInLibraryBatch,
  requestAlbumFromSearch,
  searchCatalog,
  updateBlocklist,
} from "../utils/api";
import PillToggle from "../components/PillToggle";
import SearchAlbumResults from "../components/SearchAlbumResults";
import SearchArtistResults from "../components/SearchArtistResults";
import { useAuth } from "../contexts/AuthContext";
import { useToast } from "../contexts/ToastContext";
import { useReleaseTypeFilter } from "./ArtistDetails/hooks/useReleaseTypeFilter";

const PAGE_SIZE = 20;
const DEFAULT_ALBUM_SORT = "relevance";
const ALBUM_SORT_OPTIONS = [
  { value: "relevance", label: "Relevance" },
  { value: "dateDesc", label: "Newest" },
  { value: "artistAsc", label: "Artist (A-Z)" },
  { value: "titleAsc", label: "Title (A-Z)" },
];
const MBID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function getReleaseTypeIcon(type) {
  if (type === "Album") return <Disc className="h-4 w-4" />;
  if (type === "EP") return <Disc3 className="h-4 w-4" />;
  if (type === "Single") return <FileMusic className="h-4 w-4" />;
  return <Music className="h-4 w-4" />;
}

function getArtistId(artist) {
  return artist?.id || artist?.mbid || artist?.foreignArtistId;
}

function dedupeArtists(artists) {
  const seen = new Set();
  return artists.filter((artist) => {
    const artistId = getArtistId(artist);
    if (!artistId || seen.has(artistId)) return false;
    seen.add(artistId);
    return true;
  });
}

function dedupeAlbums(albums) {
  const seen = new Set();
  return albums.filter((album) => {
    if (!album?.id || seen.has(album.id)) return false;
    seen.add(album.id);
    return true;
  });
}

const ARTIST_IMAGE_HYDRATION_CONCURRENCY = 6;
const ALBUM_COVER_HYDRATION_CONCURRENCY = 6;

function normalizeBlocklistArtists(artists) {
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
}

function matchesBlockedArtist(target, artist) {
  const targetId = String(target?.id || target?.mbid || target?.foreignArtistId || "")
    .trim()
    .toLowerCase();
  const targetName = String(target?.name || target?.artistName || "")
    .trim()
    .toLowerCase();
  const artistId = String(artist?.id || artist?.mbid || artist?.foreignArtistId || "")
    .trim()
    .toLowerCase();
  const artistName = String(artist?.name || artist?.artistName || "")
    .trim()
    .toLowerCase();
  return (targetId && artistId && targetId === artistId) ||
    (targetName && artistName && targetName === artistName);
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
  const [albumCovers, setAlbumCovers] = useState({});
  const [hasMore, setHasMore] = useState(false);
  const [searchTotalCount, setSearchTotalCount] = useState(0);
  const [lastfmConfigured, setLastfmConfigured] = useState(null);
  const [libraryLookup, setLibraryLookup] = useState({});
  const [albumLibraryLookup, setAlbumLibraryLookup] = useState({});
  const [blockedArtists, setBlockedArtists] = useState([]);
  const [pendingAlbumIds, setPendingAlbumIds] = useState({});
  const [showReleaseTypeDropdown, setShowReleaseTypeDropdown] = useState(false);
  const sentinelRef = useRef(null);
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const { showSuccess, showError } = useToast();
  const {
    selectedReleaseTypes,
    setSelectedReleaseTypes,
    primaryReleaseTypes,
    secondaryReleaseTypes,
    allReleaseTypes,
  } = useReleaseTypeFilter();

  const trimmedQuery = useMemo(() => query.trim(), [query]);
  const normalizedType = useMemo(() => {
    if (type === "recommended" || type === "trending") return type;
    if (type === "album") return "album";
    if (type === "tag" || trimmedQuery.startsWith("#")) return "tag";
    return "artist";
  }, [type, trimmedQuery]);
  const isTagSearch = normalizedType === "tag";
  const isAlbumSearch = normalizedType === "album";
  const tagScope = searchParams.get("scope") || "recommended";
  const albumSort = searchParams.get("sort") || DEFAULT_ALBUM_SORT;
  const showAllTagResults = isTagSearch && tagScope === "all";
  const supportsDiscoveryFeedback =
    normalizedType === "recommended" || (isTagSearch && !showAllTagResults);
  const canAddArtist = hasPermission("addArtist");
  const canAddAlbum = hasPermission("addAlbum");
  const hasActiveReleaseTypeFilters = useMemo(() => {
    if (selectedReleaseTypes.length !== allReleaseTypes.length) return true;
    return !allReleaseTypes.every((typeName) =>
      selectedReleaseTypes.includes(typeName),
    );
  }, [allReleaseTypes, selectedReleaseTypes]);
  const inactiveReleaseTypeCount = useMemo(
    () =>
      allReleaseTypes.filter(
        (typeName) => !selectedReleaseTypes.includes(typeName),
      ).length,
    [allReleaseTypes, selectedReleaseTypes],
  );

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

  const updateAlbumSort = useCallback(
    (nextSort) => {
      const params = new URLSearchParams(searchParams);
      if (nextSort === DEFAULT_ALBUM_SORT) {
        params.delete("sort");
      } else {
        params.set("sort", nextSort);
      }
      setSearchParams(params);
    },
    [searchParams, setSearchParams],
  );

  useEffect(() => {
    const fetchHealth = async () => {
      try {
        const bootstrap = await getBootstrapStatus();
        setLastfmConfigured(!!bootstrap.lastfmConfigured);
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
      setAlbumLibraryLookup({});
      setPendingAlbumIds({});
      setAlbumCovers({});

      if (normalizedType === "recommended" || normalizedType === "trending") {
        setLoading(true);
        setError(null);
        try {
          const data = await getDiscovery();
          const list =
            normalizedType === "recommended"
              ? data.recommendations || []
              : data.globalTop || [];
          setFullList(list);
          setResults(list);
          setVisibleCount(PAGE_SIZE);
          setHasMore(list.length > PAGE_SIZE);
          setSearchTotalCount(list.length);
          const imagesMap = {};
          list.forEach((artist) => {
            const artistId = getArtistId(artist);
            if ((artist.image || artist.imageUrl) && artistId) {
              imagesMap[artistId] = artist.image || artist.imageUrl;
            }
          });
          setArtistImages(imagesMap);
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

      if (!trimmedQuery) {
        setResults([]);
        setFullList(null);
        setHasMore(false);
        setSearchTotalCount(0);
        return;
      }

      setLoading(true);
      setError(null);
      setVisibleCount(PAGE_SIZE);

      try {
        const searchQuery = isTagSearch
          ? trimmedQuery.replace(/^#/, "")
          : trimmedQuery;
        const data = await searchCatalog(searchQuery, normalizedType, {
          limit: PAGE_SIZE,
          offset: 0,
          tagScope,
          releaseTypes: isAlbumSearch ? selectedReleaseTypes : [],
        });
        const nextResults = isAlbumSearch
          ? dedupeAlbums(data.items || [])
          : dedupeArtists(data.items || []);
        setResults(nextResults);
        setFullList(null);
        setSearchTotalCount(data?.count ?? nextResults.length);
        setHasMore(
          data?.hasMore ??
            (data?.count ?? nextResults.length) > nextResults.length,
        );

        if (!isAlbumSearch && nextResults.length > 0) {
          const imagesMap = {};
          nextResults.forEach((artist) => {
            const artistId = getArtistId(artist);
            if ((artist.image || artist.imageUrl) && artistId) {
              imagesMap[artistId] = artist.image || artist.imageUrl;
            }
          });
          setArtistImages(imagesMap);
        } else if (!isAlbumSearch) {
          setArtistImages({});
        }
      } catch (err) {
        setError(
          err.response?.data?.message ||
            `Failed to search ${isAlbumSearch ? "albums" : "artists"}. Please try again.`,
        );
        setResults([]);
        setHasMore(false);
      } finally {
        setLoading(false);
      }
    };

    performSearch();
  }, [
    trimmedQuery,
    normalizedType,
    tagScope,
    isAlbumSearch,
    isTagSearch,
    selectedReleaseTypes,
  ]);

  useEffect(() => {
    if (isAlbumSearch || isTagSearch || results.length === 0) return undefined;

    let cancelled = false;
    const pendingArtists = results.filter((artist) => {
      const artistId = getArtistId(artist);
      if (!artistId) return false;
      if (artistImages[artistId]) return false;
      if (artist.image || artist.imageUrl) return false;
      return true;
    });

    if (pendingArtists.length === 0) {
      return () => {
        cancelled = true;
      };
    }

    const hydrateArtistImages = async () => {
      for (
        let index = 0;
        index < pendingArtists.length && !cancelled;
        index += ARTIST_IMAGE_HYDRATION_CONCURRENCY
      ) {
        const batch = pendingArtists.slice(
          index,
          index + ARTIST_IMAGE_HYDRATION_CONCURRENCY,
        );
        const results = await Promise.allSettled(
          batch.map(async (artist) => {
            const artistId = getArtistId(artist);
            if (!artistId) return null;
            const data = await getArtistCover(artistId, artist.name);
            const imageUrl = data?.images?.[0]?.image || null;
            return imageUrl ? [artistId, imageUrl] : null;
          }),
        );
        if (cancelled) return;
        const nextBatch = Object.fromEntries(
          results.filter(
            (entry) => Array.isArray(entry.value) && entry.value[0] && entry.value[1],
          ).map((entry) => entry.value),
        );
        if (Object.keys(nextBatch).length > 0) {
          setArtistImages((prev) => ({ ...prev, ...nextBatch }));
        }
      }
    };

    hydrateArtistImages();

    return () => {
      cancelled = true;
    };
  }, [artistImages, isAlbumSearch, isTagSearch, results]);

  useEffect(() => {
    if (isAlbumSearch) return undefined;
    let cancelled = false;
    const ids = results.map((artist) => getArtistId(artist)).filter(Boolean);
    if (ids.length === 0) {
      if (Object.keys(libraryLookup).length > 0) {
        setLibraryLookup({});
      }
      return () => {
        cancelled = true;
      };
    }
    const missing = ids.filter((id) => libraryLookup[id] === undefined);
    if (missing.length === 0) {
      return () => {
        cancelled = true;
      };
    }

    const fetchLookup = async () => {
      try {
        const lookup = await lookupArtistsInLibraryBatch(missing);
        if (!cancelled && lookup) {
          setLibraryLookup((prev) => ({ ...prev, ...lookup }));
        }
      } catch {}
    };

    fetchLookup();
    return () => {
      cancelled = true;
    };
  }, [results, libraryLookup, isAlbumSearch]);

  useEffect(() => {
    if (!isAlbumSearch || results.length === 0) return undefined;
    let cancelled = false;
    const missingCoverIds = results
      .filter((album) => !album.coverUrl)
      .map((album) => album.id)
      .filter((id) => id && albumCovers[id] === undefined);

    if (missingCoverIds.length === 0) {
      return () => {
        cancelled = true;
      };
    }

    const hydrateCovers = async () => {
      for (
        let index = 0;
        index < missingCoverIds.length && !cancelled;
        index += ALBUM_COVER_HYDRATION_CONCURRENCY
      ) {
        const batch = missingCoverIds.slice(
          index,
          index + ALBUM_COVER_HYDRATION_CONCURRENCY,
        );
        const coverResults = await Promise.allSettled(
          batch.map(async (id) => {
            const album = results.find((item) => item.id === id);
            const data = await getReleaseGroupCover(id, {
              artistName: album?.artistName || "",
              albumTitle: album?.title || "",
            });
            return [id, data?.images?.[0]?.image || null];
          }),
        );
        if (cancelled) return;
        const nextBatch = Object.fromEntries(
          coverResults
            .filter(
              (entry) =>
                Array.isArray(entry.value) &&
                entry.value[0] &&
                entry.value[1] !== undefined,
            )
            .map((entry) => entry.value),
        );
        if (Object.keys(nextBatch).length > 0) {
          setAlbumCovers((prev) => ({
            ...prev,
            ...nextBatch,
          }));
        }
      }
    };

    hydrateCovers();

    return () => {
      cancelled = true;
    };
  }, [results, isAlbumSearch, albumCovers]);

  useEffect(() => {
    if (!isAlbumSearch || results.length === 0) return undefined;
    let cancelled = false;
    const missingAlbumIds = results
      .filter(
        (album) =>
          album?.id &&
          !album.inLibrary &&
          albumLibraryLookup[album.id] === undefined,
      )
      .map((album) => album.id);

    if (missingAlbumIds.length === 0) {
      return () => {
        cancelled = true;
      };
    }

    const hydrateLibraryStatus = async () => {
      try {
        const lookup = await lookupAlbumsInLibraryBatch(missingAlbumIds);
        if (cancelled || !lookup || typeof lookup !== "object") return;

        const resolvedLookup = {};
        for (const albumId of missingAlbumIds) {
          resolvedLookup[albumId] = lookup[albumId] || false;
        }

        setAlbumLibraryLookup((prev) => ({
          ...prev,
          ...resolvedLookup,
        }));

        setResults((prev) =>
          prev.map((album) => {
            const match = lookup[album.id];
            if (!match) return album;
            return {
              ...album,
              inLibrary: !!match.inLibrary,
              libraryAlbumId: match.libraryAlbumId || album.libraryAlbumId,
              libraryArtistId: match.libraryArtistId || album.libraryArtistId,
              status: match.status || album.status,
            };
          }),
        );
      } catch {
        if (!cancelled) {
          setAlbumLibraryLookup((prev) => {
            const next = { ...prev };
            for (const albumId of missingAlbumIds) {
              if (next[albumId] === undefined) {
                next[albumId] = false;
              }
            }
            return next;
          });
        }
      }
    };

    hydrateLibraryStatus();

    return () => {
      cancelled = true;
    };
  }, [results, isAlbumSearch, albumLibraryLookup]);

  const loadMore = useCallback(async () => {
    if (loading || loadingMore || !hasMore) return;

    if (normalizedType === "recommended" || normalizedType === "trending") {
      const next = visibleCount + PAGE_SIZE;
      setVisibleCount((count) =>
        Math.min(count + PAGE_SIZE, fullList?.length ?? count + PAGE_SIZE),
      );
      setHasMore((fullList?.length ?? 0) > next);
      return;
    }

    setLoadingMore(true);
    try {
      const searchQuery = isTagSearch
        ? trimmedQuery.replace(/^#/, "")
        : trimmedQuery;
      const data = await searchCatalog(searchQuery, normalizedType, {
        limit: PAGE_SIZE,
        offset: results.length,
        tagScope,
        releaseTypes: isAlbumSearch ? selectedReleaseTypes : [],
      });
      const newItems = data.items || [];
      setSearchTotalCount(data?.count ?? searchTotalCount);
      if (isAlbumSearch) {
        setResults((prev) => dedupeAlbums([...prev, ...newItems]));
      } else {
        setResults((prev) => dedupeArtists([...prev, ...newItems]));
        newItems.forEach((artist) => {
          const artistId = getArtistId(artist);
          if ((artist.image || artist.imageUrl) && artistId) {
            setArtistImages((prev) => ({
              ...prev,
              [artistId]: artist.image || artist.imageUrl,
            }));
          }
        });
      }
      setHasMore(
        data?.hasMore ??
          (data?.count ?? 0) > results.length + newItems.length,
      );
    } finally {
      setLoadingMore(false);
    }
  }, [
    fullList,
    hasMore,
    isAlbumSearch,
    isTagSearch,
    loading,
    loadingMore,
    normalizedType,
    results,
    searchTotalCount,
    selectedReleaseTypes,
    tagScope,
    trimmedQuery,
    visibleCount,
  ]);

  const onSentinel = useCallback(
    (entries) => {
      if (entries[0]?.isIntersecting) {
        loadMore();
      }
    },
    [loadMore],
  );

  const handleAlbumAction = useCallback(
    async (album) => {
      if (!album?.id) return;
      const shouldTriggerSearch = album.status === "inLibrary";
      setPendingAlbumIds((prev) => ({ ...prev, [album.id]: true }));
      try {
        const result = await requestAlbumFromSearch({
          albumMbid: album.id,
          albumName: album.title,
          artistMbid: album.artistMbid,
          artistName: album.artistName,
          triggerSearch: shouldTriggerSearch,
        });
        setResults((prev) =>
          prev.map((item) =>
            item.id === album.id
              ? {
                  ...item,
                  inLibrary: true,
                  libraryAlbumId: result.album?.id || item.libraryAlbumId,
                  libraryArtistId: result.artist?.id || item.libraryArtistId,
                  status: result.status || item.status,
                }
              : item,
          ),
        );
        showSuccess(
          result.triggeredSearch
            ? `Search triggered for ${album.title}`
            : `${album.title} added to library`,
        );
      } catch (err) {
        showError(
          err.response?.data?.error ||
            err.response?.data?.message ||
            err.message ||
            "Failed to request album",
        );
      } finally {
        setPendingAlbumIds((prev) => {
          const next = { ...prev };
          delete next[album.id];
          return next;
        });
      }
    },
    [showError, showSuccess],
  );

  const handleArtistAction = useCallback(
    async (artist) => {
      const artistId = getArtistId(artist);
      if (!artist?.name || !artistId) return false;
      try {
        await addArtistToLibrary({
          foreignArtistId: artistId,
          artistName: artist.name,
        });
        setLibraryLookup((prev) => ({
          ...prev,
          [artistId]: true,
        }));
        showSuccess(`Adding ${artist.name}...`);
        return true;
      } catch (err) {
        showError(
          err.response?.data?.message ||
            err.response?.data?.error ||
            err.message ||
            "Failed to add artist to library",
        );
        return false;
      }
    },
    [showError, showSuccess],
  );

  const handleAddArtistToBlocklist = useCallback(
    async (artist) => {
      const artistId = getArtistId(artist);
      if (!artist?.name && !artistId) return false;
      try {
        const current = await getBlocklist();
        const nextArtists = normalizeBlocklistArtists([
          ...(current?.artists || []),
          {
            mbid: artistId,
            name: artist.name || null,
          },
        ]);
        const response = await updateBlocklist({
          artists: nextArtists,
          tags: current?.tags || [],
        });
        setBlockedArtists(
          normalizeBlocklistArtists(response?.blocklist?.artists || nextArtists),
        );
        setResults((prev) => prev.filter((entry) => !matchesBlockedArtist(entry, artist)));
        setFullList((prev) =>
          Array.isArray(prev)
            ? prev.filter((entry) => !matchesBlockedArtist(entry, artist))
            : prev,
        );
        showSuccess("Artist added to blocklist");
        return true;
      } catch (err) {
        showError(
          err.response?.data?.message || "Failed to update blocklist",
        );
        return false;
      }
    },
    [showError, showSuccess],
  );

  const handleArtistFeedback = useCallback(
    async (artist, action) => {
      try {
        await addDiscoveryFeedback({
          artistId: getArtistId(artist),
          artistName: artist.name || null,
          action,
          sourceContext: artist.sourceType || artist.discoveryTier || null,
          tagContext: artist.matchedTags || artist.tags || [],
          seedContext: Array.isArray(artist.supportingSeeds)
            ? artist.supportingSeeds.map((seed) => seed?.artistName).filter(Boolean)
            : artist.sourceArtists || [],
        });
        if (action === "hide_for_now") {
          setResults((prev) =>
            prev.filter((entry) => !matchesBlockedArtist(entry, artist)),
          );
          setFullList((prev) =>
            Array.isArray(prev) ? prev.filter((entry) => !matchesBlockedArtist(entry, artist)) : prev,
          );
          setSearchTotalCount((prev) => Math.max(0, prev - 1));
          setHasMore((prev) => {
            if (!prev) return false;
            if (normalizedType === "recommended" || normalizedType === "trending") {
              const nextFullListLength = Array.isArray(fullList)
                ? fullList.filter((entry) => !matchesBlockedArtist(entry, artist)).length
                : 0;
              return nextFullListLength > visibleCount;
            }
            return true;
          });
        }
        showSuccess(
          action === "more_like_this"
            ? "We’ll bias future picks toward this taste"
            : action === "less_like_this"
              ? "We’ll show less like this"
              : action === "already_known"
                ? "We’ll avoid obvious repeats like this"
                : "Hidden from recommendations for now",
        );
        return true;
      } catch (err) {
        showError(
          err.response?.data?.message || "Failed to save discovery feedback",
        );
        return false;
      }
    },
    [fullList, normalizedType, showError, showSuccess, visibleCount],
  );

  const displayedResults =
    normalizedType === "recommended" || normalizedType === "trending"
      ? results.slice(0, visibleCount)
      : results;

  const showContent =
    !loading && (query || normalizedType === "recommended" || normalizedType === "trending");
  const isEmpty = displayedResults.length === 0;
  const showBackButton =
    normalizedType === "recommended" ||
    normalizedType === "trending" ||
    !!trimmedQuery;
  const showLoadMore =
    hasMore &&
    (normalizedType === "recommended" || normalizedType === "trending"
      ? results.length > PAGE_SIZE
      : displayedResults.length >= PAGE_SIZE);

  useEffect(() => {
    const element = sentinelRef.current;
    if (!element || !showContent || isEmpty || !showLoadMore) return;
    const observer = new IntersectionObserver(onSentinel, {
      rootMargin: "200px",
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [isEmpty, onSentinel, showContent, showLoadMore]);

  const emptyMessage =
    normalizedType === "recommended" || normalizedType === "trending"
      ? "Nothing to show here yet."
      : isAlbumSearch
        ? `We couldn't find any albums matching "${trimmedQuery}"`
        : isTagSearch
          ? `We couldn't find any ${
              showAllTagResults ? "artists" : "recommended artists"
            } for tag "${trimmedQuery.replace(/^#/, "")}"`
          : `We couldn't find any artists matching "${trimmedQuery}"`;

  return (
    <div className="animate-fade-in">
      <div className="mb-6">
        {showBackButton && (
          <button
            onClick={() => navigate(-1)}
            className="btn btn-secondary mb-6 hidden items-center sm:inline-flex"
          >
            <ArrowLeft className="mr-2 h-5 w-5" />
            Back
          </button>
        )}

        <div className="flex flex-wrap items-center gap-4">
          <h1 className="text-2xl font-bold" style={{ color: "#fff" }}>
            {normalizedType === "recommended"
              ? "Recommended for You"
              : normalizedType === "trending"
                ? "Global Trending"
                : isTagSearch
                  ? "Tag Results"
                  : isAlbumSearch
                    ? trimmedQuery
                      ? `Showing ${displayedResults.length} albums for "${trimmedQuery}"`
                      : "Album Results"
                    : trimmedQuery
                      ? `Showing ${displayedResults.length} artists for "${trimmedQuery}"`
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
                onChange={(event) =>
                  updateTagScope(event.target.checked ? "all" : "recommended")
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

        {isTagSearch && !showAllTagResults && lastfmConfigured === false && (
          <div className="mt-4 bg-yellow-500/20 p-4">
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-sm text-yellow-300">
                Recommended tag results use the hydrated Last.fm discovery
                cache. Add an API key to enable that path.
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

        {normalizedType === "recommended" && (
          <p style={{ color: "#c1c1c3" }}>
            {results.length} artist{results.length !== 1 ? "s" : ""} we think
            you&apos;ll like
          </p>
        )}
        {normalizedType === "trending" && (
          <p style={{ color: "#c1c1c3" }}>Trending artists right now</p>
        )}
        {isTagSearch && trimmedQuery && (
          <p style={{ color: "#c1c1c3" }}>
            {`${showAllTagResults ? "Top artists" : "Recommended artists"} for tag "${trimmedQuery.replace(/^#/, "")}"`}
          </p>
        )}
        {isAlbumSearch && trimmedQuery && (
          <div className="space-y-3">
            <p className="max-w-3xl text-sm" style={{ color: "#c1c1c3" }}>
              Search results include compilations, soundtracks, and releases
              from Various Artists.
            </p>

            <div
              className="grid gap-2 border border-white/6 p-2 sm:flex sm:flex-wrap sm:items-center"
              style={{ backgroundColor: "rgba(20,19,24,0.72)" }}
            >
              <div className="flex flex-wrap items-center gap-2 sm:flex-1">
                {primaryReleaseTypes.map((typeName) => {
                  const isSelected = selectedReleaseTypes.includes(typeName);
                  return (
                    <button
                      key={typeName}
                      type="button"
                      onClick={() => {
                        if (isSelected) {
                          setSelectedReleaseTypes(
                            selectedReleaseTypes.filter((value) => value !== typeName),
                          );
                        } else {
                          setSelectedReleaseTypes([
                            ...selectedReleaseTypes,
                            typeName,
                          ]);
                        }
                      }}
                      className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium transition-all"
                      style={{
                        backgroundColor: isSelected ? "#4a4a4a" : "#18171d",
                        color: isSelected ? "#fff" : "#cfcfd3",
                      }}
                    >
                      {getReleaseTypeIcon(typeName)}
                      <span>{typeName}</span>
                    </button>
                  );
                })}
              </div>

              <div className="grid grid-cols-2 gap-2 sm:flex sm:contents">
              <div className="relative min-w-0">
                <div className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2">
                  <ArrowUpDown className="h-4 w-4" style={{ color: "#c1c1c3" }} />
                </div>
                <select
                  value={albumSort}
                  onChange={(event) => updateAlbumSort(event.target.value)}
                  className="input input-sm w-full min-w-0 appearance-none pr-9 pl-9"
                  style={{ backgroundColor: "#18171d" }}
                  aria-label="Sort album results"
                >
                  {ALBUM_SORT_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <ChevronDown
                  className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2"
                  style={{ color: "#c1c1c3" }}
                />
              </div>

              <div className="relative min-w-0">
                <button
                  type="button"
                  onClick={() =>
                    setShowReleaseTypeDropdown((current) => !current)
                  }
                  className="btn btn-secondary btn-sm flex w-full items-center justify-between gap-2 px-3 py-2 sm:w-auto sm:justify-start"
                >
                  <Filter className="h-4 w-4" />
                  <span className="text-sm">More</span>
                  {hasActiveReleaseTypeFilters && (
                    <span
                      className="flex h-[18px] min-w-[18px] items-center justify-center px-1.5 text-xs text-white"
                      style={{ backgroundColor: "#0f0f12" }}
                    >
                      {inactiveReleaseTypeCount}
                    </span>
                  )}
                  <ChevronDown
                    className={`h-4 w-4 transition-transform ${
                      showReleaseTypeDropdown ? "rotate-180" : ""
                    }`}
                  />
                </button>

                {showReleaseTypeDropdown && (
                  <>
                    <div
                      className="fixed inset-0 z-10"
                      onClick={() => setShowReleaseTypeDropdown(false)}
                    />
                    <div
                      className="absolute right-0 top-full z-20 mt-2 min-w-[280px] p-4 shadow-xl"
                      style={{ backgroundColor: "#211f27" }}
                    >
                      <div className="space-y-4">
                        <div>
                          <h3
                            className="mb-2 text-sm font-semibold"
                            style={{ color: "#fff" }}
                          >
                            Secondary Types
                          </h3>
                          <div className="space-y-2">
                            {secondaryReleaseTypes.map((typeName) => (
                              <label
                                key={typeName}
                                className="flex cursor-pointer items-center space-x-2 px-2 py-1.5 transition-colors hover:bg-gray-900/50"
                              >
                                <input
                                  type="checkbox"
                                  checked={selectedReleaseTypes.includes(typeName)}
                                  onChange={(event) => {
                                    if (event.target.checked) {
                                      setSelectedReleaseTypes([
                                        ...selectedReleaseTypes,
                                        typeName,
                                      ]);
                                    } else {
                                      setSelectedReleaseTypes(
                                        selectedReleaseTypes.filter(
                                          (value) => value !== typeName,
                                        ),
                                      );
                                    }
                                  }}
                                  className="form-checkbox h-4 w-4"
                                  style={{ color: "#c1c1c3" }}
                                />
                                <span
                                  className="text-sm"
                                  style={{ color: "#fff" }}
                                >
                                  {typeName}
                                </span>
                              </label>
                            ))}
                          </div>
                        </div>

                        <div className="pt-3">
                          <div className="flex gap-2">
                            <button
                              type="button"
                              onClick={() => {
                                const currentPrimary = selectedReleaseTypes.filter(
                                  (value) => primaryReleaseTypes.includes(value),
                                );
                                setSelectedReleaseTypes([
                                  ...currentPrimary,
                                  ...secondaryReleaseTypes,
                                ]);
                              }}
                              className="text-xs hover:underline"
                              style={{ color: "#c1c1c3" }}
                            >
                              Select All
                            </button>
                            <span style={{ color: "#c1c1c3" }}>|</span>
                            <button
                              type="button"
                              onClick={() => {
                                const currentPrimary = selectedReleaseTypes.filter(
                                  (value) => primaryReleaseTypes.includes(value),
                                );
                                setSelectedReleaseTypes(currentPrimary);
                              }}
                              className="text-xs hover:underline"
                              style={{ color: "#c1c1c3" }}
                            >
                              Clear All
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  </>
                )}
              </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {error && (
        <div className="mb-6 bg-red-500/20 p-4">
          <p className="text-red-400">{error}</p>
        </div>
      )}

      {loading && (
        <div className="flex items-center justify-center py-20">
          <Loader
            className="h-12 w-12 animate-spin"
            style={{ color: "#c1c1c3" }}
          />
        </div>
      )}

      {showContent && (
        <div className="animate-slide-up">
          {isEmpty ? (
            <div className="card py-12 text-center">
              <Music
                className="mx-auto mb-4 h-16 w-16"
                style={{ color: "#c1c1c3" }}
              />
              <h3
                className="mb-2 text-xl font-semibold"
                style={{ color: "#fff" }}
              >
                No Results Found
              </h3>
              <p style={{ color: "#c1c1c3" }}>{emptyMessage}</p>
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
              {isAlbumSearch ? (
                <SearchAlbumResults
                  albums={displayedResults}
                  albumCovers={albumCovers}
                  canAddAlbum={canAddAlbum}
                  pendingAlbumIds={pendingAlbumIds}
                  onAlbumAction={handleAlbumAction}
                  navigate={navigate}
                />
              ) : (
                <SearchArtistResults
                  artists={displayedResults}
                  type={normalizedType}
                  artistImages={artistImages}
                  libraryLookup={libraryLookup}
                  navigate={navigate}
                  canAddArtist={canAddArtist}
                  blockedArtists={blockedArtists}
                  onAddArtistToLibrary={handleArtistAction}
                  onAddArtistToBlocklist={handleAddArtistToBlocklist}
                  onArtistFeedback={
                    supportsDiscoveryFeedback ? handleArtistFeedback : undefined
                  }
                />
              )}

              {showLoadMore && (
                <div ref={sentinelRef} className="mt-8 flex justify-center">
                  <div
                    className="rounded-lg px-6 py-3 font-medium"
                    style={{ color: "#c1c1c3" }}
                  >
                    <span className="flex items-center gap-2">
                      <Loader className="h-5 w-5 animate-spin" />
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

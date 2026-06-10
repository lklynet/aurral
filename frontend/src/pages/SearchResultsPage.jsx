import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import {
  Grid3X3,
  List,
  Loader,
  Music,
  SlidersHorizontal,
  X,
  Star,
} from "lucide-react";
import {
  addArtistToLibrary,
  addDiscoveryFeedback,
  getDiscoveryFeedback,
  removeDiscoveryFeedback,
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
import SearchAlbumResults from "../components/SearchAlbumResults";
import SearchArtistResults from "../components/SearchArtistResults";
import { useAuth } from "../contexts/AuthContext";
import { useToast } from "../contexts/ToastContext";
import { allReleaseTypes } from "./ArtistDetails/constants";
import {
  applyArtistDiscoveryFeedback,
  buildArtistFeedbackLookup,
  normalizeDiscoveryFeedbackList,
} from "../utils/discoveryFeedback";

const PAGE_SIZE = 20;
const DEFAULT_ALBUM_SORT = "relevance";
const LASTFM_TAG_BANNER_KEY = "aurral:lastfm-tag-results-banner-dismissed";
const ALBUM_SORT_OPTIONS = [
  { value: "relevance", label: "Relevance" },
  { value: "dateDesc", label: "Newest" },
  { value: "artistAsc", label: "Artist (A-Z)" },
  { value: "titleAsc", label: "Title (A-Z)" },
];
const MBID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ALBUM_RELEASE_TABS = [
  { value: "all", label: "All" },
  { value: "albums", label: "Albums" },
  { value: "singles", label: "EP & Singles" },
  { value: "compilations", label: "Compilations" },
];

function isAlbumCompilation(album) {
  return (
    album?.primaryType === "Compilation" ||
    (album?.secondaryTypes || []).includes("Compilation")
  );
}

function isAlbumSingleOrEp(album) {
  return album?.primaryType === "Single" || album?.primaryType === "EP";
}

function matchesAlbumReleaseTab(album, tab) {
  if (tab === "all") return true;
  if (tab === "compilations") return isAlbumCompilation(album);
  if (tab === "singles") {
    return isAlbumSingleOrEp(album) && !isAlbumCompilation(album);
  }
  return album?.primaryType === "Album" && !isAlbumCompilation(album);
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
  const [discoveryFeedback, setDiscoveryFeedback] = useState([]);
  const [pendingAlbumIds, setPendingAlbumIds] = useState({});
  const [albumOptionsOpen, setAlbumOptionsOpen] = useState(false);
  const [albumViewMode, setAlbumViewMode] = useState("grid");
  const [albumReleaseTab, setAlbumReleaseTab] = useState("all");
  const [dismissedTagBanner, setDismissedTagBanner] = useState(false);
  const sentinelRef = useRef(null);
  const albumOptionsMenuRef = useRef(null);
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const { showSuccess, showError } = useToast();

  const trimmedQuery = useMemo(() => query.trim(), [query]);
  const normalizedType = useMemo(() => {
    if (type === "recommended" || type === "trending") return type;
    if (type === "album") return "album";
    if (type === "tag" || trimmedQuery.startsWith("#")) return "tag";
    return "artist";
  }, [type, trimmedQuery]);
  const isTagSearch = normalizedType === "tag";
  const isAlbumSearch = normalizedType === "album";
  const pageTitle = useMemo(() => {
    if (normalizedType === "recommended") return "Recommended for You";
    if (normalizedType === "trending") return "Global Trending";
    if (isTagSearch && trimmedQuery) {
      return trimmedQuery.startsWith("#")
        ? trimmedQuery
        : `#${trimmedQuery.replace(/^#/, "")}`;
    }
    if (isAlbumSearch) return trimmedQuery || "Album Results";
    return trimmedQuery || "Search Results";
  }, [normalizedType, isTagSearch, trimmedQuery, isAlbumSearch]);
  useDocumentTitle(pageTitle);
  const albumSort = searchParams.get("sort") || DEFAULT_ALBUM_SORT;
  const showTagBanner = isTagSearch && lastfmConfigured === false && !dismissedTagBanner;
  const supportsDiscoveryFeedback =
    normalizedType === "recommended" || isTagSearch;
  const artistFeedbackLookup = useMemo(
    () => buildArtistFeedbackLookup(discoveryFeedback),
    [discoveryFeedback],
  );
  const canAddArtist = hasPermission("addArtist");
  const canAddAlbum = hasPermission("addAlbum");

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
    if (!isAlbumSearch) return;
    setAlbumReleaseTab("all");
  }, [trimmedQuery, isAlbumSearch]);

  useEffect(() => {
    if (!isTagSearch) return;
    try {
      setDismissedTagBanner(localStorage.getItem(LASTFM_TAG_BANNER_KEY) === "1");
    } catch {
      setDismissedTagBanner(false);
    }
  }, [isTagSearch]);

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
    if (!supportsDiscoveryFeedback) {
      setDiscoveryFeedback([]);
      return;
    }
    let cancelled = false;
    const loadFeedback = async () => {
      try {
        const payload = await getDiscoveryFeedback();
        if (!cancelled) {
          setDiscoveryFeedback(normalizeDiscoveryFeedbackList(payload));
        }
      } catch {}
    };
    loadFeedback();
    return () => {
      cancelled = true;
    };
  }, [supportsDiscoveryFeedback]);

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
          releaseTypes: isAlbumSearch ? allReleaseTypes : [],
          sort: isAlbumSearch ? albumSort : undefined,
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
    isAlbumSearch,
    isTagSearch,
    albumSort,
  ]);

  useEffect(() => {
    if (isAlbumSearch || results.length === 0) return undefined;

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
  }, [artistImages, isAlbumSearch, results]);

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
        releaseTypes: isAlbumSearch ? allReleaseTypes : [],
        sort: isAlbumSearch ? albumSort : undefined,
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
    trimmedQuery,
    visibleCount,
    albumSort,
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
    async (artist, action, { isSelected = false } = {}) => {
      try {
        const payload = {
          artistId: getArtistId(artist),
          artistName: artist.name || null,
          action,
          sourceContext: artist.sourceType || artist.discoveryTier || null,
          tagContext: artist.matchedTags || artist.tags || [],
          seedContext: Array.isArray(artist.supportingSeeds)
            ? artist.supportingSeeds.map((seed) => seed?.artistName).filter(Boolean)
            : artist.sourceArtists || [],
        };
        const { feedbackList } = await applyArtistDiscoveryFeedback({
          feedbackList: discoveryFeedback,
          artist,
          action,
          isSelected,
          payload,
          addDiscoveryFeedback,
          removeDiscoveryFeedback,
        });
        setDiscoveryFeedback(feedbackList);
        if (action === "hide_for_now" && !isSelected) {
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
        if (!isSelected) {
          showSuccess(
            action === "more_like_this"
              ? "We’ll bias future picks toward this taste"
              : action === "less_like_this"
                ? "We’ll show less like this"
                : action === "already_known"
                  ? "We’ll avoid obvious repeats like this"
                  : "Hidden from recommendations for now",
          );
        }
        return true;
      } catch (err) {
        showError(
          err.response?.data?.message || "Failed to save discovery feedback",
        );
        return false;
      }
    },
    [discoveryFeedback, fullList, normalizedType, showError, showSuccess, visibleCount],
  );

  const albumResultsForTab = useMemo(() => {
    if (!isAlbumSearch) return results;
    return results.filter((album) => matchesAlbumReleaseTab(album, albumReleaseTab));
  }, [albumReleaseTab, isAlbumSearch, results]);

  const displayedResults =
    normalizedType === "recommended" || normalizedType === "trending"
      ? results.slice(0, visibleCount)
      : isAlbumSearch
        ? albumResultsForTab
        : results;

  const showContent =
    !loading && (query || normalizedType === "recommended" || normalizedType === "trending");
  const isEmpty = displayedResults.length === 0;
  const showLoadMore =
    hasMore &&
    (normalizedType === "recommended" || normalizedType === "trending"
      ? results.length > PAGE_SIZE
      : displayedResults.length >= PAGE_SIZE);

  useEffect(() => {
    if (!albumOptionsOpen) return undefined;
    const handlePointerDown = (event) => {
      if (albumOptionsMenuRef.current?.contains(event.target)) return;
      setAlbumOptionsOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [albumOptionsOpen]);

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
          ? `We couldn't find any artists for tag "${trimmedQuery.replace(/^#/, "")}"`
          : `We couldn't find any artists matching "${trimmedQuery}"`;

  const pageSubtitle =
    normalizedType === "recommended"
      ? `${results.length} artist${results.length !== 1 ? "s" : ""} we think you'll like`
      : normalizedType === "trending"
        ? "Trending artists right now"
        : isTagSearch && trimmedQuery
          ? `Artists for tag "${trimmedQuery.replace(/^#/, "")}"`
          : isAlbumSearch && trimmedQuery
            ? null
            : trimmedQuery
              ? `${displayedResults.length} artist${displayedResults.length !== 1 ? "s" : ""}`
              : null;

  return (
    <div className="search-page">
      <header className="search-page__header">
        {showTagBanner && (
          <div className="search-banner">
            <p className="search-banner__copy">
              Tag results are limited to the hydrated discovery cache. Add a free
              Last.fm API key in Settings for broader top-artist matches.
            </p>
            <div className="search-banner__actions">
              <button
                type="button"
                className="btn btn-secondary btn--bold btn-min-h"
                onClick={() => navigate("/settings")}
              >
                Open Settings
              </button>
              <button
                type="button"
                className="btn btn-surface btn-icon-square"
                aria-label="Dismiss Last.fm reminder"
                onClick={() => {
                  setDismissedTagBanner(true);
                  try {
                    localStorage.setItem(LASTFM_TAG_BANNER_KEY, "1");
                  } catch {}
                }}
              >
                <X className="artist-icon-sm" />
              </button>
            </div>
          </div>
        )}

        <div className="search-page__title-row">
          <h1 className="search-page__title">{pageTitle}</h1>
        </div>

        {(pageSubtitle || (isTagSearch && lastfmConfigured !== false)) && (
          <div className="search-page__subtitle-row">
            {pageSubtitle && (
              <p className="search-page__subtitle">{pageSubtitle}</p>
            )}
            {isTagSearch && lastfmConfigured !== false && (
              <span className="search-page__tag-legend">
                <Star className="search-page__tag-legend-icon" />
                <span>recommended</span>
              </span>
            )}
          </div>
        )}

        {isAlbumSearch && trimmedQuery && (
          <>
            <p className="search-page__subtitle">
              Search results include compilations, soundtracks, and releases
              from Various Artists.
            </p>

            <div className="artist-heading-row">
              <div className="artist-min-0">
                <div className="artist-tabs">
                  {ALBUM_RELEASE_TABS.map((tab) => (
                    <button
                      key={tab.value}
                      type="button"
                      onClick={() => setAlbumReleaseTab(tab.value)}
                      className={`artist-tab${albumReleaseTab === tab.value ? " is-active" : ""}`}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="artist-options" ref={albumOptionsMenuRef}>
                <button
                  type="button"
                  onClick={() => setAlbumOptionsOpen((current) => !current)}
                  className="btn btn-surface btn-icon-square"
                  aria-label="Album search options"
                  title="Album search options"
                  aria-expanded={albumOptionsOpen}
                >
                  <SlidersHorizontal className="artist-icon-sm" />
                </button>
                {albumOptionsOpen && (
                  <div className="artist-options-menu">
                    {ALBUM_SORT_OPTIONS.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => {
                          updateAlbumSort(option.value);
                          setAlbumOptionsOpen(false);
                        }}
                        className={`artist-menu-item${albumSort === option.value ? " is-active" : ""}`}
                      >
                        <span>{option.label}</span>
                      </button>
                    ))}
                    <div className="artist-menu-section" />
                    <div className="artist-options-view-grid">
                      <button
                        type="button"
                        onClick={() => setAlbumViewMode("grid")}
                        className={`btn btn-icon-square btn-surface${albumViewMode === "grid" ? " btn-neutral-active" : ""}`}
                        aria-label="Grid view"
                        title="Grid view"
                      >
                        <Grid3X3 className="artist-icon-sm" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setAlbumViewMode("list")}
                        className={`btn btn-icon-square btn-surface${albumViewMode === "list" ? " btn-neutral-active" : ""}`}
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
              {displayedResults.length.toLocaleString()} release
              {displayedResults.length === 1 ? "" : "s"}
            </div>
          </>
        )}
      </header>

      {error && (
        <div className="artist-error-panel" role="alert">
          <p className="artist-error-text">{error}</p>
        </div>
      )}

      {loading && (
        <div className="artist-loading">
          <Loader className="artist-spinner artist-spinner--large animate-spin" />
        </div>
      )}

      {showContent && (
        <>
          {isEmpty ? (
            <div className="search-empty-panel">
              <div className="search-empty-panel__icon" aria-hidden="true">
                <Music className="artist-icon-lg" />
              </div>
              <h2 className="search-empty-panel__title">No Results Found</h2>
              <p className="search-empty-panel__message">{emptyMessage}</p>
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
                  viewMode={albumViewMode}
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
                  artistFeedbackLookup={
                    supportsDiscoveryFeedback ? artistFeedbackLookup : undefined
                  }
                />
              )}

              {showLoadMore && (
                <div ref={sentinelRef} className="search-load-more">
                  <span className="search-load-more__inner">
                    <Loader className="artist-spinner animate-spin" />
                    Loading...
                  </span>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

export default SearchResultsPage;

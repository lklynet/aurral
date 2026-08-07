import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  addArtistToLibrary,
  lookupAlbumsInLibraryBatch,
  lookupArtistsInLibraryBatch,
  requestAlbumFromSearch,
} from "../utils/api/endpoints/library.js";
import {
  addSharedPlaylistTracks,
  createSharedPlaylist,
} from "../utils/api/endpoints/playlists.js";
import { getDiscovery } from "../utils/api/endpoints/discovery.js";
import { getArtistCover, getReleaseGroupCover } from "../utils/api/endpoints/artists.js";
import { searchCatalog, searchUnified } from "../utils/api/endpoints/search.js";
import SearchAlbumResults from "../components/SearchAlbumResults";
import SearchArtistResults from "../components/SearchArtistResults";
import AddActionButton from "../components/AddActionButton";
import SearchLibraryCheck from "../components/SearchLibraryCheck";
import SearchMixedResultList from "../components/SearchMixedResultList";
import SearchTopResultCard from "../components/SearchTopArtistCard";
import { TrackPlaylistMenu } from "./ArtistDetails/components/TrackPlaylistMenu";
import {
  buildMixedSearchPageItems,
  buildSearchArtistResults,
  resolveSearchTopResult,
} from "../utils/searchNavigation";
import { useAuth } from "../contexts/AuthContext";
import { useToast } from "../contexts/ToastContext";
import { allReleaseTypes } from "./ArtistDetails/constants";
import { readReleaseListViewMode, writeReleaseListViewMode } from "./ArtistDetails/utils";
import { useArtistTasteFeedback } from "../hooks/useArtistTasteFeedback";
import { useSharedPlaylists } from "../hooks/useSharedPlaylists";
import { getArtistRecordId } from "../utils/artistTaste";
import { getAlbumAddButtonLabel, isAlbumCompleteInLibrary, shouldTriggerAlbumSearch } from "../utils/albumAddAction";
import {
  PAGE_SIZE,
  DEFAULT_ALBUM_SORT,
  ALBUM_PENDING_STATUSES,
  LASTFM_TAG_BANNER_KEY,
  ALBUM_SORT_OPTIONS,
  ALBUM_RELEASE_TABS,
  UNIFIED_FILTER_OPTIONS,
  matchesAlbumReleaseTab,
  isAlbumSingleOrEp,
  dedupeArtists,
  dedupeAlbums,
  ARTIST_IMAGE_HYDRATION_CONCURRENCY,
  ALBUM_COVER_HYDRATION_CONCURRENCY,
} from "./searchPageUtils";
import { useSearchParams } from "react-router-dom";
import { useDiscoverNavigation } from "../hooks/useDiscoverNavigation";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  Grid3X3,
  LayoutGrid,
  List,
  Loader,
  Music,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";

const RECOMMENDED_SORT_OPTIONS = [
  { value: "name", label: "Name" },
  { value: "relevance", label: "Relevance" },
  { value: "popularity", label: "Popularity" },
];

const getRecommendedArtistName = (artist) => String(artist?.name || "").trim();

const getRecommendedScore = (artist) =>
  Number(artist?.scoreTotal ?? artist?.score ?? artist?.scoreSimilarity ?? 0) || 0;

const getRecommendedPopularity = (artist) => {
  const rank = Number(artist?.popularityRank);
  if (Number.isFinite(rank) && rank > 0) return -rank;
  return Number(artist?.listeners ?? artist?.playcount ?? 0) || 0;
};

const sortRecommendedArtists = (artists, sortKey, sortDirection) =>
  [...artists].sort((left, right) => {
    let difference;
    if (sortKey === "name") {
      difference = getRecommendedArtistName(left).localeCompare(getRecommendedArtistName(right));
    } else if (sortKey === "relevance") {
      difference = getRecommendedScore(left) - getRecommendedScore(right);
    } else {
      difference = getRecommendedPopularity(left) - getRecommendedPopularity(right);
    }
    if (difference !== 0) return sortDirection === "asc" ? difference : -difference;
    return getRecommendedArtistName(left).localeCompare(getRecommendedArtistName(right));
  });
function SearchResultsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const query = searchParams.get("q") || "";
  const type = searchParams.get("type");
  const rawFilter = searchParams.get("filter") || "all";
  const activeFilter =
    rawFilter === "library" || rawFilter === "tracks"
      ? "all"
      : rawFilter;
  const [results, setResults] = useState([]);
  const [unifiedResults, setUnifiedResults] = useState(null);
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
  const [pendingAlbumIds, setPendingAlbumIds] = useState({});
  const [pendingArtistIds, setPendingArtistIds] = useState({});
  const [albumOptionsOpen, setAlbumOptionsOpen] = useState(false);
  const [albumViewMode, setAlbumViewMode] = useState(() => readReleaseListViewMode());
  const [albumReleaseTab, setAlbumReleaseTab] = useState("all");
  const [recommendedSearchTerm, setRecommendedSearchTerm] = useState("");
  const [recommendedSortKey, setRecommendedSortKey] = useState("name");
  const [recommendedSortDirection, setRecommendedSortDirection] = useState("asc");
  const [recommendedSortMenuOpen, setRecommendedSortMenuOpen] = useState(false);
  const [recommendedViewMode, setRecommendedViewMode] = useState(
    () => localStorage.getItem("libraryViewMode") || "grid",
  );
  const [recommendedGridColumns, setRecommendedGridColumns] = useState(() => {
    const saved = parseInt(localStorage.getItem("libraryGridColumns"), 10);
    return saved >= 2 && saved <= 10 ? saved : 6;
  });
  const [dismissedTagBanner, setDismissedTagBanner] = useState(false);
  const {
    sharedPlaylists,
    setSharedPlaylists,
    playlistsLoading: playlistModalLoading,
    playlistsError: playlistModalError,
    setPlaylistsError: setPlaylistModalError,
    loadSharedPlaylists,
  } = useSharedPlaylists();
  const [playlistMenuSavingKey, setPlaylistMenuSavingKey] = useState("");
  const sentinelRef = useRef(null);
  const albumOptionsMenuRef = useRef(null);
  const recommendedToolbarRef = useRef(null);
  const navigate = useDiscoverNavigation();
  const { hasPermission, bootstrap } = useAuth();
  const { showSuccess, showError } = useToast();

  const trimmedQuery = useMemo(() => query.trim(), [query]);
  const normalizedType = useMemo(() => {
    if (type === "recommended" || type === "trending") return type;
    if (type === "album") return "album";
    if (type === "tag" || trimmedQuery.startsWith("#")) return "tag";
    if (type === "artist") return "artist";
    return "unified";
  }, [type, trimmedQuery]);
  const isTagSearch = normalizedType === "tag";
  const isAlbumSearch = normalizedType === "album";
  const isUnifiedSearch = normalizedType === "unified" && !!trimmedQuery;
  const pageTitle = useMemo(() => {
    if (normalizedType === "recommended") return "Recommended for You";
    if (normalizedType === "trending") return "Global Trending";
    if (isTagSearch && trimmedQuery) {
      return trimmedQuery.startsWith("#") ? trimmedQuery : `#${trimmedQuery.replace(/^#/, "")}`;
    }
    if (isAlbumSearch) return trimmedQuery || "Album Results";
    if (isUnifiedSearch) return trimmedQuery || "Search Results";
    return trimmedQuery || "Search Results";
  }, [normalizedType, isTagSearch, trimmedQuery, isAlbumSearch, isUnifiedSearch]);
  useDocumentTitle(pageTitle);
  const albumSort = searchParams.get("sort") || DEFAULT_ALBUM_SORT;
  const showTagBanner = isTagSearch && lastfmConfigured === false && !dismissedTagBanner;
  const { lookup: artistFeedbackLookup, submitFeedback } = useArtistTasteFeedback();
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

  const handleRecommendedSortOptionClick = useCallback(
    (option) => {
      if (recommendedSortKey === option.value) {
        setRecommendedSortDirection((current) => (current === "asc" ? "desc" : "asc"));
        setRecommendedSortMenuOpen(false);
        return;
      }
      setRecommendedSortKey(option.value);
      setRecommendedSortDirection(option.value === "name" ? "asc" : "desc");
      setRecommendedSortMenuOpen(false);
    },
    [recommendedSortKey],
  );

  const updateUnifiedFilter = useCallback(
    (nextFilter) => {
      const params = new URLSearchParams(searchParams);
      if (!nextFilter || nextFilter === "all") {
        params.delete("filter");
      } else {
        params.set("filter", nextFilter);
      }
      setSearchParams(params);
    },
    [searchParams, setSearchParams],
  );

  useEffect(() => {
    if (bootstrap) {
      setLastfmConfigured(!!bootstrap.lastfmConfigured);
    }
  }, [bootstrap]);

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

    const performSearch = async () => {
      setLibraryLookup({});
      setAlbumLibraryLookup({});
      setPendingAlbumIds({});
      setAlbumCovers({});

      if (normalizedType === "recommended" || normalizedType === "trending") {
        setLoading(true);
        setError(null);
        try {
          const isRecommended = normalizedType === "recommended";
          const data = await getDiscovery();
          const list =
            isRecommended ? data.recommendations || [] : data.globalTop || [];
          if (isRecommended) {
            setResults(list);
            setSearchTotalCount(data.recommendationCount ?? list.length);
            setHasMore(false);
          } else {
            setFullList(list);
            setResults(list);
            setVisibleCount(PAGE_SIZE);
            setHasMore(list.length > PAGE_SIZE);
            setSearchTotalCount(list.length);
          }
          const imagesMap = {};
          list.forEach((artist) => {
            const artistId = getArtistRecordId(artist);
            if ((artist.image || artist.imageUrl) && artistId) {
              imagesMap[artistId] = artist.image || artist.imageUrl;
            }
          });
          setArtistImages(imagesMap);
        } catch (err) {
          if (cancelled) return;
          setError(err.response?.data?.message || "Failed to load. Please try again.");
          setFullList(null);
          setResults([]);
        } finally {
          if (!cancelled) setLoading(false);
        }
        return;
      }

      if (!trimmedQuery) {
        setResults([]);
        setUnifiedResults(null);
        setFullList(null);
        setHasMore(false);
        setSearchTotalCount(0);
        setLoading(false);
        setError(null);
        return;
      }

      if (isUnifiedSearch) {
        setLoading(true);
        setError(null);
        setUnifiedResults(null);
        setResults([]);
        setFullList(null);
        setHasMore(false);
        setVisibleCount(PAGE_SIZE);
        try {
          const data = await searchUnified(trimmedQuery, {
            mode: "full",
            limit: 20,
          });
          if (cancelled) return;
          setUnifiedResults(data);
          setSearchTotalCount(
            (data?.catalog?.artists?.length || 0) +
              (data?.catalog?.albums?.length || 0) +
              (data?.library?.tracks?.length || 0),
          );
          const imageMap = {};
          for (const artist of data?.catalog?.artists || []) {
            if (artist?.id && (artist.imageUrl || artist.image)) {
              imageMap[artist.id] = artist.imageUrl || artist.image;
            }
          }
          setArtistImages(imageMap);
        } catch (err) {
          if (cancelled) return;
          setError(err.response?.data?.message || "Failed to search. Please try again.");
          setUnifiedResults(null);
        } finally {
          if (!cancelled) setLoading(false);
        }
        return;
      }

      setLoading(true);
      setError(null);
      setVisibleCount(PAGE_SIZE);

      try {
        const searchQuery = isTagSearch ? trimmedQuery.replace(/^#/, "") : trimmedQuery;
        const data = await searchCatalog(searchQuery, normalizedType, {
          limit: PAGE_SIZE,
          offset: 0,
          releaseTypes: isAlbumSearch ? allReleaseTypes : [],
          sort: isAlbumSearch ? albumSort : undefined,
        });
        if (cancelled) return;
        const nextResults = isAlbumSearch
          ? dedupeAlbums(data.items || [])
          : dedupeArtists(data.items || []);
        setResults(nextResults);
        setFullList(null);
        setSearchTotalCount(data?.count ?? nextResults.length);
        setHasMore(data?.hasMore ?? (data?.count ?? nextResults.length) > nextResults.length);

        if (!isAlbumSearch && nextResults.length > 0) {
          const imagesMap = {};
          nextResults.forEach((artist) => {
            const artistId = getArtistRecordId(artist);
            if ((artist.image || artist.imageUrl) && artistId) {
              imagesMap[artistId] = artist.image || artist.imageUrl;
            }
          });
          setArtistImages(imagesMap);
        } else if (!isAlbumSearch) {
          setArtistImages({});
        }
      } catch (err) {
        if (cancelled) return;
        setError(
          err.response?.data?.message ||
            `Failed to search ${isAlbumSearch ? "albums" : "artists"}. Please try again.`,
        );
        setResults([]);
        setHasMore(false);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    performSearch();
    return () => {
      cancelled = true;
    };
  }, [trimmedQuery, normalizedType, isAlbumSearch, isTagSearch, isUnifiedSearch, albumSort]);

  useEffect(() => {
    if (!isUnifiedSearch || !unifiedResults) return undefined;
    const artists = (unifiedResults.catalog?.artists || []).filter((artist) => artist?.id);
    const ids = artists.map((artist) => artist.id);
    if (ids.length === 0) return undefined;

    let cancelled = false;
    const missing = ids.filter((id) => libraryLookup[id] === undefined);
    if (missing.length === 0) return undefined;

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
  }, [isUnifiedSearch, unifiedResults, libraryLookup]);

  useEffect(() => {
    if (isAlbumSearch) return undefined;

    let cancelled = false;
    const artists = isUnifiedSearch ? buildSearchArtistResults(unifiedResults, {}) : results;

    if (isUnifiedSearch && !unifiedResults) {
      return undefined;
    }
    if (!artists.length) {
      return undefined;
    }

    const seenArtistIds = new Set();
    const pendingArtists = artists.filter((artist) => {
      const artistId = getArtistRecordId(artist);
      if (!artistId || seenArtistIds.has(artistId)) return false;
      seenArtistIds.add(artistId);
      if (artistImages[artistId] !== undefined) return false;
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
        const batch = pendingArtists.slice(index, index + ARTIST_IMAGE_HYDRATION_CONCURRENCY);
        const coverResults = await Promise.allSettled(
          batch.map(async (artist) => {
            const artistId = getArtistRecordId(artist);
            if (!artistId) return [null, null];
            const data = await getArtistCover(artistId, artist.name);
            const imageUrl = data?.images?.[0]?.image || null;
            return [artistId, imageUrl];
          }),
        );
        if (cancelled) return;
        const nextBatch = {};
        batch.forEach((artist, batchIndex) => {
          const artistId = getArtistRecordId(artist);
          const entry = coverResults[batchIndex];
          if (entry?.status === "fulfilled" && artistId) {
            nextBatch[artistId] = entry.value?.[1] ?? null;
          } else if (artistId) {
            nextBatch[artistId] = null;
          }
        });
        if (Object.keys(nextBatch).length > 0) {
          setArtistImages((prev) => ({ ...prev, ...nextBatch }));
        }
      }
    };

    hydrateArtistImages();

    return () => {
      cancelled = true;
    };
  }, [artistImages, isAlbumSearch, isUnifiedSearch, results, unifiedResults]);

  useEffect(() => {
    if (isAlbumSearch || isUnifiedSearch) return undefined;
    let cancelled = false;
    const ids = results.map((artist) => getArtistRecordId(artist)).filter(Boolean);
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
  }, [results, libraryLookup, isAlbumSearch, isUnifiedSearch]);

  useEffect(() => {
    if (!isUnifiedSearch || !unifiedResults?.catalog?.albums?.length) {
      return undefined;
    }
    let cancelled = false;
    const albums = unifiedResults.catalog.albums.filter((album) => album?.id);
    const missingCoverIds = albums
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
        const batch = missingCoverIds.slice(index, index + ALBUM_COVER_HYDRATION_CONCURRENCY);
        const coverResults = await Promise.allSettled(
          batch.map(async (id) => {
            const album = albums.find((item) => item.id === id);
            const data = await getReleaseGroupCover(id, {
              artistName: album?.artistName || "",
              albumTitle: album?.title || "",
            });
            return [id, data?.images?.[0]?.image || null];
          }),
        );
        if (cancelled) return;
        const nextBatch = {};
        batch.forEach((id, batchIndex) => {
          const entry = coverResults[batchIndex];
          if (entry?.status === "fulfilled") {
            nextBatch[id] = entry.value?.[1] ?? null;
          } else {
            nextBatch[id] = null;
          }
        });
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
  }, [albumCovers, isUnifiedSearch, unifiedResults]);

  useEffect(() => {
    if (!isUnifiedSearch || !unifiedResults) {
      return undefined;
    }
    let cancelled = false;
    const tracks = unifiedResults.library?.tracks || [];
    const albums = unifiedResults.catalog?.albums || [];
    const missingCoverIds = tracks
      .map((track) => track?.albumMbid)
      .filter(
        (albumMbid) =>
          albumMbid &&
          albumCovers[albumMbid] === undefined &&
          !albums.some(
            (album) => album.id === albumMbid && (album.coverUrl || albumCovers[album.id]),
          ),
      )
      .filter((albumMbid, index, list) => list.indexOf(albumMbid) === index);

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
        const batch = missingCoverIds.slice(index, index + ALBUM_COVER_HYDRATION_CONCURRENCY);
        const coverResults = await Promise.allSettled(
          batch.map(async (id) => {
            const album = albums.find((item) => item.id === id);
            const track = tracks.find((item) => item.albumMbid === id);
            const data = await getReleaseGroupCover(id, {
              artistName: album?.artistName || track?.artistName || "",
              albumTitle: album?.title || track?.albumTitle || "",
            });
            return [id, data?.images?.[0]?.image || null];
          }),
        );
        if (cancelled) return;
        const nextBatch = {};
        batch.forEach((id, batchIndex) => {
          const entry = coverResults[batchIndex];
          if (entry?.status === "fulfilled") {
            nextBatch[id] = entry.value?.[1] ?? null;
          } else {
            nextBatch[id] = null;
          }
        });
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
  }, [albumCovers, isUnifiedSearch, unifiedResults]);

  useEffect(() => {
    if (!isUnifiedSearch || !unifiedResults?.catalog?.albums?.length) {
      return undefined;
    }
    let cancelled = false;
    const missingAlbumIds = unifiedResults.catalog.albums
      .filter(
        (album) => album?.id && !album.inLibrary && albumLibraryLookup[album.id] === undefined,
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

        setUnifiedResults((prev) => {
          if (!prev?.catalog?.albums) return prev;
          const topAlbumMatch = prev.top?.type === "album" ? lookup[prev.top.id] : null;
          return {
            ...prev,
            top: topAlbumMatch
              ? {
                  ...prev.top,
                  inLibrary: !!topAlbumMatch.inLibrary,
                  libraryAlbumId: topAlbumMatch.libraryAlbumId || prev.top.libraryAlbumId,
                  libraryArtistId: topAlbumMatch.libraryArtistId || prev.top.libraryArtistId,
                  status: topAlbumMatch.status || prev.top.status,
                }
              : prev.top,
            catalog: {
              ...prev.catalog,
              albums: prev.catalog.albums.map((album) => {
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
            },
          };
        });
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
  }, [albumLibraryLookup, isUnifiedSearch, unifiedResults]);

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
        const batch = missingCoverIds.slice(index, index + ALBUM_COVER_HYDRATION_CONCURRENCY);
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
        const nextBatch = {};
        batch.forEach((id, batchIndex) => {
          const entry = coverResults[batchIndex];
          if (entry?.status === "fulfilled") {
            nextBatch[id] = entry.value?.[1] ?? null;
          } else {
            nextBatch[id] = null;
          }
        });
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
        (album) => album?.id && !album.inLibrary && albumLibraryLookup[album.id] === undefined,
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

    if (normalizedType === "recommended") {
      setLoadingMore(true);
      try {
        const data = await getDiscovery({ offset: results.length, limit: PAGE_SIZE });
        const newItems = data.recommendations || [];
        setResults((prev) => [...prev, ...newItems]);
        setSearchTotalCount(data.recommendationCount ?? 0);
        setHasMore(
          newItems.length === PAGE_SIZE &&
            results.length + newItems.length < (data.recommendationCount ?? 0),
        );
        const imagesMap = {};
        newItems.forEach((artist) => {
          const artistId = getArtistRecordId(artist);
          if ((artist.image || artist.imageUrl) && artistId) {
            imagesMap[artistId] = artist.image || artist.imageUrl;
          }
        });
        setArtistImages((prev) => ({ ...prev, ...imagesMap }));
      } catch (err) {
        console.warn("Failed to load more recommendations:", err);
      } finally {
        setLoadingMore(false);
      }
      return;
    }

    if (normalizedType === "trending") {
      const next = visibleCount + PAGE_SIZE;
      setVisibleCount((count) =>
        Math.min(count + PAGE_SIZE, fullList?.length ?? count + PAGE_SIZE),
      );
      setHasMore((fullList?.length ?? 0) > next);
      return;
    }

    setLoadingMore(true);
    try {
      const searchQuery = isTagSearch ? trimmedQuery.replace(/^#/, "") : trimmedQuery;
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
          const artistId = getArtistRecordId(artist);
          if ((artist.image || artist.imageUrl) && artistId) {
            setArtistImages((prev) => ({
              ...prev,
              [artistId]: artist.image || artist.imageUrl,
            }));
          }
        });
      }
      setHasMore(data?.hasMore ?? (data?.count ?? 0) > results.length + newItems.length);
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
      const shouldTriggerSearch = shouldTriggerAlbumSearch({
        status: album.status,
        inLibrary: album.inLibrary,
        monitored: album.monitored,
      });
      setPendingAlbumIds((prev) => ({ ...prev, [album.id]: true }));
      try {
        const result = await requestAlbumFromSearch({
          albumMbid: album.id,
          albumName: album.title,
          artistMbid: album.artistMbid,
          artistName: album.artistName,
          triggerSearch: shouldTriggerSearch,
        });
        const nextAlbum = result?.queued
          ? { inLibrary: true, status: "processing" }
          : {
              inLibrary: true,
              libraryAlbumId: result.album?.id,
              libraryArtistId: result.artist?.id,
              status: result.status,
            };
        setResults((prev) =>
          prev.map((item) => (item.id === album.id ? { ...item, ...nextAlbum } : item)),
        );
        setUnifiedResults((prev) => {
          if (!prev?.catalog?.albums) return prev;
          return {
            ...prev,
            catalog: {
              ...prev.catalog,
              albums: prev.catalog.albums.map((item) =>
                item.id === album.id ? { ...item, ...nextAlbum } : item,
              ),
            },
          };
        });
        showSuccess(
          result?.queued
            ? `Adding ${album.title}...`
            : result.triggeredSearch
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
        setPendingAlbumIds(({ [album.id]: _, ...prev }) => prev);
      }
    },
    [showError, showSuccess],
  );

  const handleSearchTrackAdd = useCallback(
    async (track, target) => {
      const payload = {
        artistName: track.artistName || "",
        trackName: track.title || "",
        albumName: track.albumTitle || "",
        artistMbid: track.artistMbid || "",
        albumMbid: track.albumMbid || "",
        trackMbid: track.id || track.trackMbid || "",
        releaseYear: track.releaseYear || null,
        durationMs:
          track.durationMs != null && Number.isFinite(Number(track.durationMs))
            ? Number(track.durationMs)
            : null,
        reason: null,
        artistAliases: [],
      };
      if (!payload.artistName || !payload.trackName) {
        showError("Track details are incomplete");
        return;
      }
      const savingKey = String(track.id ?? track.trackMbid ?? "");
      setPlaylistModalError("");
      setPlaylistMenuSavingKey(savingKey);
      try {
        if (target?.mode === "new") {
          const name = String(target?.name || "").trim() || "Playlist";
          const response = await createSharedPlaylist({
            name,
            tracks: [payload],
          });
          showSuccess(`Track saved to ${response?.playlist?.name || name}`);
        } else {
          const targetPlaylist = sharedPlaylists.find(
            (playlist) => playlist.id === target?.playlistId,
          );
          await addSharedPlaylistTracks(target.playlistId, {
            tracks: [payload],
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
    },
    [loadSharedPlaylists, setPlaylistModalError, setSharedPlaylists, sharedPlaylists, showError, showSuccess],
  );

  const handleArtistAction = useCallback(
    async (artist) => {
      const artistId = getArtistRecordId(artist);
      if (!artist?.name || !artistId) return false;
      setPendingArtistIds((prev) => ({ ...prev, [artistId]: true }));
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
      } finally {
        setPendingArtistIds(({ [artistId]: _, ...prev }) => prev);
      }
    },
    [showError, showSuccess],
  );

  const handleArtistFeedback = useCallback(
    (artist, action, options = {}) => submitFeedback(artist, action, options),
    [submitFeedback],
  );

  const isSearchResultInLibrary = useCallback(
    (item) => {
      if (!item) return false;
      if (item.type === "album") {
        return isAlbumCompleteInLibrary({ status: item.status });
      }
      if (item.inLibrary) return true;
      if (item.type === "artist") {
        const artistId = getArtistRecordId(item);
        return artistId ? !!libraryLookup[artistId] : false;
      }
      return false;
    },
    [libraryLookup],
  );

  const renderSearchResultAction = useCallback(
    (item) => {
      if (!item || item.type === "playlist") return null;

      if (item.type === "track") {
        const savingKey = String(
          item.id ?? item.trackMbid ?? `${item.artistName || ""}:${item.title || ""}`,
        );
        return (
          <TrackPlaylistMenu
            track={item}
            triggerLabel="Add to playlist"
            playlists={sharedPlaylists}
            loading={playlistModalLoading}
            saving={playlistMenuSavingKey === savingKey}
            error={playlistModalError}
            defaultNewPlaylistName={`${item.artistName || "Artist"} Picks`}
            menuVariant="search-suggestion"
            onLoadPlaylists={loadSharedPlaylists}
            onSelect={(target) => handleSearchTrackAdd(item, target)}
          />
        );
      }

      if (isSearchResultInLibrary(item)) {
        return <SearchLibraryCheck action />;
      }

      if (item.type === "artist") {
        const artistId = getArtistRecordId(item);
        if (!canAddArtist || !artistId) return null;
        return (
          <AddActionButton
            disabled={!!pendingArtistIds[artistId]}
            isLoading={!!pendingArtistIds[artistId]}
            label="Add to Lidarr"
            onClick={(event) => {
              event.stopPropagation();
              handleArtistAction(item);
            }}
          />
        );
      }

      if (item.type === "album") {
        if (!canAddAlbum || !item.id) return null;
        const pending = !!pendingAlbumIds[item.id];
        return (
          <AddActionButton
            onClick={(event) => {
              event.stopPropagation();
              handleAlbumAction(item);
            }}
            isLoading={pending}
            disabled={pending || ALBUM_PENDING_STATUSES.has(item.status)}
            label={getAlbumAddButtonLabel({
              status: item.status,
              inLibrary: item.inLibrary,
              monitored: item.monitored,
            })}
          />
        );
      }

      return null;
    },
    [
      canAddAlbum,
      canAddArtist,
      handleAlbumAction,
      handleArtistAction,
      handleSearchTrackAdd,
      isSearchResultInLibrary,
      loadSharedPlaylists,
      pendingAlbumIds,
      pendingArtistIds,
      playlistMenuSavingKey,
      playlistModalError,
      playlistModalLoading,
      sharedPlaylists,
    ],
  );

  const searchListProps = useMemo(
    () => ({
      navigate,
      query: trimmedQuery,
      artistImages,
      albumCovers,
      renderAction: renderSearchResultAction,
    }),
    [albumCovers, artistImages, navigate, renderSearchResultAction, trimmedQuery],
  );

  const searchLibraryFlags = useMemo(() => {
    const artistIds = new Set(
      Object.entries(libraryLookup)
        .filter(([, inLibrary]) => inLibrary)
        .map(([id]) => id),
    );
    const albumIds = new Set();
    for (const [albumId, entry] of Object.entries(albumLibraryLookup)) {
      if (entry && entry !== false && (entry === true || entry.inLibrary)) {
        albumIds.add(albumId);
      }
    }
    for (const album of unifiedResults?.catalog?.albums || []) {
      if (album?.id && album.inLibrary) {
        albumIds.add(album.id);
      }
    }
    return { artistIds, albumIds };
  }, [albumLibraryLookup, libraryLookup, unifiedResults]);

  const unifiedView = useMemo(() => {
    if (!isUnifiedSearch || !unifiedResults) {
      return {
        artistsWithId: [],
        albumsWithId: [],
        tracks: [],
        libraryTracks: [],
        topResult: null,
        mixedItems: [],
        isEmpty: true,
      };
    }

    const artistsWithId = buildSearchArtistResults(unifiedResults, searchLibraryFlags);

    const albums = unifiedResults.catalog?.albums || [];
    const albumsWithId = dedupeAlbums(albums.filter((album) => album?.id));

    const showArtists = activeFilter === "all" || activeFilter === "artists";
    const showAlbums = activeFilter === "all" || activeFilter === "albums";
    const showSingles = activeFilter === "all" || activeFilter === "singles";

    const visibleArtistsWithId = showArtists ? artistsWithId : [];
    const visibleAlbumsWithId = showAlbums
      ? albumsWithId.filter((album) => !isAlbumSingleOrEp(album))
      : [];
    const visibleSinglesWithId = showSingles
      ? albumsWithId.filter(isAlbumSingleOrEp)
      : [];

    const topResult =
      activeFilter === "all" ? resolveSearchTopResult(unifiedResults, searchLibraryFlags) : null;
    const mixedItems =
      activeFilter === "all"
        ? buildMixedSearchPageItems(unifiedResults, {
            limit: 24,
            excludeItem: topResult,
            libraryFlags: searchLibraryFlags,
          })
        : [];

    const isEmpty =
      activeFilter === "all"
        ? !topResult && mixedItems.length === 0
        : visibleArtistsWithId.length === 0 &&
          visibleAlbumsWithId.length === 0 &&
          visibleSinglesWithId.length === 0;

    return {
      artistsWithId: visibleArtistsWithId,
      albumsWithId: visibleAlbumsWithId,
      singlesWithId: visibleSinglesWithId,
      topResult,
      mixedItems,
      isEmpty,
    };
  }, [activeFilter, isUnifiedSearch, searchLibraryFlags, unifiedResults]);

  const albumResultsForTab = useMemo(() => {
    if (!isAlbumSearch) return results;
    return results.filter((album) => matchesAlbumReleaseTab(album, albumReleaseTab));
  }, [albumReleaseTab, isAlbumSearch, results]);

  const recommendedArtists = useMemo(() => {
    if (normalizedType !== "recommended") return [];
    const normalizedSearch = recommendedSearchTerm.trim().toLowerCase();
    const filtered = normalizedSearch
      ? results.filter((artist) => getRecommendedArtistName(artist).toLowerCase().includes(normalizedSearch))
      : results;
    return sortRecommendedArtists(filtered, recommendedSortKey, recommendedSortDirection);
  }, [normalizedType, recommendedSearchTerm, recommendedSortDirection, recommendedSortKey, results]);

  const displayedResults =
    normalizedType === "recommended"
      ? recommendedArtists
      : normalizedType === "trending"
        ? results.slice(0, visibleCount)
        : isAlbumSearch
          ? albumResultsForTab
          : results;

  const showContent =
    !loading && (query || normalizedType === "recommended" || normalizedType === "trending");
  const isEmpty = isUnifiedSearch ? unifiedView.isEmpty : displayedResults.length === 0;
  const showLoadMore =
    hasMore &&
    (normalizedType === "recommended"
      ? true
      : normalizedType === "trending"
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
    if (!recommendedSortMenuOpen) return undefined;
    const handlePointerDown = (event) => {
      if (recommendedToolbarRef.current?.contains(event.target)) return;
      setRecommendedSortMenuOpen(false);
    };
    const handleKeyDown = (event) => {
      if (event.key === "Escape") setRecommendedSortMenuOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [recommendedSortMenuOpen]);

  useEffect(() => {
    const element = sentinelRef.current;
    if (!element || !showContent || isEmpty || !showLoadMore) return;
    const observer = new IntersectionObserver(onSentinel, {
      rootMargin: "200px",
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [isEmpty, onSentinel, showContent, showLoadMore]);

  const localSearchConfigured = unifiedResults?.localSearchConfigured !== false;

  const emptyMessage =
    normalizedType === "recommended" && lastfmConfigured === false
      ? "Connect a Last.fm API key in Settings → Connect to populate recommendations."
      : normalizedType === "recommended" || normalizedType === "trending"
        ? "Nothing to show here yet."
        : isUnifiedSearch && !localSearchConfigured
          ? "Configure the search server in Settings to search artists, releases, and tracks."
          : isUnifiedSearch
            ? `We couldn't find anything matching "${trimmedQuery}"`
            : isAlbumSearch
              ? `We couldn't find any albums matching "${trimmedQuery}"`
              : isTagSearch
                ? `We couldn't find any artists for tag "${trimmedQuery.replace(/^#/, "")}"`
                : `We couldn't find any artists matching "${trimmedQuery}"`;

  const emptyTitle =
    normalizedType === "recommended" && lastfmConfigured === false
      ? "Connect Last.fm"
      : "No Results Found";

  const recommendedCount = recommendedSearchTerm.trim()
    ? recommendedArtists.length
    : searchTotalCount || results.length;
  const pageSubtitle =
    normalizedType === "recommended"
      ? `${recommendedCount} artist${recommendedCount !== 1 ? "s" : ""} we think you'll like`
      : normalizedType === "trending"
        ? "Trending artists right now"
        : isUnifiedSearch && trimmedQuery
          ? "Artists, releases, and songs"
          : isTagSearch && trimmedQuery
            ? `Artists for tag "${trimmedQuery.replace(/^#/, "")}"`
            : isAlbumSearch && trimmedQuery
              ? null
              : trimmedQuery
                ? `${displayedResults.length} artist${displayedResults.length !== 1 ? "s" : ""}`
                : null;
  const selectedRecommendedSort =
    RECOMMENDED_SORT_OPTIONS.find((option) => option.value === recommendedSortKey) ||
    RECOMMENDED_SORT_OPTIONS[0];
  const RecommendedSortDirectionIcon = recommendedSortDirection === "asc" ? ArrowUp : ArrowDown;

  return (
    <div className="search-page">
      <header className="search-page__header">
        {showTagBanner && (
          <div className="search-banner">
            <p className="search-banner__copy">
              Tag results are limited to the hydrated discovery cache. Add a free Last.fm API key in
              Settings for broader top-artist matches.
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
                title="Dismiss Last.fm reminder"
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
            {pageSubtitle && <p className="search-page__subtitle">{pageSubtitle}</p>}
            {isTagSearch && lastfmConfigured !== false && (
              <span className="search-page__tag-legend">
                <span className="search-page__tag-legend-ring" aria-hidden="true">
                  <span className="search-page__tag-legend-ring-core" />
                </span>
                <span>recommended</span>
              </span>
            )}
          </div>
        )}

        {normalizedType === "recommended" && (
          <div ref={recommendedToolbarRef} className="library-page__toolbar global-search">
            <div className="global-search__box">
              <div className="global-search__scope-wrap">
                <button
                  type="button"
                  onClick={() => setRecommendedSortMenuOpen((open) => !open)}
                  className={`global-search__scope-button library-page__sort-button${recommendedSortMenuOpen ? " is-open" : ""}`}
                  aria-haspopup="listbox"
                  aria-expanded={recommendedSortMenuOpen}
                  aria-controls="recommended-sort-menu"
                  aria-label="Sort recommendations"
                >
                  <span className="library-page__sort-label">{selectedRecommendedSort.label}</span>
                  <RecommendedSortDirectionIcon className="artist-icon-xs library-page__sort-direction" />
                  <ChevronDown
                    className={`artist-icon-sm${recommendedSortMenuOpen ? " artist-chevron--open" : ""}`}
                  />
                </button>

                {recommendedSortMenuOpen && (
                  <div
                    id="recommended-sort-menu"
                    className="artist-options-menu library-page__sort-menu"
                    role="listbox"
                    aria-label="Recommendation sort options"
                  >
                    {RECOMMENDED_SORT_OPTIONS.map((option) => {
                      const active = recommendedSortKey === option.value;
                      return (
                        <button
                          key={option.value}
                          type="button"
                          onClick={() => handleRecommendedSortOptionClick(option)}
                          className={`artist-menu-item${active ? " is-active" : ""}`}
                          role="option"
                          aria-selected={active}
                        >
                          <span>{option.label}</span>
                          <span>
                            {active && <RecommendedSortDirectionIcon className="artist-icon-xs" />}
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
                  value={recommendedSearchTerm}
                  onChange={(event) => setRecommendedSearchTerm(event.target.value)}
                  placeholder=""
                  className="global-search__input"
                  autoComplete="off"
                  aria-label="Search recommendations"
                />
                {!recommendedSearchTerm && (
                  <div className="global-search__placeholder">Search recommendations...</div>
                )}
              </div>
            </div>

            <div className="library-page__view-controls">
              {recommendedViewMode === "grid" && (
                <input
                  type="range"
                  min="2"
                  max="10"
                  value={recommendedGridColumns}
                  onChange={(event) => {
                    const value = parseInt(event.target.value, 10);
                    setRecommendedGridColumns(value);
                    localStorage.setItem("libraryGridColumns", String(value));
                  }}
                  className="library-page__grid-slider"
                  aria-label="Grid columns"
                  title={`${recommendedGridColumns} columns`}
                />
              )}
              <button
                type="button"
                onClick={() => {
                  const next = recommendedViewMode === "grid" ? "list" : "grid";
                  setRecommendedViewMode(next);
                  localStorage.setItem("libraryViewMode", next);
                }}
                className="btn btn-icon-square library-page__view-toggle"
                aria-label={
                  recommendedViewMode === "grid" ? "Switch to list view" : "Switch to grid view"
                }
                title={recommendedViewMode === "grid" ? "List view" : "Grid view"}
              >
                {recommendedViewMode === "grid" ? (
                  <List className="artist-icon-sm" />
                ) : (
                  <LayoutGrid className="artist-icon-sm" />
                )}
              </button>
            </div>
          </div>
        )}

        {isUnifiedSearch && trimmedQuery && (
          <div className="search-page__filters">
            {UNIFIED_FILTER_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => updateUnifiedFilter(option.value)}
                className={`search-page__filter${
                  activeFilter === option.value ? " is-active" : ""
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        )}

        {isAlbumSearch && trimmedQuery && (
          <>
            <p className="search-page__subtitle">
              Search results include compilations, soundtracks, and releases from Various Artists.
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
                        onClick={() => {
                          setAlbumViewMode("grid");
                          writeReleaseListViewMode("grid");
                        }}
                        className={`btn btn-icon-square btn-surface${albumViewMode === "grid" ? " is-active" : ""}`}
                        aria-label="Grid view"
                        title="Grid view"
                        aria-pressed={albumViewMode === "grid"}
                      >
                        <Grid3X3 className="artist-icon-sm" />
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setAlbumViewMode("list");
                          writeReleaseListViewMode("list");
                        }}
                        className={`btn btn-icon-square btn-surface${albumViewMode === "list" ? " is-active" : ""}`}
                        aria-label="List view"
                        title="List view"
                        aria-pressed={albumViewMode === "list"}
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
              <h2 className="search-empty-panel__title">{emptyTitle}</h2>
              <p className="search-empty-panel__message">{emptyMessage}</p>
              {normalizedType === "recommended" && lastfmConfigured === false ? (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => navigate("/settings/connect")}
                >
                  Open Last.fm settings
                </button>
              ) : null}
            </div>
          ) : (
            <>
              {isUnifiedSearch ? (
                <div className="search-page__unified">
                  {activeFilter === "all" && (
                    <>
                      {unifiedView.topResult && (
                        <SearchTopResultCard
                          item={unifiedView.topResult}
                          artistImages={artistImages}
                          albumCovers={albumCovers}
                          libraryLookup={libraryLookup}
                          navigate={navigate}
                          query={trimmedQuery}
                        />
                      )}
                      {unifiedView.mixedItems.length > 0 && (
                        <SearchMixedResultList
                          items={unifiedView.mixedItems}
                          {...searchListProps}
                        />
                      )}
                    </>
                  )}

                  {activeFilter === "singles" && unifiedView.singlesWithId.length > 0 && (
                    <SearchAlbumResults
                      albums={unifiedView.singlesWithId}
                      albumCovers={albumCovers}
                      canAddAlbum={canAddAlbum}
                      pendingAlbumIds={pendingAlbumIds}
                      onAlbumAction={handleAlbumAction}
                      navigate={navigate}
                      viewMode="grid"
                    />
                  )}

                  {activeFilter === "artists" && unifiedView.artistsWithId.length > 0 && (
                    <SearchArtistResults
                      artists={unifiedView.artistsWithId}
                      type="artist"
                      artistImages={artistImages}
                      libraryLookup={libraryLookup}
                      navigate={navigate}
                      canAddArtist={canAddArtist}
                      onAddArtistToLibrary={handleArtistAction}
                      onArtistFeedback={handleArtistFeedback}
                      artistFeedbackLookup={artistFeedbackLookup}
                      variant="round"
                    />
                  )}

                  {activeFilter === "albums" && unifiedView.albumsWithId.length > 0 && (
                    <SearchAlbumResults
                      albums={unifiedView.albumsWithId}
                      albumCovers={albumCovers}
                      canAddAlbum={canAddAlbum}
                      pendingAlbumIds={pendingAlbumIds}
                      onAlbumAction={handleAlbumAction}
                      navigate={navigate}
                      viewMode="grid"
                    />
                  )}
                </div>
              ) : isAlbumSearch ? (
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
                  onAddArtistToLibrary={handleArtistAction}
                  onArtistFeedback={handleArtistFeedback}
                  artistFeedbackLookup={artistFeedbackLookup}
                  variant={normalizedType === "recommended" ? recommendedViewMode : "square"}
                  gridColumns={
                    normalizedType === "recommended" && recommendedViewMode === "grid"
                      ? recommendedGridColumns
                      : undefined
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

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { Clock, Loader2, Search } from "lucide-react";
import AddAlbumButton from "./AddAlbumButton";
import AddToLibraryButton from "./AddToLibraryButton";
import SearchLibraryCheck from "./SearchLibraryCheck";
import { TrackPlaylistMenu } from "../pages/ArtistDetails/components/TrackPlaylistMenu";
import { useAuth } from "../contexts/AuthContext";
import { useToast } from "../contexts/ToastContext";
import {
  addArtistToLibrary,
  addSharedPlaylistTracks,
  createSharedPlaylist,
  getBootstrapStatus,
  getFlowStatus,
  getTagSuggestions,
  requestAlbumFromSearch,
  searchUnified,
} from "../utils/api";
import { getArtistRecordId } from "../utils/artistTaste";
import {
  buildMixedSuggestionItems,
  getSearchResultKey,
  navigateFromSearchResult,
} from "../utils/searchNavigation";
import {
  addRecentSearch,
  clearRecentSearches,
  readRecentSearches,
} from "../utils/recentSearches";

const AUTOCOMPLETE_DEBOUNCE_MS = 250;
const SUGGEST_LIMIT = 5;
const TAG_SUGGESTIONS_LIMIT = 8;
const ALBUM_PENDING_STATUSES = new Set([
  "searching",
  "downloading",
  "processing",
]);

function isEditableTarget(target) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tagName = target.tagName.toLowerCase();
  return ["input", "textarea", "select"].includes(tagName);
}

function getSuggestionTitle(item) {
  if (item?.type === "artist") return item.name || "";
  if (item?.type === "album") return item.title || "";
  if (item?.type === "track") return item.title || "";
  if (item?.type === "playlist") return item.name || "";
  return "";
}

function getSuggestionMeta(item) {
  if (item?.type === "artist") return "Artist";
  if (item?.type === "album") {
    return item.artistName ? `Album · ${item.artistName}` : "Album";
  }
  if (item?.type === "track") {
    return item.artistName ? `Song · ${item.artistName}` : "Song";
  }
  if (item?.type === "playlist") {
    return item.trackCount != null
      ? `Playlist · ${item.trackCount} track${item.trackCount === 1 ? "" : "s"}`
      : "Playlist";
  }
  return null;
}

function getSuggestionItemId(item) {
  if (!item) return "";
  if (item.type === "artist") return getArtistRecordId(item) || "";
  if (item.type === "track") return item.id || item.trackMbid || "";
  return item.id || "";
}

function getTrackSavingKey(track) {
  return String(
    track?.id ||
      track?.trackMbid ||
      `${track?.artistName || ""}:${track?.title || ""}`,
  );
}

function isSuggestionInLibrary(item) {
  if (!item) return false;
  if (item.inLibrary) return true;
  return item.type === "album" && ["available", "inLibrary"].includes(item.status);
}

function buildTrackPlaylistPayload(track) {
  const payload = {
    artistName: track?.artistName || "",
    trackName: track?.title || "",
    albumName: track?.albumTitle || "",
    artistMbid: track?.artistMbid || "",
    albumMbid: track?.albumMbid || "",
    trackMbid: track?.id || track?.trackMbid || "",
    releaseYear: track?.releaseYear || null,
    durationMs:
      track?.durationMs != null && Number.isFinite(Number(track.durationMs))
        ? Number(track.durationMs)
        : null,
    reason: null,
    artistAliases: [],
  };
  if (!payload.artistName || !payload.trackName) return null;
  return payload;
}

function GlobalSearch() {
  const [searchQuery, setSearchQuery] = useState("");
  const [lastfmConfigured, setLastfmConfigured] = useState(true);
  const [localSearchConfigured, setLocalSearchConfigured] = useState(true);
  const [suggestionRows, setSuggestionRows] = useState([]);
  const [suggestionMode, setSuggestionMode] = useState(null);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const [suggestionIndex, setSuggestionIndex] = useState(-1);
  const [inputFocused, setInputFocused] = useState(false);
  const [recentSearches, setRecentSearches] = useState(() => readRecentSearches());
  const searchContainerRef = useRef(null);
  const inputRef = useRef(null);
  const debounceRef = useRef(null);
  const searchGenerationRef = useRef(0);
  const navigate = useNavigate();
  const location = useLocation();
  const { hasPermission } = useAuth();
  const { showSuccess, showError } = useToast();
  const canAddArtist = hasPermission("addArtist");
  const canAddAlbum = hasPermission("addAlbum");
  const [pendingArtistIds, setPendingArtistIds] = useState({});
  const [pendingAlbumIds, setPendingAlbumIds] = useState({});
  const [sharedPlaylists, setSharedPlaylists] = useState([]);
  const [playlistModalLoading, setPlaylistModalLoading] = useState(false);
  const [playlistModalError, setPlaylistModalError] = useState("");
  const [playlistMenuSavingKey, setPlaylistMenuSavingKey] = useState("");

  const selectableRows = useMemo(() => {
    if (suggestionMode === "tag") return suggestionRows;
    return suggestionRows.filter((row) => row.kind === "item");
  }, [suggestionRows, suggestionMode]);

  const showRecentSearches = useMemo(
    () =>
      inputFocused &&
      searchQuery.trim().length < 2 &&
      recentSearches.length > 0 &&
      !loadingSuggestions &&
      suggestionRows.length === 0,
    [
      inputFocused,
      loadingSuggestions,
      recentSearches.length,
      searchQuery,
      suggestionRows.length,
    ],
  );

  const recentSelectableRows = useMemo(
    () =>
      showRecentSearches
        ? recentSearches.map((query, index) => ({
            kind: "recent",
            key: `recent:${query}:${index}`,
            query,
          }))
        : [],
    [recentSearches, showRecentSearches],
  );

  const keyboardRows = showRecentSearches ? recentSelectableRows : selectableRows;

  const rememberSearch = useCallback((rawQuery) => {
    const next = addRecentSearch(rawQuery);
    setRecentSearches(next);
  }, []);

  const closeAutocomplete = useCallback(() => {
    setSuggestionRows([]);
    setSuggestionMode(null);
    setSuggestionIndex(-1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const loadBootstrapStatus = async () => {
      try {
        const bootstrap = await getBootstrapStatus();
        if (!cancelled) {
          setLastfmConfigured(!!bootstrap.lastfmConfigured);
        }
      } catch {
        if (!cancelled) {
          setLastfmConfigured(true);
        }
      }
    };
    loadBootstrapStatus();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setSearchQuery("");
    closeAutocomplete();
  }, [location.pathname, location.search, closeAutocomplete]);

  useEffect(() => {
    const handleGlobalKeyDown = (event) => {
      if (
        event.key !== "/" ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey
      ) {
        return;
      }
      if (isEditableTarget(event.target)) return;
      event.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    };

    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, []);

  useEffect(() => {
    const trimmed = searchQuery.trim();
    const isTagShortcut = lastfmConfigured && trimmed.startsWith("#");
    const tagPart = isTagShortcut ? trimmed.slice(1).trim() : trimmed;

    if (isTagShortcut) {
      if (tagPart.length < 2) {
        if (debounceRef.current) {
          clearTimeout(debounceRef.current);
          debounceRef.current = null;
        }
        searchGenerationRef.current += 1;
        setLoadingSuggestions(false);
        closeAutocomplete();
        return;
      }

      if (debounceRef.current) clearTimeout(debounceRef.current);
      const generation = searchGenerationRef.current + 1;
      searchGenerationRef.current = generation;
      debounceRef.current = setTimeout(async () => {
        debounceRef.current = null;
        setLoadingSuggestions(true);
        try {
          const data = await getTagSuggestions(tagPart, TAG_SUGGESTIONS_LIMIT);
          if (generation !== searchGenerationRef.current) return;
          const raw = data.tags || [];
          const seen = new Set();
          const tags = raw.filter((tag) => {
            const key = String(tag || "")
              .trim()
              .toLowerCase();
            if (!key || seen.has(key)) return false;
            seen.add(key);
            return true;
          });
          setSuggestionRows(
            tags.map((tagName) => ({
              kind: "tag",
              key: `tag:${tagName}`,
              tagName,
            })),
          );
          setSuggestionMode("tag");
          setSuggestionIndex(-1);
        } catch {
          if (generation === searchGenerationRef.current) {
            closeAutocomplete();
          }
        } finally {
          if (generation === searchGenerationRef.current) {
            setLoadingSuggestions(false);
          }
        }
      }, AUTOCOMPLETE_DEBOUNCE_MS);

      return () => {
        if (debounceRef.current) clearTimeout(debounceRef.current);
        searchGenerationRef.current += 1;
      };
    }

    if (trimmed.length < 2) {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      searchGenerationRef.current += 1;
      setLoadingSuggestions(false);
      closeAutocomplete();
      return;
    }

    if (debounceRef.current) clearTimeout(debounceRef.current);
    const generation = searchGenerationRef.current + 1;
    searchGenerationRef.current = generation;
    debounceRef.current = setTimeout(async () => {
      debounceRef.current = null;
      setLoadingSuggestions(true);
      try {
        const data = await searchUnified(trimmed, {
          mode: "suggest",
          limit: SUGGEST_LIMIT,
        });
        if (generation !== searchGenerationRef.current) return;
        setLocalSearchConfigured(!!data?.localSearchConfigured);
        const items = buildMixedSuggestionItems(data, SUGGEST_LIMIT + 3);
        setSuggestionRows(
          items.map((item, index) => ({
            kind: "item",
            key: getSearchResultKey(item, index),
            item,
          })),
        );
        setSuggestionMode("unified");
        setSuggestionIndex(-1);
      } catch {
        if (generation === searchGenerationRef.current) {
          closeAutocomplete();
        }
      } finally {
        if (generation === searchGenerationRef.current) {
          setLoadingSuggestions(false);
        }
      }
    }, AUTOCOMPLETE_DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      searchGenerationRef.current += 1;
    };
  }, [searchQuery, closeAutocomplete, lastfmConfigured]);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (
        searchContainerRef.current &&
        !searchContainerRef.current.contains(event.target)
      ) {
        closeAutocomplete();
      }
    };
    document.addEventListener("click", handleClickOutside);
    return () => document.removeEventListener("click", handleClickOutside);
  }, [closeAutocomplete]);

  const navigateToSearch = useCallback(
    (rawQuery) => {
      const trimmed = String(rawQuery || "").trim();
      if (!trimmed) return;
      rememberSearch(trimmed);
      if (trimmed.startsWith("#")) {
        navigate(`/search?q=${encodeURIComponent(trimmed.slice(1))}&type=tag`);
      } else {
        navigate(`/search?q=${encodeURIComponent(trimmed)}`);
      }
      setSearchQuery("");
      closeAutocomplete();
      setInputFocused(false);
    },
    [navigate, closeAutocomplete, rememberSearch],
  );

  const handleSubmit = (event) => {
    event.preventDefault();
    navigateToSearch(searchQuery);
  };

  const handleSuggestionSelect = useCallback(
    (selection) => {
      if (!selection) return;

      if (selection.kind === "recent") {
        navigateToSearch(selection.query);
        return;
      }

      if (selection.kind === "tag") {
        rememberSearch(`#${selection.tagName}`);
        navigate(
          `/search?q=${encodeURIComponent(selection.tagName)}&type=tag`,
        );
        setSearchQuery("");
        closeAutocomplete();
        setInputFocused(false);
        return;
      }

      if (selection.kind === "item") {
        const query = searchQuery.trim();
        if (query) rememberSearch(query);
        navigateFromSearchResult(navigate, selection.item, { query });
        setSearchQuery("");
        closeAutocomplete();
        setInputFocused(false);
      }
    },
    [navigate, navigateToSearch, rememberSearch, searchQuery, closeAutocomplete],
  );

  const handleClearRecentSearches = useCallback((event) => {
    event.preventDefault();
    event.stopPropagation();
    setRecentSearches(clearRecentSearches());
    setSuggestionIndex(-1);
  }, []);

  const updateSuggestionItem = useCallback((targetItem, updates) => {
    if (!targetItem) return;
    const targetType = targetItem.type;
    const targetId = getSuggestionItemId(targetItem);
    setSuggestionRows((rows) =>
      rows.map((row) => {
        if (row.kind !== "item" || row.item?.type !== targetType) return row;
        const currentId = getSuggestionItemId(row.item);
        if (!targetId || currentId !== targetId) return row;
        const patch =
          typeof updates === "function" ? updates(row.item) : updates || {};
        return {
          ...row,
          item: {
            ...row.item,
            ...patch,
          },
        };
      }),
    );
  }, []);

  const loadSharedPlaylists = useCallback(async () => {
    setPlaylistModalLoading(true);
    setPlaylistModalError("");
    try {
      const data = await getFlowStatus();
      const playlists = Array.isArray(data?.sharedPlaylists)
        ? data.sharedPlaylists
        : [];
      setSharedPlaylists(playlists);
      return playlists;
    } catch (err) {
      const message =
        err.response?.data?.message ||
        err.response?.data?.error ||
        err.message ||
        "Failed to load playlists";
      setPlaylistModalError(message);
      showError(message);
      return null;
    } finally {
      setPlaylistModalLoading(false);
    }
  }, [showError]);

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
        updateSuggestionItem(artist, { inLibrary: true });
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
        setPendingArtistIds((prev) => {
          const next = { ...prev };
          delete next[artistId];
          return next;
        });
      }
    },
    [showError, showSuccess, updateSuggestionItem],
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
        const nextAlbum = {
          inLibrary: true,
          libraryAlbumId: result.album?.id,
          libraryArtistId: result.artist?.id,
          status: result.status,
        };
        updateSuggestionItem(album, nextAlbum);
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
    [showError, showSuccess, updateSuggestionItem],
  );

  const handleSearchTrackAdd = useCallback(
    async (track, target) => {
      const payload = buildTrackPlaylistPayload(track);
      if (!payload) {
        showError("Track details are incomplete");
        return;
      }

      const savingKey = getTrackSavingKey(track);
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
    [loadSharedPlaylists, sharedPlaylists, showError, showSuccess],
  );

  const renderSuggestionAction = useCallback(
    (item) => {
      if (!item) return null;
      if (isSuggestionInLibrary(item) && item.type !== "track") {
        return <SearchLibraryCheck />;
      }

      if (item.type === "artist") {
        const artistId = getArtistRecordId(item);
        if (!canAddArtist || !artistId) return null;
        return (
          <AddToLibraryButton
            className="btn-add-library--suggestion"
            disabled={!!pendingArtistIds[artistId]}
            isLoading={!!pendingArtistIds[artistId]}
            onClick={() => handleArtistAction(item)}
          />
        );
      }

      if (item.type === "album") {
        if (!canAddAlbum || !item.id) return null;
        const pending = !!pendingAlbumIds[item.id];
        return (
          <AddAlbumButton
            onClick={(event) => {
              event.stopPropagation();
              handleAlbumAction(item);
            }}
            isLoading={pending}
            disabled={pending || ALBUM_PENDING_STATUSES.has(item.status)}
            label="Add to Lidarr"
          />
        );
      }

      if (item.type === "track") {
        const savingKey = getTrackSavingKey(item);
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

      return null;
    },
    [
      canAddAlbum,
      canAddArtist,
      handleAlbumAction,
      handleArtistAction,
      handleSearchTrackAdd,
      loadSharedPlaylists,
      pendingAlbumIds,
      pendingArtistIds,
      playlistMenuSavingKey,
      playlistModalError,
      playlistModalLoading,
      sharedPlaylists,
    ],
  );

  const handleKeyDown = (event) => {
    if (event.key === "Escape") {
      closeAutocomplete();
      return;
    }
    if (keyboardRows.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSuggestionIndex((current) =>
        current < keyboardRows.length - 1 ? current + 1 : current,
      );
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSuggestionIndex((current) => (current > 0 ? current - 1 : -1));
    } else if (event.key === "Enter" && suggestionIndex >= 0) {
      event.preventDefault();
      handleSuggestionSelect(keyboardRows[suggestionIndex]);
    }
  };

  let selectableCursor = -1;

  return (
    <form
      ref={searchContainerRef}
      onSubmit={handleSubmit}
      className="global-search"
    >
      <div className="global-search__box global-search__box--unified">
        <div className="global-search__input-wrap global-search__input-wrap--unified">
          <Search className="global-search__icon" />
          <input
            ref={inputRef}
            type="text"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            onFocus={() => {
              setInputFocused(true);
              setSuggestionIndex(-1);
            }}
            onBlur={() => {
              window.setTimeout(() => setInputFocused(false), 120);
            }}
            onKeyDown={handleKeyDown}
            placeholder=""
            className="global-search__input"
            autoComplete="off"
          />
          {!searchQuery && (
            <div className="global-search__placeholder">
              <span className="global-search__scope-label--short">Search...</span>
              <span className="global-search__scope-label--full">Type</span>
              <span className="global-search__key">/</span>
              <span className="global-search__scope-label--full">to search</span>
            </div>
          )}
          {loadingSuggestions && (
            <div className="global-search__loader">
              <Loader2 className="artist-icon-md animate-spin" />
            </div>
          )}
        </div>
      </div>

      {!loadingSuggestions &&
        suggestionMode === "unified" &&
        !localSearchConfigured &&
        searchQuery.trim().length >= 2 && (
          <div className="global-search__suggestions global-search__suggestions--grouped">
            <div className="global-search__suggestion-group">
              Search not configured
            </div>
            <div className="global-search__suggestion global-search__suggestion--message">
              Configure the search server in Settings to search artists,
              releases, and tracks.
            </div>
          </div>
        )}

      {showRecentSearches && (
        <div className="global-search__suggestions global-search__suggestions--grouped global-search__suggestions--recent">
          <div className="global-search__recent-header">
            <span className="global-search__recent-label">Recent searches</span>
            <button
              type="button"
              className="global-search__recent-clear"
              onMouseDown={(event) => event.preventDefault()}
              onClick={handleClearRecentSearches}
            >
              Clear
            </button>
          </div>
          {recentSelectableRows.map((row, index) => (
            <button
              key={row.key}
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => handleSuggestionSelect(row)}
              className={`global-search__suggestion global-search__suggestion--recent${
                index === suggestionIndex ? " is-highlighted" : ""
              }`}
            >
              <Clock className="global-search__recent-icon" aria-hidden="true" />
              <span className="global-search__recent-query">{row.query}</span>
            </button>
          ))}
        </div>
      )}

      {!loadingSuggestions && suggestionRows.length > 0 && (
        <div className="global-search__suggestions global-search__suggestions--grouped">
          {suggestionMode === "tag"
            ? suggestionRows.map((row, index) => (
                <button
                  key={row.key}
                  type="button"
                  onClick={() => handleSuggestionSelect(row)}
                  className={`global-search__suggestion${
                    index === suggestionIndex ? " is-highlighted" : ""
                  }`}
                >
                  #{row.tagName}
                </button>
              ))
            : suggestionRows.map((row) => {
                selectableCursor += 1;
                const highlighted = selectableCursor === suggestionIndex;
                const item = row.item;
                const label = getSuggestionTitle(item);
                const meta = getSuggestionMeta(item);
                const action = renderSuggestionAction(item);

                return (
                  <div
                    key={row.key}
                    className={`global-search__suggestion global-search__suggestion--rich${
                      highlighted ? " is-highlighted" : ""
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => handleSuggestionSelect(row)}
                      className="global-search__suggestion-main"
                    >
                      <span className="global-search__suggestion-copy">
                        <span className="global-search__suggestion-title">
                          {label}
                        </span>
                        {meta && (
                          <span className="global-search__suggestion-meta">
                            {meta}
                          </span>
                        )}
                      </span>
                    </button>
                    {action && (
                      <span
                        className="global-search__suggestion-actions"
                        onClick={(event) => event.stopPropagation()}
                      >
                        {action}
                      </span>
                    )}
                  </div>
                );
              })}
        </div>
      )}
    </form>
  );
}

export default GlobalSearch;

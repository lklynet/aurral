import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  addArtistToLibrary,
  requestAlbumFromSearch,
} from "../utils/api/endpoints/library.js";
import {
  addSharedPlaylistTracks,
  createSharedPlaylist,
} from "../utils/api/endpoints/playlists.js";
import { getTagSuggestions } from "../utils/api/endpoints/discovery.js";
import { searchUnified } from "../utils/api/endpoints/search.js";
import { getArtistRecordId } from "../utils/artistTaste";
import {
  buildUnifiedSuggestionSections,
  flattenSuggestionSections,
  navigateFromSearchResult,
} from "../utils/searchNavigation";
import {
  addRecentSearch,
  clearRecentSearches,
  readRecentSearches,
} from "../utils/recentSearches";

import {
  AUTOCOMPLETE_DEBOUNCE_MS,
  SUGGEST_LIMIT,
  TAG_SUGGESTIONS_LIMIT,
  ALBUM_PENDING_STATUSES,
  isEditableTarget,
  getSuggestionTitle,
  getSuggestionMeta,
  getSuggestionItemId,
  getTrackSavingKey,
  isSuggestionInLibrary,
  buildTrackPlaylistPayload,
} from "../utils/globalSearchUtils";
import { getAlbumAddButtonLabel, shouldTriggerAlbumSearch } from "../utils/albumAddAction";
import { useDebouncedTask } from "../hooks/useDebouncedTask";
import { useSharedPlaylists } from "../hooks/useSharedPlaylists";
import { useNavigate, useLocation } from "react-router-dom";
import { Clock, Loader2, Search } from "lucide-react";
import AddActionButton from "./AddActionButton";
import SearchLibraryCheck from "./SearchLibraryCheck";
import { TrackPlaylistMenu } from "../pages/ArtistDetails/components/TrackPlaylistMenu";
import { useAuth } from "../contexts/AuthContext";
import { useToast } from "../contexts/ToastContext";
import { SETTINGS_NAV_TABS } from "../pages/Settings/settingsTabsConfig";
function GlobalSearch({ settingsMode = false }) {
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
  const { schedule: scheduleSuggest, cancel: cancelSuggest } = useDebouncedTask();
  const navigate = useNavigate();
  const location = useLocation();
  const { hasPermission, bootstrap } = useAuth();
  const { showSuccess, showError } = useToast();
  const {
    sharedPlaylists,
    setSharedPlaylists,
    playlistsLoading: playlistModalLoading,
    playlistsError: playlistModalError,
    setPlaylistsError: setPlaylistModalError,
    loadSharedPlaylists,
  } = useSharedPlaylists();
  const canAddArtist = hasPermission("addArtist");
  const canAddAlbum = hasPermission("addAlbum");
  const [pendingArtistIds, setPendingArtistIds] = useState({});
  const [pendingAlbumIds, setPendingAlbumIds] = useState({});
  const [playlistMenuSavingKey, setPlaylistMenuSavingKey] = useState("");

  const selectableRows = useMemo(() => {
    if (suggestionMode === "tag") return suggestionRows;
    return suggestionRows.filter((row) => row.kind === "item");
  }, [suggestionRows, suggestionMode]);

  const settingsSearchResults = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!settingsMode || !query) return [];
    return SETTINGS_NAV_TABS.filter((tab) =>
      `${tab.label} ${tab.id}`.toLowerCase().includes(query),
    );
  }, [searchQuery, settingsMode]);

  const showRecentSearches = useMemo(
    () =>
      inputFocused &&
      !settingsMode &&
      searchQuery.trim().length < 2 &&
      recentSearches.length > 0 &&
      !loadingSuggestions &&
      suggestionRows.length === 0,
    [
      inputFocused,
      loadingSuggestions,
      recentSearches.length,
      searchQuery,
      settingsMode,
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

  const keyboardRows = settingsMode
    ? settingsSearchResults
    : showRecentSearches
      ? recentSelectableRows
      : selectableRows;

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
    if (bootstrap) {
      setLastfmConfigured(!!bootstrap.lastfmConfigured);
    }
  }, [bootstrap]);

  useEffect(() => {
    setSearchQuery("");
    closeAutocomplete();
  }, [location.pathname, location.search, closeAutocomplete]);

  useEffect(() => {
    const handleGlobalKeyDown = (event) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
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
    if (settingsMode) {
      cancelSuggest();
      setLoadingSuggestions(false);
      closeAutocomplete();
      return cancelSuggest;
    }
    const isTagShortcut = lastfmConfigured && trimmed.startsWith("#");
    const tagPart = isTagShortcut ? trimmed.slice(1).trim() : trimmed;

    if (isTagShortcut) {
      if (tagPart.length < 2) {
        cancelSuggest();
        setLoadingSuggestions(false);
        closeAutocomplete();
        return;
      }

      scheduleSuggest(async (isCurrent) => {
        setLoadingSuggestions(true);
        try {
          const data = await getTagSuggestions(tagPart, TAG_SUGGESTIONS_LIMIT);
          if (!isCurrent()) return;
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
          if (isCurrent()) {
            closeAutocomplete();
          }
        } finally {
          if (isCurrent()) {
            setLoadingSuggestions(false);
          }
        }
      }, AUTOCOMPLETE_DEBOUNCE_MS);

      return cancelSuggest;
    }

    if (trimmed.length < 2) {
      cancelSuggest();
      setLoadingSuggestions(false);
      closeAutocomplete();
      return;
    }

    scheduleSuggest(async (isCurrent, signal) => {
      setLoadingSuggestions(true);
      try {
        const data = await searchUnified(trimmed, {
          mode: "suggest",
          limit: SUGGEST_LIMIT,
          signal,
        });
        if (!isCurrent()) return;
        setLocalSearchConfigured(!!data?.localSearchConfigured);
        const sections = buildUnifiedSuggestionSections(data);
        setSuggestionRows(flattenSuggestionSections(sections));
        setSuggestionMode("unified");
        setSuggestionIndex(-1);
      } catch {
        if (isCurrent()) {
          closeAutocomplete();
        }
      } finally {
        if (isCurrent()) {
          setLoadingSuggestions(false);
        }
      }
    }, AUTOCOMPLETE_DEBOUNCE_MS);

    return cancelSuggest;
  }, [searchQuery, closeAutocomplete, lastfmConfigured, scheduleSuggest, cancelSuggest, settingsMode]);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (searchContainerRef.current && !searchContainerRef.current.contains(event.target)) {
        closeAutocomplete();
      }
    };
    document.addEventListener("click", handleClickOutside);
    return () => document.removeEventListener("click", handleClickOutside);
  }, [closeAutocomplete]);

  const navigateToSearch = useCallback(
    (rawQuery) => {
      const trimmed = String(rawQuery || "").trim();
      if (!trimmed || settingsMode) return;
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
    [navigate, closeAutocomplete, rememberSearch, settingsMode],
  );

  const navigateToSettings = useCallback(
    (tab) => {
      if (!tab) return;
      navigate(`/settings/${tab.id}`);
      setSearchQuery("");
      closeAutocomplete();
      setInputFocused(false);
    },
    [navigate, closeAutocomplete],
  );

  const handleSubmit = (event) => {
    event.preventDefault();
    if (settingsMode) {
      navigateToSettings(settingsSearchResults[0]);
      return;
    }
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
        navigate(`/search?q=${encodeURIComponent(selection.tagName)}&type=tag`);
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
        const patch = typeof updates === "function" ? updates(row.item) : updates || {};
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
        setPendingArtistIds(({ [artistId]: _, ...prev }) => prev);
      }
    },
    [showError, showSuccess, updateSuggestionItem],
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
        updateSuggestionItem(album, nextAlbum);
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
    [loadSharedPlaylists, setPlaylistModalError, setSharedPlaylists, sharedPlaylists, showError, showSuccess],
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
      setSuggestionIndex((current) => (current < keyboardRows.length - 1 ? current + 1 : current));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSuggestionIndex((current) => (current > 0 ? current - 1 : -1));
    } else if (event.key === "Enter" && suggestionIndex >= 0) {
      event.preventDefault();
      if (settingsMode) {
        navigateToSettings(keyboardRows[suggestionIndex]);
      } else {
        handleSuggestionSelect(keyboardRows[suggestionIndex]);
      }
    }
  };

  let selectableCursor = -1;
  const emptySearchPlaceholder = settingsMode ? (
    <span>Search settings</span>
  ) : inputFocused ? (
    <span className="global-search__scope-label--full">Search music, artists, or #rock</span>
  ) : (
    <>
      <span className="global-search__scope-label--short">Search...</span>
      <span className="global-search__scope-label--full">Type</span>
      <span className="global-search__key">/</span>
      <span className="global-search__scope-label--full">to search</span>
    </>
  );

  return (
    <form ref={searchContainerRef} onSubmit={handleSubmit} className="global-search">
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
            aria-label={settingsMode ? "Search settings" : "Search music, artists, or tags"}
            className="global-search__input"
            autoComplete="off"
          />
          {!searchQuery && (
            <div className="global-search__placeholder">{emptySearchPlaceholder}</div>
          )}
          {loadingSuggestions && (
            <div className="global-search__loader">
              <Loader2 className="artist-icon-md animate-spin" />
            </div>
          )}
        </div>
      </div>

      {!loadingSuggestions && settingsMode && settingsSearchResults.length > 0 && (
        <div className="global-search__suggestions global-search__suggestions--grouped">
          {settingsSearchResults.map((tab, index) => (
            <button
              key={tab.id}
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => navigateToSettings(tab)}
              className={`global-search__suggestion${
                index === suggestionIndex ? " is-highlighted" : ""
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      )}

      {!loadingSuggestions &&
        !settingsMode &&
        suggestionMode === "unified" &&
        !localSearchConfigured &&
        searchQuery.trim().length >= 2 && (
          <div className="global-search__suggestions global-search__suggestions--grouped">
            <div className="global-search__suggestion-group">Search not configured</div>
            <div className="global-search__suggestion global-search__suggestion--message">
              Configure the search server in Settings to search artists, releases, and tracks.
            </div>
          </div>
        )}

      {!settingsMode && showRecentSearches && (
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

      {!loadingSuggestions && !settingsMode && suggestionRows.length > 0 && (
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
                if (row.kind === "header") {
                  return (
                    <div key={row.key} className="global-search__suggestion-group">
                      {row.label}
                    </div>
                  );
                }
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
                        <span className="global-search__suggestion-title">{label}</span>
                        {meta && <span className="global-search__suggestion-meta">{meta}</span>}
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

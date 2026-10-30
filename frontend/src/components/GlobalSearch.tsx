import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  requestAlbumFromSearch,
  settleLibraryOwnerConflict,
} from "../utils/api/endpoints/library.ts";
import { parseResponse } from "hono/client";
import { staticPlaylistsClient } from "../utils/api/clients/staticPlaylists.ts";
import { discoveryClient } from "../utils/api/clients/discovery.ts";
import { searchLibrary, searchUnified } from "../utils/api/endpoints/search.ts";
import {
  buildUnifiedSuggestionSections,
  flattenSuggestionSections,
  navigateFromSearchResult,
} from "../utils/searchNavigation";
import { addRecentSearch, clearRecentSearches, readRecentSearches } from "../utils/recentSearches";

import {
  AUTOCOMPLETE_DEBOUNCE_MS,
  LIBRARY_AUTOCOMPLETE_DEBOUNCE_MS,
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
  type SearchSuggestion,
} from "../utils/globalSearchUtils";
import {
  describeAlbumRequestResult,
  getAlbumAddAction,
  shouldTriggerAlbumSearch,
} from "../utils/albumAddAction";
import { buildAlbumRequestPayload } from "../utils/libraryDestination";
import { useLibraryDestination } from "../hooks/useLibraryDestination";
import { useActiveDownloads } from "../hooks/useActiveDownloads";
import { useDebouncedTask } from "../hooks/useDebouncedTask";
import { useStaticPlaylists } from "../hooks/useStaticPlaylists";
import { useNavigate, useLocation } from "react-router";
import { Clock, Search } from "./icons";
import { DotLoader } from "./DotLoader";
import AddActionButton from "./AddActionButton";
import SearchLibraryCheck from "./SearchLibraryCheck";
import {
  TrackPlaylistMenu,
  type PlaylistSelection,
} from "../pages/ArtistDetails/components/TrackPlaylistMenu";
import { useAuth } from "../contexts/AuthContext";
import { useToast } from "../contexts/ToastContext";
import { getApiErrorMessage, getApiErrorText } from "../pages/onboardingUtils";
import { asApiError } from "../utils/api/core.ts";

type SuggestionMode = "tag" | "unified";
type SuggestionItem = SearchSuggestion & {
  ownerConflict?: NonNullable<Awaited<ReturnType<typeof settleLibraryOwnerConflict>>>;
};
type SuggestionAlbum = Extract<SuggestionItem, { type: "album" }>;
type SuggestionTrack = Extract<SuggestionItem, { type: "track" }>;
type SuggestionRow =
  | { kind: "header"; key: string; label: string }
  | { kind: "item"; key: string; item: SuggestionItem }
  | { kind: "tag"; key: string; tagName: string }
  | { kind: "recent"; key: string; query: string };
type RecentSuggestionRow = Extract<SuggestionRow, { kind: "recent" }>;
type SuggestionResults = {
  library: Awaited<ReturnType<typeof searchLibrary>> | null;
  catalog: Awaited<ReturnType<typeof searchUnified>> | null;
};

const EMPTY_SUGGESTION_RESULTS = { library: null, catalog: null };

function GlobalSearch() {
  const [searchQuery, setSearchQuery] = useState("");
  const [localSearchConfigured, setLocalSearchConfigured] = useState(true);
  const [suggestionRows, setSuggestionRows] = useState<SuggestionRow[]>([]);
  const [suggestionMode, setSuggestionMode] = useState<SuggestionMode | null>(null);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const [suggestionIndex, setSuggestionIndex] = useState(-1);
  const [inputFocused, setInputFocused] = useState(false);
  const [recentSearches, setRecentSearches] = useState(() => readRecentSearches());
  const searchContainerRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const suggestionResultsRef = useRef<SuggestionResults>(EMPTY_SUGGESTION_RESULTS);
  const { schedule: scheduleSuggest, cancel: cancelSuggest } = useDebouncedTask();
  const { schedule: scheduleLibrarySuggest, cancel: cancelLibrarySuggest } = useDebouncedTask();
  const navigate = useNavigate();
  const location = useLocation();
  const { hasPermission } = useAuth();
  const { showSuccess, showError, showInfo } = useToast();
  const libraryDestination = useLibraryDestination();
  const { isAlbumDownloading } = useActiveDownloads();
  const {
    staticPlaylists,
    setStaticPlaylists,
    playlistsLoading: playlistModalLoading,
    playlistsError: playlistModalError,
    setPlaylistsError: setPlaylistModalError,
    loadStaticPlaylists,
  } = useStaticPlaylists();
  const canAddAlbum = hasPermission("addAlbum");
  const [pendingAlbumIds, setPendingAlbumIds] = useState<Record<string, boolean>>({});
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
    [inputFocused, loadingSuggestions, recentSearches.length, searchQuery, suggestionRows.length],
  );

  const recentSelectableRows = useMemo<RecentSuggestionRow[]>(
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

  const suggestionKeyboardRows = showRecentSearches ? recentSelectableRows : selectableRows;

  const rememberSearch = useCallback((rawQuery: string) => {
    const next = addRecentSearch(rawQuery);
    setRecentSearches(next);
  }, []);

  const closeAutocomplete = useCallback(() => {
    suggestionResultsRef.current = EMPTY_SUGGESTION_RESULTS;
    setSuggestionRows([]);
    setSuggestionMode(null);
    setSuggestionIndex(-1);
  }, []);

  const showUnifiedSuggestions = useCallback(
    (results: SuggestionResults, { resetIndex = false } = {}) => {
      suggestionResultsRef.current = results;
      setSuggestionRows(
        flattenSuggestionSections(
          buildUnifiedSuggestionSections<SearchSuggestion>({
            ...results.catalog,
            library: results.library,
          }),
        ),
      );
      setSuggestionMode("unified");
      if (resetIndex) setSuggestionIndex(-1);
    },
    [],
  );

  useEffect(() => {
    setSearchQuery("");
    closeAutocomplete();
  }, [location.pathname, location.search, closeAutocomplete]);

  useEffect(() => {
    const handleGlobalKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
        return;
      }
      if (isEditableTarget(event.target) || document.querySelector("[aria-modal='true']")) return;
      event.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    };

    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, []);

  useEffect(() => {
    const trimmed = searchQuery.trim();
    const cancelAll = () => {
      cancelSuggest();
      cancelLibrarySuggest();
    };
    const isTagShortcut = trimmed.startsWith("#");
    const tagPart = isTagShortcut ? trimmed.slice(1).trim() : trimmed;

    if (isTagShortcut) {
      cancelLibrarySuggest();
      suggestionResultsRef.current = EMPTY_SUGGESTION_RESULTS;
      if (tagPart.length < 2) {
        cancelSuggest();
        setLoadingSuggestions(false);
        closeAutocomplete();
        return;
      }

      scheduleSuggest(async (isCurrent) => {
        setLoadingSuggestions(true);
        try {
          const data = await parseResponse(
            discoveryClient.tags.$get({
              query: { q: tagPart.trim() || undefined, limit: String(TAG_SUGGESTIONS_LIMIT) },
            }),
          );
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
            tags.map((tagName): SuggestionRow => ({
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
      cancelAll();
      setLoadingSuggestions(false);
      closeAutocomplete();
      return;
    }

    scheduleLibrarySuggest(async (isCurrent, signal) => {
      const library = await searchLibrary(trimmed, { limit: SUGGEST_LIMIT, signal }).catch(
        () => null,
      );
      if (!isCurrent()) return;
      showUnifiedSuggestions({ ...suggestionResultsRef.current, library }, { resetIndex: true });
    }, LIBRARY_AUTOCOMPLETE_DEBOUNCE_MS);

    scheduleSuggest(async (isCurrent, signal) => {
      setLoadingSuggestions(true);
      try {
        const catalog = await searchUnified(trimmed, {
          mode: "suggest",
          limit: SUGGEST_LIMIT,
          signal,
        });
        if (!isCurrent()) return;
        setLocalSearchConfigured(!!catalog?.localSearchConfigured);
        showUnifiedSuggestions({ ...suggestionResultsRef.current, catalog });
      } catch {
        if (isCurrent()) {
          showUnifiedSuggestions({ ...suggestionResultsRef.current, catalog: null });
        }
      } finally {
        if (isCurrent()) {
          setLoadingSuggestions(false);
        }
      }
    }, AUTOCOMPLETE_DEBOUNCE_MS);

    return cancelAll;
  }, [
    searchQuery,
    closeAutocomplete,
    scheduleSuggest,
    cancelSuggest,
    scheduleLibrarySuggest,
    cancelLibrarySuggest,
    showUnifiedSuggestions,
  ]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        searchContainerRef.current &&
        !searchContainerRef.current.contains(event.target as Node | null)
      ) {
        closeAutocomplete();
      }
    };
    document.addEventListener("click", handleClickOutside);
    return () => document.removeEventListener("click", handleClickOutside);
  }, [closeAutocomplete]);

  const navigateToSearch = useCallback(
    (rawQuery: string) => {
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

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    navigateToSearch(searchQuery);
  };

  const handleSuggestionSelect = useCallback(
    (selection: SuggestionRow) => {
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

  const handleClearRecentSearches = useCallback((event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setRecentSearches(clearRecentSearches());
    setSuggestionIndex(-1);
  }, []);

  const updateSuggestionItem = useCallback(
    (
      targetItem: SuggestionAlbum,
      updates: Partial<SuggestionAlbum> | ((item: SuggestionAlbum) => Partial<SuggestionAlbum>),
    ) => {
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
    },
    [],
  );

  const handleAlbumAction = useCallback(
    async (album: SuggestionAlbum, managedBy = libraryDestination.primary) => {
      if (!album?.id) return;
      const shouldTriggerSearch = shouldTriggerAlbumSearch({
        status: album.status,
        inLibrary: album.inLibrary,
      });
      setPendingAlbumIds((prev) => ({ ...prev, [album.id!]: true }));
      try {
        const result = await requestAlbumFromSearch(
          buildAlbumRequestPayload({
            albumMbid: album.id,
            albumName: album.title,
            artistMbid: album.artistMbid,
            artistName: album.artistName,
            managedBy,
            triggerSearch: shouldTriggerSearch,
          }),
        );
        const nextAlbum = {
          inLibrary: true,
          managedBy: result?.album?.managedBy || result?.managedBy || managedBy,
          libraryAlbumId: result.album?.id,
          libraryArtistId: result.artist?.id,
          status: result?.queued ? "processing" : result.status,
        };
        updateSuggestionItem(album, nextAlbum);
        const outcome = describeAlbumRequestResult(result, album.title);
        (outcome.kind === "info" ? showInfo : showSuccess)(outcome.message);
      } catch (err) {
        const conflict = settleLibraryOwnerConflict(err);
        if (conflict) {
          updateSuggestionItem(album, { ownerConflict: conflict });
          showInfo(`${album.title}: ${conflict.message}`);
          return;
        }
        showError(
          `Could not download the album: ${
            getApiErrorText(err, "message") ||
            getApiErrorText(err, "error") ||
            asApiError(err)?.message
          }`,
        );
      } finally {
        setPendingAlbumIds(({ [album.id!]: _, ...prev }) => prev);
      }
    },
    [libraryDestination.primary, showError, showInfo, showSuccess, updateSuggestionItem],
  );

  const handleSearchTrackAdd = useCallback(
    async (track: SuggestionTrack, target: PlaylistSelection) => {
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
          await parseResponse(
            staticPlaylistsClient["shared-playlists"].$post({
              json: {
                name,
                tracks: [payload],
              },
            }),
          );
          showSuccess(`Track saved to ${name}`);
        } else {
          const targetPlaylist = staticPlaylists.find(
            (playlist) => playlist.id === target?.playlistId,
          );
          await parseResponse(
            staticPlaylistsClient["shared-playlists"][":playlistId"].tracks.$post({
              param: { playlistId: encodeURIComponent(target.playlistId) },
              json: {
                tracks: [payload],
              },
            }),
          );
          showSuccess(`Track added to ${targetPlaylist?.name || "playlist"}`);
        }

        const nextPlaylists = await loadStaticPlaylists();
        if (nextPlaylists) {
          setStaticPlaylists(nextPlaylists);
        }
      } catch (err) {
        const message = getApiErrorMessage(err, "Failed to save track to playlist");
        setPlaylistModalError(message);
        showError(message);
      } finally {
        setPlaylistMenuSavingKey("");
      }
    },
    [
      loadStaticPlaylists,
      setPlaylistModalError,
      setStaticPlaylists,
      staticPlaylists,
      showError,
      showSuccess,
    ],
  );

  const renderSuggestionAction = useCallback(
    (item: SuggestionItem) => {
      if (!item) return null;
      if (isSuggestionInLibrary(item) && item.type !== "track") {
        return <SearchLibraryCheck />;
      }

      if (item.type === "album") {
        if (!canAddAlbum || !item.id) return null;
        const pending = !!pendingAlbumIds[item.id] || isAlbumDownloading(item.id);
        return (
          <AddActionButton
            {...getAlbumAddAction(item, libraryDestination)}
            ownerConflict={item.ownerConflict}
            onAdd={(managedBy) => handleAlbumAction(item, managedBy)}
            isLoading={pending}
            loadingLabel="Downloading"
            disabled={pending || ALBUM_PENDING_STATUSES.has(item.status)}
          />
        );
      }

      if (item.type === "track") {
        const savingKey = getTrackSavingKey(item);
        return (
          <TrackPlaylistMenu
            track={item}
            triggerLabel="Add to playlist"
            playlists={staticPlaylists}
            loading={playlistModalLoading}
            saving={playlistMenuSavingKey === savingKey}
            error={playlistModalError}
            defaultNewPlaylistName={`${item.artistName || "Artist"} Picks`}
            menuVariant="search-suggestion"
            onLoadPlaylists={loadStaticPlaylists}
            onSelect={(target) => handleSearchTrackAdd(item, target)}
          />
        );
      }

      return null;
    },
    [
      canAddAlbum,
      handleAlbumAction,
      isAlbumDownloading,
      libraryDestination,
      handleSearchTrackAdd,
      loadStaticPlaylists,
      pendingAlbumIds,
      playlistMenuSavingKey,
      playlistModalError,
      playlistModalLoading,
      staticPlaylists,
    ],
  );

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      closeAutocomplete();
      return;
    }
    if (suggestionKeyboardRows.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSuggestionIndex((current) =>
        current < suggestionKeyboardRows.length - 1 ? current + 1 : current,
      );
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSuggestionIndex((current) => (current > 0 ? current - 1 : -1));
    } else if (event.key === "Enter" && suggestionIndex >= 0) {
      event.preventDefault();
      handleSuggestionSelect(suggestionKeyboardRows[suggestionIndex]);
    }
  };

  let selectableCursor = -1;
  const emptySearchPlaceholder = inputFocused ? (
    <span className="global-search__scope-label--full">Search music, artists, or #rock</span>
  ) : (
    <>
      <span className="global-search__scope-label--short">Search</span>
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
            aria-label="Search music, artists, or tags"
            className="global-search__input"
            autoComplete="off"
          />
          {!searchQuery && (
            <div className="global-search__placeholder">{emptySearchPlaceholder}</div>
          )}
          {loadingSuggestions && (
            <div className="global-search__loader">
              <DotLoader size="md" label={null} />
            </div>
          )}
        </div>
      </div>

      {!loadingSuggestions &&
        suggestionMode === "unified" &&
        !localSearchConfigured &&
        searchQuery.trim().length >= 2 && (
          <div className="global-search__suggestions global-search__suggestions--grouped">
            <div className="global-search__suggestion-group">Search not configured</div>
            <div className="global-search__suggestion global-search__suggestion--message">
              Set up the metadata server in Settings → Metadata to search music.
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

      {suggestionRows.length > 0 && (
        <div className="global-search__suggestions global-search__suggestions--grouped">
          {suggestionMode === "tag"
            ? suggestionRows.map((row, index) =>
                row.kind === "tag" ? (
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
                ) : null,
              )
            : suggestionRows.map((row) => {
                if (row.kind === "header") {
                  return (
                    <div key={row.key} className="global-search__suggestion-group">
                      {row.label}
                    </div>
                  );
                }
                if (row.kind !== "item") return null;
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

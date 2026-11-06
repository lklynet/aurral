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
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { librarySearchQuery, unifiedSearchQuery } from "../utils/api/endpoints/search.ts";
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
import { useDebouncedValue } from "../hooks/useDebouncedValue";
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
import { getApiErrorMessage, getApiErrorText } from "../utils/api/errors.ts";
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

function uniqueTags(tags: string[]) {
  const seen = new Set<string>();
  return tags.filter((tag) => {
    const key = String(tag || "")
      .trim()
      .toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function GlobalSearch() {
  const [searchQuery, setSearchQuery] = useState("");
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [highlightedKey, setHighlightedKey] = useState<string | null>(null);
  const [inputFocused, setInputFocused] = useState(false);
  const [recentSearches, setRecentSearches] = useState(() => readRecentSearches());
  const [albumOverrides, setAlbumOverrides] = useState<Record<string, Partial<SuggestionAlbum>>>(
    {},
  );
  const searchContainerRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
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

  const trimmedQuery = searchQuery.trim();
  const tagPart = trimmedQuery.startsWith("#") ? trimmedQuery.slice(1).trim() : null;
  const suggestionMode: SuggestionMode | null = !suggestionsOpen
    ? null
    : tagPart !== null
      ? tagPart.length >= 2
        ? "tag"
        : null
      : trimmedQuery.length >= 2
        ? "unified"
        : null;
  const searchText = suggestionMode === "unified" ? trimmedQuery : "";
  const tagText = suggestionMode === "tag" && tagPart ? tagPart : "";
  const libraryText = useDebouncedValue(searchText, LIBRARY_AUTOCOMPLETE_DEBOUNCE_MS);
  const catalogText = useDebouncedValue(searchText, AUTOCOMPLETE_DEBOUNCE_MS);
  const debouncedTag = useDebouncedValue(tagText, AUTOCOMPLETE_DEBOUNCE_MS);
  const libraryResults = useQuery({
    ...librarySearchQuery(libraryText, SUGGEST_LIMIT),
    enabled: Boolean(searchText && libraryText),
    placeholderData: keepPreviousData,
  });
  const catalogResults = useQuery({
    ...unifiedSearchQuery(catalogText, SUGGEST_LIMIT),
    enabled: Boolean(searchText && catalogText),
    placeholderData: keepPreviousData,
  });
  const tagResults = useQuery({
    queryKey: ["search", "tags", debouncedTag, TAG_SUGGESTIONS_LIMIT],
    queryFn: ({ signal }) =>
      parseResponse(
        discoveryClient.tags.$get(
          { query: { q: debouncedTag, limit: String(TAG_SUGGESTIONS_LIMIT) } },
          { init: { signal } },
        ),
      ),
    enabled: Boolean(tagText && debouncedTag),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
  const loadingSuggestions =
    (suggestionMode === "unified" && catalogResults.isFetching) ||
    (suggestionMode === "tag" && tagResults.isFetching);
  const catalogUnavailable =
    suggestionMode === "unified" &&
    !catalogResults.isFetching &&
    (catalogResults.isError || catalogResults.data?.status === "unavailable");

  const suggestionRows = useMemo<SuggestionRow[]>(() => {
    if (suggestionMode === "tag") {
      return uniqueTags(tagResults.data?.tags ?? []).map((tagName) => ({
        kind: "tag",
        key: `tag:${tagName}`,
        tagName,
      }));
    }
    if (suggestionMode !== "unified") return [];
    return flattenSuggestionSections(
      buildUnifiedSuggestionSections<SuggestionItem>({
        library: libraryResults.data,
        catalog: catalogResults.data,
      }),
    ).map((row) => {
      if (row.kind !== "item" || row.item.type !== "album" || !row.item.id) return row;
      const override = albumOverrides[row.item.id];
      return override ? { ...row, item: { ...row.item, ...override } } : row;
    });
  }, [albumOverrides, catalogResults.data, libraryResults.data, suggestionMode, tagResults.data]);

  const selectableRows = useMemo(() => {
    if (suggestionMode === "tag") return suggestionRows;
    return suggestionRows.filter((row) => row.kind === "item");
  }, [suggestionRows, suggestionMode]);

  const showRecentSearches =
    inputFocused &&
    trimmedQuery.length < 2 &&
    recentSearches.length > 0 &&
    !loadingSuggestions &&
    suggestionRows.length === 0;

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
  const suggestionIndex = suggestionKeyboardRows.findIndex((row) => row.key === highlightedKey);

  const rememberSearch = useCallback((rawQuery: string) => {
    const next = addRecentSearch(rawQuery);
    setRecentSearches(next);
  }, []);

  const closeAutocomplete = useCallback(() => {
    setSuggestionsOpen(false);
    setHighlightedKey(null);
    setAlbumOverrides({});
  }, []);

  useEffect(() => {
    setSearchQuery("");
    closeAutocomplete();
    inputRef.current?.blur();
  }, [location.pathname, location.search, closeAutocomplete]);

  const cancelSearch = () => {
    setSearchQuery("");
    closeAutocomplete();
    setInputFocused(false);
    inputRef.current?.blur();
  };

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
    setHighlightedKey(null);
  }, []);

  const updateSuggestionItem = useCallback(
    (targetItem: SuggestionAlbum, patch: Partial<SuggestionAlbum>) => {
      const albumId = targetItem.id;
      if (!albumId) return;
      setAlbumOverrides((current) => ({
        ...current,
        [albumId]: { ...current[albumId], ...patch },
      }));
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
      if (searchQuery && suggestionsOpen) closeAutocomplete();
      else cancelSearch();
      return;
    }
    if (suggestionKeyboardRows.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlightedKey(
        suggestionKeyboardRows[Math.min(suggestionIndex + 1, suggestionKeyboardRows.length - 1)]
          ?.key ?? null,
      );
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlightedKey(suggestionKeyboardRows[suggestionIndex - 1]?.key ?? null);
    } else if (event.key === "Enter") {
      const row = suggestionKeyboardRows[suggestionIndex];
      if (!row) return;
      event.preventDefault();
      handleSuggestionSelect(row);
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

  const searchActive = inputFocused || searchQuery.length > 0;

  return (
    <form
      ref={searchContainerRef}
      onSubmit={handleSubmit}
      className={`global-search${searchActive ? " is-active" : ""}`}
    >
      <div className="global-search__box global-search__box--unified">
        <div className="global-search__input-wrap global-search__input-wrap--unified">
          <Search className="global-search__icon" />
          <input
            ref={inputRef}
            type="text"
            value={searchQuery}
            onChange={(event) => {
              setSearchQuery(event.target.value);
              setSuggestionsOpen(true);
              setHighlightedKey(null);
            }}
            onFocus={() => {
              setInputFocused(true);
              setSuggestionsOpen(true);
              setHighlightedKey(null);
            }}
            onBlur={() => {
              window.setTimeout(() => setInputFocused(false), 120);
            }}
            onKeyDown={handleKeyDown}
            placeholder=""
            aria-label="Search music, artists, or tags"
            className="global-search__input"
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="search"
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

      {searchActive ? (
        <button type="button" className="global-search__cancel" onClick={cancelSearch}>
          Cancel
        </button>
      ) : null}

      <div className="global-search__panel">
        {catalogUnavailable && suggestionRows.length === 0 && (
          <div className="global-search__suggestions global-search__suggestions--grouped">
            <div className="global-search__suggestion-group">Catalog unavailable</div>
            <div className="global-search__suggestion global-search__suggestion--message">
              The metadata server did not answer. Try again in a moment.
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
      </div>
    </form>
  );
}

export default GlobalSearch;

import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { ChevronDown, Loader2, Search } from "lucide-react";
import {
  getBootstrapStatus,
  getTagSuggestions,
  searchArtists,
} from "../utils/api";

const AUTOCOMPLETE_DEBOUNCE_MS = 250;
const AUTOCOMPLETE_LIMIT = 6;
const TAG_SUGGESTIONS_LIMIT = 8;
const SEARCH_SCOPES = [
  { value: "artist", label: "Artist", shortLabel: "Artist" },
  { value: "album", label: "Album/Release", shortLabel: "Release" },
  { value: "tag", label: "Tag", shortLabel: "Tag" },
];

function normalizeArtistName(value) {
  if (!value || typeof value !== "string") return "";
  return value
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\s4$/g, " for")
    .replace(/\s*[.\-_]\s*$/g, "")
    .trim();
}

function isEditableTarget(target) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tagName = target.tagName.toLowerCase();
  return ["input", "textarea", "select"].includes(tagName);
}

function GlobalSearch() {
  const [searchQuery, setSearchQuery] = useState("");
  const [searchScope, setSearchScope] = useState("artist");
  const [lastfmConfigured, setLastfmConfigured] = useState(true);
  const [scopeMenuOpen, setScopeMenuOpen] = useState(false);
  const [suggestions, setSuggestions] = useState([]);
  const [suggestionMode, setSuggestionMode] = useState(null);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const [suggestionIndex, setSuggestionIndex] = useState(-1);
  const searchContainerRef = useRef(null);
  const inputRef = useRef(null);
  const debounceRef = useRef(null);
  const navigate = useNavigate();
  const location = useLocation();

  const closeAutocomplete = useCallback(() => {
    setSuggestions([]);
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

  const availableScopes = lastfmConfigured
    ? SEARCH_SCOPES
    : SEARCH_SCOPES.filter((scope) => scope.value !== "tag");

  const selectedScope =
    availableScopes.find((scope) => scope.value === searchScope) ||
    availableScopes[0];

  useEffect(() => {
    if (!lastfmConfigured && searchScope === "tag") {
      setSearchScope("artist");
    }
  }, [lastfmConfigured, searchScope]);

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
    const effectiveScope = isTagShortcut ? "tag" : searchScope;
    const tagPart = isTagShortcut ? trimmed.slice(1).trim() : trimmed;
    const shouldAutocomplete =
      effectiveScope === "tag"
        ? isTagShortcut || searchScope === "tag"
        : effectiveScope === "artist";

    if (
      !shouldAutocomplete ||
      (effectiveScope === "artist" && trimmed.length < 2) ||
      (effectiveScope === "tag" && !isTagShortcut && trimmed.length < 2)
    ) {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      closeAutocomplete();
      return;
    }

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      debounceRef.current = null;
      setLoadingSuggestions(true);
      try {
        if (effectiveScope === "tag") {
          const data = await getTagSuggestions(tagPart, TAG_SUGGESTIONS_LIMIT);
          const raw = data.tags || [];
          const seen = new Set();
          const list = raw.filter((tag) => {
            const key = String(tag || "")
              .trim()
              .toLowerCase();
            if (!key || seen.has(key)) return false;
            seen.add(key);
            return true;
          });
          setSuggestions(list);
          setSuggestionMode("tag");
          setSuggestionIndex(-1);
          return;
        }

        const data = await searchArtists(trimmed, AUTOCOMPLETE_LIMIT, 0);
        const raw = data.artists || [];
        const seenIds = new Set();
        const seenNames = new Set();
        const list = raw.filter((artist) => {
          if (!artist?.id || seenIds.has(artist.id)) return false;
          const key = normalizeArtistName(artist.name);
          if (!key || seenNames.has(key)) return false;
          seenIds.add(artist.id);
          seenNames.add(key);
          return true;
        });
        setSuggestions(list);
        setSuggestionMode("artist");
        setSuggestionIndex(-1);
      } catch {
        closeAutocomplete();
      } finally {
        setLoadingSuggestions(false);
      }
    }, AUTOCOMPLETE_DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [searchQuery, searchScope, closeAutocomplete, lastfmConfigured]);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (
        searchContainerRef.current &&
        !searchContainerRef.current.contains(event.target)
      ) {
        setScopeMenuOpen(false);
        closeAutocomplete();
      }
    };
    document.addEventListener("click", handleClickOutside);
    return () => document.removeEventListener("click", handleClickOutside);
  }, [closeAutocomplete]);

  const navigateToSearch = useCallback(
    (rawQuery, scopeOverride = null) => {
      const trimmed = String(rawQuery || "").trim();
      if (!trimmed) return;
      if (trimmed.startsWith("#")) {
        navigate(`/search?q=${encodeURIComponent(trimmed.slice(1))}&type=tag`);
      } else {
        const effectiveScope = scopeOverride || searchScope;
        navigate(
          `/search?q=${encodeURIComponent(trimmed)}&type=${encodeURIComponent(
            effectiveScope,
          )}`,
        );
      }
      setSearchQuery("");
      setScopeMenuOpen(false);
      closeAutocomplete();
    },
    [navigate, searchScope, closeAutocomplete],
  );

  const handleSubmit = (event) => {
    event.preventDefault();
    navigateToSearch(searchQuery);
  };

  const handleSuggestionSelect = useCallback(
    (selection) => {
      if (typeof selection === "string") {
        navigate(`/search?q=${encodeURIComponent(selection)}&type=tag`);
        setSearchQuery("");
        setScopeMenuOpen(false);
        closeAutocomplete();
        return;
      }
      if (!selection?.id) return;
      navigate(`/artist/${selection.id}`, {
        state: { artistName: selection.name },
      });
      setSearchQuery("");
      setScopeMenuOpen(false);
      closeAutocomplete();
    },
    [navigate, closeAutocomplete],
  );

  const handleKeyDown = (event) => {
    if (event.key === "Escape") {
      closeAutocomplete();
      return;
    }
    if (suggestions.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSuggestionIndex((current) =>
        current < suggestions.length - 1 ? current + 1 : current,
      );
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSuggestionIndex((current) => (current > 0 ? current - 1 : -1));
    } else if (event.key === "Enter" && suggestionIndex >= 0) {
      event.preventDefault();
      handleSuggestionSelect(suggestions[suggestionIndex]);
    }
  };

  return (
    <form
      ref={searchContainerRef}
      onSubmit={handleSubmit}
      className="global-search"
    >
      <div className="global-search__box">
        <div className="global-search__scope-wrap">
          <button
            type="button"
            onClick={() => setScopeMenuOpen((open) => !open)}
            className={`global-search__scope-button${scopeMenuOpen ? " is-open" : ""}`}
            aria-haspopup="listbox"
            aria-expanded={scopeMenuOpen}
            aria-label="Search scope"
          >
            <span className="global-search__scope-label--short">{selectedScope.shortLabel}</span>
            <span className="global-search__scope-label--full">{selectedScope.label}</span>
            <ChevronDown
              className={`artist-icon-sm${scopeMenuOpen ? " artist-chevron--open" : ""}`}
            />
          </button>

          {scopeMenuOpen && (
            <div className="global-search__scope-menu">
              <ul className="global-search__scope-list">
                {availableScopes.map((scope) => {
                  const selected = scope.value === searchScope;
                  return (
                    <li key={scope.value}>
                      <button
                        type="button"
                        onClick={() => {
                          setSearchScope(scope.value);
                          setScopeMenuOpen(false);
                        }}
                        className={`global-search__menu-button${selected ? " is-selected" : ""}`}
                        role="option"
                        aria-selected={selected}
                      >
                        <span className="global-search__scope-label--short">{scope.shortLabel}</span>
                        <span className="global-search__scope-label--full">{scope.label}</span>
                        {selected && (
                          <span className="global-search__selected-dot" />
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>

        <div className="global-search__divider" />

        <div className="global-search__input-wrap">
          <Search className="global-search__icon" />
          <input
            ref={inputRef}
            type="text"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder=""
            className="global-search__input"
            autoComplete="off"
          />
          {!searchQuery && (
            <div className="global-search__placeholder">
              <span className="global-search__scope-label--short">Search...</span>
              <span className="global-search__scope-label--full">Type</span>
              <span className="global-search__key">
                /
              </span>
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

      {!loadingSuggestions && suggestions.length > 0 && (
        <ul className="global-search__suggestions">
          {suggestionMode === "tag"
            ? suggestions.map((tagName, index) => (
                <li key={tagName}>
                  <button
                    type="button"
                    onClick={() => handleSuggestionSelect(tagName)}
                    className={`global-search__suggestion${index === suggestionIndex ? " is-highlighted" : ""}`}
                  >
                    #{tagName}
                  </button>
                </li>
              ))
            : suggestions.map((artist, index) => (
                <li key={artist.id || index}>
                  <button
                    type="button"
                    onClick={() => handleSuggestionSelect(artist)}
                    className={`global-search__suggestion${index === suggestionIndex ? " is-highlighted" : ""}`}
                  >
                    {artist.name}
                  </button>
                </li>
              ))}
        </ul>
      )}
    </form>
  );
}

export default GlobalSearch;

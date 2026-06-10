import { useEffect, useMemo, useRef, useState } from "react";
import {
  Ban,
  Loader,
  Search,
  Tag,
  UserX,
  X,
} from "lucide-react";
import {
  getBlocklist,
  updateBlocklist,
  searchArtists,
  getTagSuggestions,
} from "../utils/api";
import { useToast } from "../contexts/ToastContext";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { getTagColor } from "./ArtistDetails/utils";

const AUTOCOMPLETE_DEBOUNCE_MS = 250;
const AUTOCOMPLETE_LIMIT = 6;
const TAG_SUGGESTIONS_LIMIT = 8;

const isValidMbid = (value) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    String(value || "").trim(),
  );

const normalizeArtists = (artists) => {
  const source = Array.isArray(artists) ? artists : [];
  const seen = new Set();
  const out = [];
  for (const entry of source) {
    if (!entry) continue;
    const mbid = isValidMbid(entry.mbid) ? String(entry.mbid).trim() : null;
    const name = String(entry.name || "").trim();
    if (!mbid && !name) continue;
    const key = mbid ? `mbid:${mbid.toLowerCase()}` : `name:${name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ mbid, name: name || null });
  }
  return out;
};

const normalizeTags = (tags) => {
  const source = Array.isArray(tags) ? tags : [];
  const seen = new Set();
  const out = [];
  for (const entry of source) {
    const name = String(entry || "").trim().toLowerCase();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
};

const isArtistBlocked = (artist, blockedArtists) => {
  const source = Array.isArray(blockedArtists) ? blockedArtists : [];
  const candidateMbid = isValidMbid(artist?.id) ? String(artist.id).toLowerCase() : null;
  const candidateName = String(artist?.name || "").trim().toLowerCase();
  return source.some((entry) => {
    const entryMbid = isValidMbid(entry?.mbid) ? String(entry.mbid).toLowerCase() : null;
    const entryName = String(entry?.name || "").trim().toLowerCase();
    if (candidateMbid && entryMbid && candidateMbid === entryMbid) return true;
    if (candidateName && entryName && candidateName === entryName) return true;
    return false;
  });
};

function BlocklistPage() {
  useDocumentTitle("Blocklist");
  const [searchInput, setSearchInput] = useState("");
  const [blocklist, setBlocklist] = useState({ artists: [], tags: [] });
  const [suggestions, setSuggestions] = useState([]);
  const [suggestionMode, setSuggestionMode] = useState(null);
  const [suggestionIndex, setSuggestionIndex] = useState(-1);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const searchRef = useRef(null);
  const debounceRef = useRef(null);
  const { showSuccess, showError } = useToast();

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const data = await getBlocklist();
        if (cancelled) return;
        setBlocklist({
          artists: normalizeArtists(data.artists),
          tags: normalizeTags(data.tags),
        });
      } catch (error) {
        if (!cancelled) {
          showError(error.response?.data?.message || "Failed to load blocklist");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [showError]);

  const persistBlocklist = async (nextBlocklist) => {
    setSaving(true);
    try {
      const normalized = {
        artists: normalizeArtists(nextBlocklist.artists),
        tags: normalizeTags(nextBlocklist.tags),
      };
      const response = await updateBlocklist(normalized);
      const saved = response?.blocklist || normalized;
      setBlocklist({
        artists: normalizeArtists(saved.artists),
        tags: normalizeTags(saved.tags),
      });
      showSuccess("Blocklist updated");
    } catch (error) {
      showError(error.response?.data?.message || "Failed to save blocklist");
    } finally {
      setSaving(false);
    }
  };

  const addArtist = async ({ mbid = null, name = null } = {}) => {
    const artistName = String(name || "").trim();
    const artistMbid = isValidMbid(mbid) ? String(mbid).trim() : null;
    if (!artistMbid && !artistName) return;
    const nextArtists = [...blocklist.artists, { mbid: artistMbid, name: artistName || null }];
    await persistBlocklist({
      ...blocklist,
      artists: nextArtists,
    });
  };

  const addTag = async (tagName) => {
    const normalized = String(tagName || "").trim().toLowerCase();
    if (!normalized) return;
    await persistBlocklist({
      ...blocklist,
      tags: [...blocklist.tags, normalized],
    });
  };

  const removeArtist = async (entry) => {
    const targetMbid = String(entry?.mbid || "").trim().toLowerCase();
    const targetName = String(entry?.name || "").trim().toLowerCase();
    await persistBlocklist({
      ...blocklist,
      artists: blocklist.artists.filter((artist) => {
        const artistMbid = String(artist?.mbid || "").trim().toLowerCase();
        const artistName = String(artist?.name || "").trim().toLowerCase();
        if (targetMbid && artistMbid === targetMbid) return false;
        if (!targetMbid && targetName && artistName === targetName) return false;
        return true;
      }),
    });
  };

  const removeTag = async (tagName) => {
    const target = String(tagName || "").trim().toLowerCase();
    await persistBlocklist({
      ...blocklist,
      tags: blocklist.tags.filter((tag) => tag !== target),
    });
  };

  const closeSuggestions = () => {
    setSuggestions([]);
    setSuggestionMode(null);
    setSuggestionIndex(-1);
  };

  const selectSuggestion = async (entry) => {
    if (!entry) return;
    if (typeof entry === "string") {
      await addTag(entry);
    } else {
      await addArtist({
        mbid: entry.id || null,
        name: entry.name || null,
      });
    }
    setSearchInput("");
    closeSuggestions();
  };

  useEffect(() => {
    const trimmed = searchInput.trim();
    const isTag = trimmed.startsWith("#");
    const tagPart = isTag ? trimmed.slice(1).trim() : "";
    if (!isTag && trimmed.length < 2) {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      closeSuggestions();
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      debounceRef.current = null;
      setLoadingSuggestions(true);
      try {
        if (isTag) {
          const data = await getTagSuggestions(tagPart, TAG_SUGGESTIONS_LIMIT);
          const tags = normalizeTags(data.tags || []);
          setSuggestions(tags);
          setSuggestionMode("tag");
        } else {
          const data = await searchArtists(trimmed, AUTOCOMPLETE_LIMIT, 0);
          const artists = Array.isArray(data.artists) ? data.artists : [];
          const deduped = [];
          const seen = new Set();
          for (const artist of artists) {
            if (!artist?.id || !artist?.name) continue;
            const key = String(artist.id).trim().toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            deduped.push(artist);
          }
          setSuggestions(deduped);
          setSuggestionMode("artist");
        }
        setSuggestionIndex(-1);
      } catch {
        closeSuggestions();
      } finally {
        setLoadingSuggestions(false);
      }
    }, AUTOCOMPLETE_DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [searchInput]);

  useEffect(() => {
    const onClickOutside = (event) => {
      if (searchRef.current && !searchRef.current.contains(event.target)) {
        closeSuggestions();
      }
    };
    document.addEventListener("click", onClickOutside);
    return () => document.removeEventListener("click", onClickOutside);
  }, []);

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (suggestionIndex >= 0 && suggestions[suggestionIndex]) {
      await selectSuggestion(suggestions[suggestionIndex]);
      return;
    }
    const trimmed = searchInput.trim();
    if (!trimmed) return;
    if (trimmed.startsWith("#")) {
      await addTag(trimmed.slice(1));
    } else {
      await addArtist({ name: trimmed });
    }
    setSearchInput("");
    closeSuggestions();
  };

  const handleInputKeyDown = (event) => {
    if (suggestions.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSuggestionIndex((current) =>
        current < suggestions.length - 1 ? current + 1 : current,
      );
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSuggestionIndex((current) => (current > 0 ? current - 1 : -1));
    } else if (event.key === "Escape") {
      closeSuggestions();
    }
  };

  const blockedArtistCount = useMemo(() => blocklist.artists.length, [blocklist.artists]);
  const blockedTagCount = useMemo(() => blocklist.tags.length, [blocklist.tags]);

  return (
    <div className="blocklist-page">
      <header className="blocklist-page__header">
        <h1 className="blocklist-page__title">Blocklist</h1>
        <p className="blocklist-page__subtitle">
          Search artists or use #tags to block recommendations from Discover and Flow.
        </p>
      </header>

      <section className="blocklist-page__add-panel artist-panel">
        <div className="blocklist-page__panel-heading">
          <Ban className="artist-icon-sm" aria-hidden="true" />
          <h2 className="blocklist-page__panel-title">Add to Blocklist</h2>
        </div>
        {loading ? (
          <div className="blocklist-page__loading">
            <Loader className="artist-spinner animate-spin" />
            <span className="artist-count">Loading blocklist...</span>
          </div>
        ) : (
          <div ref={searchRef} className="blocklist-page__search global-search">
            <form onSubmit={handleSubmit}>
              <div className="global-search__box">
                <div className="global-search__input-wrap">
                  <Search className="global-search__icon" aria-hidden="true" />
                  <input
                    type="text"
                    value={searchInput}
                    onChange={(event) => setSearchInput(event.target.value)}
                    onKeyDown={handleInputKeyDown}
                    placeholder="Search artist or #tag"
                    className="global-search__input"
                    autoComplete="off"
                    aria-label="Search artist or tag to block"
                  />
                  {loadingSuggestions && (
                    <Loader className="global-search__loader artist-icon-sm animate-spin" />
                  )}
                </div>
              </div>
            </form>
            {suggestions.length > 0 && (
              <ul className="global-search__suggestions blocklist-page__suggestions">
                {suggestionMode === "tag"
                  ? suggestions.map((tag, index) => (
                      <li key={tag}>
                        <button
                          type="button"
                          onClick={() => selectSuggestion(tag)}
                          className={`global-search__suggestion${index === suggestionIndex ? " is-highlighted" : ""}`}
                        >
                          #{tag}
                        </button>
                      </li>
                    ))
                  : suggestions.map((artist, index) => (
                      <li key={artist.id}>
                        <button
                          type="button"
                          onClick={() => selectSuggestion(artist)}
                          className={`global-search__suggestion${index === suggestionIndex ? " is-highlighted" : ""}`}
                        >
                          <span>{artist.name}</span>
                          {isArtistBlocked(artist, blocklist.artists) && (
                            <span className="artist-count">blocked</span>
                          )}
                        </button>
                      </li>
                    ))}
              </ul>
            )}
            <p className="blocklist-page__hint">
              Press Enter to add. If no suggestion is selected, typed text is used.
            </p>
            {saving && (
              <p className="blocklist-page__saving">
                <Loader className="artist-icon-xs animate-spin" />
                Saving...
              </p>
            )}
          </div>
        )}
      </section>

      {!loading && (
        <div className="blocklist-page__lists">
          <section className="blocklist-page__list-panel artist-panel">
            <h2 className="blocklist-page__list-heading">
              <UserX className="artist-icon-sm" aria-hidden="true" />
              Blocked Artists ({blockedArtistCount})
            </h2>
            <div className="blocklist-page__chips">
              {blocklist.artists.length ? (
                blocklist.artists.map((artist) => {
                  const key = artist.mbid || artist.name;
                  return (
                    <span key={key} className="blocklist-page__chip">
                      {artist.name || artist.mbid}
                      <button
                        type="button"
                        onClick={() => removeArtist(artist)}
                        className="blocklist-page__chip-remove"
                        aria-label={`Remove ${artist.name || artist.mbid} from blocklist`}
                      >
                        <X className="artist-icon-xs" />
                      </button>
                    </span>
                  );
                })
              ) : (
                <p className="blocklist-page__empty-copy">No blocked artists yet.</p>
              )}
            </div>
          </section>

          <section className="blocklist-page__list-panel artist-panel">
            <h2 className="blocklist-page__list-heading">
              <Tag className="artist-icon-sm" aria-hidden="true" />
              Blocked Genres/Tags ({blockedTagCount})
            </h2>
            <div className="blocklist-page__chips">
              {blocklist.tags.length ? (
                blocklist.tags.map((tag) => (
                  <span
                    key={tag}
                    className="blocklist-page__chip blocklist-page__chip--tag"
                    style={{ backgroundColor: getTagColor(tag) }}
                  >
                    #{tag}
                    <button
                      type="button"
                      onClick={() => removeTag(tag)}
                      className="blocklist-page__chip-remove"
                      aria-label={`Remove tag ${tag} from blocklist`}
                    >
                      <X className="artist-icon-xs" />
                    </button>
                  </span>
                ))
              ) : (
                <p className="blocklist-page__empty-copy">No blocked tags yet.</p>
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

export default BlocklistPage;

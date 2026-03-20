import { useEffect, useMemo, useRef, useState } from "react";
import {
  Ban,
  Loader2,
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
    <div className="animate-fade-in max-w-4xl mx-auto pb-8">
      <div className="mb-6">
        <h1 className="text-3xl font-bold mb-2" style={{ color: "#fff" }}>
          Blocklist
        </h1>
        <p style={{ color: "#c1c1c3" }}>
          Search artists or use #tags to block recommendations from Discover and Flow.
        </p>
      </div>

      <div
        className="p-6 mb-6"
        style={{
          backgroundColor: "#1a1a1e",
          border: "1px solid #2a2a2e",
        }}
      >
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2" style={{ color: "#fff" }}>
            <Ban className="w-5 h-5" />
            <span className="text-lg font-semibold">Add to Blocklist</span>
          </div>
        </div>
        {loading ? (
          <div className="flex items-center gap-2 py-6" style={{ color: "#c1c1c3" }}>
            <Loader2 className="w-4 h-4 animate-spin" />
            <span>Loading blocklist...</span>
          </div>
        ) : (
          <div ref={searchRef} className="relative">
            <form onSubmit={handleSubmit}>
              <div className="relative">
                <div className="absolute inset-y-0 left-3 flex items-center pointer-events-none">
                  <Search className="w-4 h-4" style={{ color: "#c1c1c3" }} />
                </div>
                <input
                  type="text"
                  value={searchInput}
                  onChange={(event) => setSearchInput(event.target.value)}
                  onKeyDown={handleInputKeyDown}
                  placeholder="Search artist or #tag"
                  className="w-full pl-10 pr-4 py-2 text-sm focus:outline-none focus:ring-2"
                  style={{
                    backgroundColor: "#0f0f12",
                    border: "1px solid #2a2a2e",
                    color: "#fff",
                  }}
                  autoComplete="off"
                />
                {loadingSuggestions && (
                  <div className="absolute inset-y-0 right-3 flex items-center">
                    <Loader2 className="w-4 h-4 animate-spin" style={{ color: "#c1c1c3" }} />
                  </div>
                )}
              </div>
            </form>
            {suggestions.length > 0 && (
              <ul
                className="absolute left-0 right-0 top-full mt-1 py-1 shadow-lg z-30 max-h-64 overflow-y-auto"
                style={{ backgroundColor: "#211f27", border: "1px solid #2a2a2e" }}
              >
                {suggestionMode === "tag"
                  ? suggestions.map((tag, index) => (
                      <li key={tag}>
                        <button
                          type="button"
                          onClick={() => selectSuggestion(tag)}
                          className="w-full text-left px-4 py-2 text-sm hover:bg-white/10"
                          style={{
                            color: "#fff",
                            backgroundColor:
                              index === suggestionIndex ? "rgba(255,255,255,0.1)" : undefined,
                          }}
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
                          className="w-full text-left px-4 py-2 text-sm hover:bg-white/10"
                          style={{
                            color: "#fff",
                            backgroundColor:
                              index === suggestionIndex ? "rgba(255,255,255,0.1)" : undefined,
                          }}
                        >
                          <span>{artist.name}</span>
                          {isArtistBlocked(artist, blocklist.artists) && (
                            <span className="ml-2 text-xs" style={{ color: "#8b8b90" }}>
                              blocked
                            </span>
                          )}
                        </button>
                      </li>
                    ))}
              </ul>
            )}
            <p className="text-xs mt-2" style={{ color: "#8b8b90" }}>
              Press Enter to add. If no suggestion is selected, typed text is used.
            </p>
            {saving && (
              <div className="text-xs mt-2 flex items-center gap-2" style={{ color: "#c1c1c3" }}>
                <Loader2 className="w-3 h-3 animate-spin" />
                Saving...
              </div>
            )}
          </div>
        )}
      </div>

      {!loading && (
        <div className="grid gap-4 md:grid-cols-2">
          <div className="p-4" style={{ backgroundColor: "#1a1a1e", border: "1px solid #2a2a2e" }}>
            <div className="text-sm font-medium mb-3 flex items-center gap-2" style={{ color: "#fff" }}>
              <UserX className="w-4 h-4" />
              Blocked Artists ({blockedArtistCount})
            </div>
            <div className="flex flex-wrap gap-2">
              {blocklist.artists.length ? (
                blocklist.artists.map((artist) => {
                  const key = artist.mbid || artist.name;
                  return (
                    <span
                      key={key}
                      className="inline-flex items-center gap-2 px-2 py-1 text-xs"
                      style={{ backgroundColor: "#0f0f12", color: "#c1c1c3" }}
                    >
                      {artist.name || artist.mbid}
                      <button
                        type="button"
                        onClick={() => removeArtist(artist)}
                        className="opacity-70 hover:opacity-100"
                        aria-label={`Remove ${artist.name || artist.mbid} from blocklist`}
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </span>
                  );
                })
              ) : (
                <span className="text-sm" style={{ color: "#8b8b90" }}>
                  No blocked artists yet.
                </span>
              )}
            </div>
          </div>
          <div className="p-4" style={{ backgroundColor: "#1a1a1e", border: "1px solid #2a2a2e" }}>
            <div className="text-sm font-medium mb-3 flex items-center gap-2" style={{ color: "#fff" }}>
              <Tag className="w-4 h-4" />
              Blocked Genres/Tags ({blockedTagCount})
            </div>
            <div className="flex flex-wrap gap-2">
              {blocklist.tags.length ? (
                blocklist.tags.map((tag) => (
                  <span
                    key={tag}
                    className="inline-flex items-center gap-2 px-2 py-1 text-xs"
                    style={{ backgroundColor: "#0f0f12", color: "#c1c1c3" }}
                  >
                    #{tag}
                    <button
                      type="button"
                      onClick={() => removeTag(tag)}
                      className="opacity-70 hover:opacity-100"
                      aria-label={`Remove tag ${tag} from blocklist`}
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))
              ) : (
                <span className="text-sm" style={{ color: "#8b8b90" }}>
                  No blocked tags yet.
                </span>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default BlocklistPage;

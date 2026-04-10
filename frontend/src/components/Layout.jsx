import { useState, useEffect, useRef, useCallback } from "react";
import PropTypes from "prop-types";
import { useNavigate, useLocation } from "react-router-dom";
import { Search, Menu, Github, Heart, Loader2 } from "lucide-react";
import Sidebar from "./Sidebar";
import { searchArtists, getTagSuggestions } from "../utils/api";

const AUTOCOMPLETE_DEBOUNCE_MS = 250;
const AUTOCOMPLETE_LIMIT = 6;
const TAG_SUGGESTIONS_LIMIT = 8;

function normalizeArtistName(s) {
  if (!s || typeof s !== "string") return "";
  return s
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\s4$/g, " for")
    .replace(/\s*[.\-_]\s*$/g, "")
    .trim();
}

const VALID_SIDEBAR_MODES = ["full", "icons", "hidden"];

function Layout({ children, appVersion }) {
  const [searchQuery, setSearchQuery] = useState("");
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [sidebarMode, setSidebarMode] = useState(() => {
    try {
      const stored = localStorage.getItem("sidebarMode");
      return VALID_SIDEBAR_MODES.includes(stored) ? stored : "full";
    } catch {
      return "full";
    }
  });
  const prevVisibleMode = useRef(
    sidebarMode !== "hidden"
      ? sidebarMode
      : (() => { try { const s = localStorage.getItem("sidebarVisibleMode"); return s === "full" || s === "icons" ? s : "full"; } catch { return "full"; } })()
  );
  const [suggestions, setSuggestions] = useState([]);
  const [suggestionMode, setSuggestionMode] = useState(null);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const [suggestionIndex, setSuggestionIndex] = useState(-1);
  const searchContainerRef = useRef(null);
  const debounceRef = useRef(null);
  const navigate = useNavigate();
  const location = useLocation();

  const handleSetSidebarMode = useCallback((newMode) => {
    if (newMode !== "hidden") {
      prevVisibleMode.current = newMode;
    }
    setSidebarMode(newMode);
    try {
      localStorage.setItem("sidebarMode", newMode);
      if (newMode !== "hidden") {
        localStorage.setItem("sidebarVisibleMode", newMode);
      }
    } catch {
      // localStorage unavailable
    }
  }, []);

  useEffect(() => {
    setIsSidebarOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    const trimmed = searchQuery.trim();
    const isTag = trimmed.startsWith("#");
    const tagPart = isTag ? trimmed.slice(1).trim() : "";
    if (!isTag && trimmed.length < 2) {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      setSuggestions([]);
      setSuggestionMode(null);
      setSuggestionIndex(-1);
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      debounceRef.current = null;
      setLoadingSuggestions(true);
      try {
        if (isTag) {
          const data = await getTagSuggestions(tagPart, TAG_SUGGESTIONS_LIMIT);
          const raw = data.tags || [];
          const seen = new Set();
          const list = raw.filter((t) => {
            const key = (t != null ? String(t).trim() : "").toLowerCase();
            if (!key || seen.has(key)) return false;
            seen.add(key);
            return true;
          });
          setSuggestions(list);
          setSuggestionMode("tag");
          setSuggestionIndex(-1);
        } else {
          const data = await searchArtists(trimmed, AUTOCOMPLETE_LIMIT, 0);
          const raw = data.artists || [];
          const seenId = new Set();
          const seenName = new Set();
          const list = raw.filter((a) => {
            if (!a.id) return false;
            if (seenId.has(a.id)) return false;
            const key = normalizeArtistName(a.name);
            if (!key || seenName.has(key)) return false;
            seenId.add(a.id);
            seenName.add(key);
            return true;
          });
          setSuggestions(list);
          setSuggestionMode("artist");
          setSuggestionIndex(-1);
        }
      } catch {
        setSuggestions([]);
        setSuggestionMode(null);
      } finally {
        setLoadingSuggestions(false);
      }
    }, AUTOCOMPLETE_DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [searchQuery]);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (
        searchContainerRef.current &&
        !searchContainerRef.current.contains(e.target)
      ) {
        setSuggestions([]);
        setSuggestionMode(null);
        setSuggestionIndex(-1);
      }
    };
    document.addEventListener("click", handleClickOutside);
    return () => document.removeEventListener("click", handleClickOutside);
  }, []);

  const closeAutocomplete = useCallback(() => {
    setSuggestions([]);
    setSuggestionMode(null);
    setSuggestionIndex(-1);
  }, []);

  const handleSearch = (e) => {
    e.preventDefault();
    if (searchQuery.trim()) {
      const trimmedQuery = searchQuery.trim();
      if (trimmedQuery.startsWith("#")) {
        const tag = trimmedQuery.substring(1);
        navigate(`/search?q=${encodeURIComponent(tag)}&type=tag`);
      } else {
        navigate(`/search?q=${encodeURIComponent(trimmedQuery)}`);
      }
      setSearchQuery("");
      closeAutocomplete();
    }
  };

  const handleSuggestionSelect = useCallback(
    (artistOrTag) => {
      if (typeof artistOrTag === "string") {
        navigate(
          `/search?q=${encodeURIComponent("#" + artistOrTag)}&type=tag`,
        );
        setSearchQuery("");
        closeAutocomplete();
        return;
      }
      if (!artistOrTag?.id) return;
      navigate(`/artist/${artistOrTag.id}`, {
        state: { artistName: artistOrTag.name },
      });
      setSearchQuery("");
      closeAutocomplete();
    },
    [navigate, closeAutocomplete],
  );

  const handleKeyDown = (e) => {
    if (suggestions.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSuggestionIndex((i) =>
        i < suggestions.length - 1 ? i + 1 : i,
      );
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSuggestionIndex((i) => (i > 0 ? i - 1 : -1));
    } else if (e.key === "Enter" && suggestionIndex >= 0) {
      e.preventDefault();
      handleSuggestionSelect(suggestions[suggestionIndex]);
    } else if (e.key === "Escape") {
      setSuggestions([]);
      setSuggestionIndex(-1);
    }
  };

  return (
    <div className="min-h-screen font-sans antialiased transition-colors duration-200">
      <Sidebar
        isOpen={isSidebarOpen}
        onClose={() => setIsSidebarOpen(false)}
        appVersion={appVersion}
        mode={sidebarMode}
        onSetMode={handleSetSidebarMode}
      />

      <div
        className={`flex flex-col min-h-screen transition-all duration-300 ease-in-out ${
          sidebarMode === "full"
            ? "md:ml-[208px]"
            : sidebarMode === "icons"
              ? "md:ml-[56px]"
              : ""
        }`}
      >
        <header
          className="sticky h-16 top-0 z-30 px-4 py-3 md:px-6 backdrop-blur-md flex items-center gap-4"
          style={{ backgroundColor: "rgba(5, 5, 5, 0.8)" }}
        >
          <button
            onClick={() => {
              const isDesktop = window.matchMedia("(min-width: 768px)").matches;
              if (isDesktop) {
                handleSetSidebarMode(sidebarMode === "hidden" ? prevVisibleMode.current : "hidden");
              } else {
                setIsSidebarOpen(true);
              }
            }}
            className="p-2 -ml-2 hover:bg-gray-900/50 transition-colors"
            style={{ color: "#c1c1c3" }}
            aria-label="Toggle navigation"
          >
            <Menu className="w-5 h-5" />
          </button>

          <form
            ref={searchContainerRef}
            onSubmit={handleSearch}
            className="relative flex-1"
          >
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <Search className="h-5 w-5" style={{ color: "#c1c1c3" }} />
            </div>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Search artists or #tags"
              className="block w-full pl-10 pr-4 py-2 text-sm focus:outline-none focus:ring-2 transition-shadow shadow-sm"
              style={{
                focusRingColor: "#c1c1c3",
                backgroundColor: "#211f27",
                color: "#fff",
              }}
              autoComplete="off"
            />
            {loadingSuggestions && (
              <div
                className="absolute inset-y-0 right-3 flex items-center pointer-events-none"
                style={{ color: "#c1c1c3" }}
              >
                <Loader2 className="h-5 w-5 animate-spin" />
              </div>
            )}
            {!loadingSuggestions && suggestions.length > 0 && (
              <ul
                className="absolute left-0 right-0 top-full mt-1 py-1 rounded-md shadow-lg z-50 max-h-64 overflow-x-hidden overflow-y-auto"
                style={{ backgroundColor: "#211f27" }}
              >
                {suggestionMode === "tag"
                  ? suggestions.map((tagName, i) => (
                      <li key={tagName}>
                        <button
                          type="button"
                          onClick={() => handleSuggestionSelect(tagName)}
                          className="w-full text-left px-4 py-2.5 text-sm hover:bg-white/10 focus:bg-white/10 focus:outline-none"
                          style={{
                            color: "#fff",
                            backgroundColor:
                              i === suggestionIndex
                                ? "rgba(255,255,255,0.1)"
                                : undefined,
                          }}
                        >
                          #{tagName}
                        </button>
                      </li>
                    ))
                  : suggestions.map((artist, i) => (
                      <li key={artist.id || i}>
                        <button
                          type="button"
                          onClick={() => handleSuggestionSelect(artist)}
                          className="w-full text-left px-4 py-2.5 text-sm hover:bg-white/10 focus:bg-white/10 focus:outline-none"
                          style={{
                            color: "#fff",
                            backgroundColor:
                              i === suggestionIndex
                                ? "rgba(255,255,255,0.1)"
                                : undefined,
                          }}
                        >
                          {artist.name}
                        </button>
                      </li>
                    ))}
              </ul>
            )}
          </form>

          <div className="flex items-center space-x-2">
            <a
              href="https://github.com/lklynet/aurral"
              target="_blank"
              rel="noopener noreferrer"
              className="p-2 transition-colors rounded-md hover:bg-white/5 group"
              style={{ color: "#c1c1c3" }}
              aria-label="GitHub Repository"
            >
              <Github className="w-5 h-5 transition-colors group-hover:text-white" />
            </a>
            <a
              href="https://github.com/sponsors/lklynet/"
              target="_blank"
              rel="noopener noreferrer"
              className="p-2 transition-colors rounded-md hover:bg-white/5 group"
              style={{ color: "#c1c1c3" }}
              aria-label="GitHub Sponsors"
            >
              <Heart className="w-5 h-5 transition-colors group-hover:text-pink-500" />
            </a>
          </div>
        </header>

        <main className="flex-1 w-full max-w-[1600px] mx-auto p-4 md:p-8 lg:p-10">
          <div className="animate-fade-in">{children}</div>
        </main>
      </div>
    </div>
  );
}

Layout.propTypes = {
  children: PropTypes.node.isRequired,
  appVersion: PropTypes.string,
};

export default Layout;

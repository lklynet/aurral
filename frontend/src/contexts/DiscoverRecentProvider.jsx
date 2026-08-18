import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useLocation } from "react-router-dom";
import {
  getDiscoverArtistPath,
  pickDiscoverRecentPageState,
  shouldTrackDiscoverPath,
} from "../utils/discoverRecentNavigation";

const DISCOVER_HOME_PATHS = new Set(["/", "/discover"]);
const DISCOVER_RECENT_PAGES_KEY = "aurral.discover.recentPages";
const DISCOVER_FLOW_ACTIVE_KEY = "aurral.discover.flowActive";
const DISCOVER_RECENT_PAGES_LIMIT = 5;

const DiscoverRecentContext = createContext(null);

function isDiscoverHomePath(pathname) {
  return DISCOVER_HOME_PATHS.has(pathname);
}

function isDiscoverBrowsePath(pathname) {
  if (!pathname) return false;
  if (pathname === "/discover/news" || pathname.startsWith("/discover/news/")) return false;
  if (pathname.startsWith("/artist/")) return true;
  if (pathname.startsWith("/discover/")) return true;
  if (pathname === "/search") return true;
  return false;
}

function isDiscoverRecentArtistPath(path) {
  if (!path || typeof path !== "string") return false;
  return path.split("?")[0] === getDiscoverArtistPath(path);
}

function isDiscoverExitPath(pathname) {
  if (!pathname) return false;
  if (pathname.startsWith("/library")) return true;
  if (pathname.startsWith("/shows")) return true;
  if (pathname.startsWith("/playlists")) return true;
  if (pathname.startsWith("/activity")) return true;
  if (pathname.startsWith("/history")) return true;
  if (pathname.startsWith("/settings")) return true;
  if (pathname === "/profile") return true;
  return false;
}

function getDiscoverPathFromLocation(location) {
  if (!location) return "";
  return `${location.pathname || ""}${location.search || ""}`;
}

function shouldRecordDiscoverNavigation(location, recentPages, flowActive) {
  const pathname = location?.pathname || "";
  const path = getDiscoverPathFromLocation(location);
  if (isDiscoverHomePath(pathname)) return true;
  if (flowActive && isDiscoverBrowsePath(pathname)) return true;
  return recentPages.some((entry) => entry.path === path);
}

function shouldKeepDiscoverSectionActive(location, recentPages, flowActive) {
  const pathname = location?.pathname || "";
  const path = getDiscoverPathFromLocation(location);
  if (isDiscoverHomePath(pathname)) return true;
  if (isDiscoverExitPath(pathname)) return false;
  if (recentPages.some((entry) => entry.path === path)) return true;
  return flowActive && isDiscoverBrowsePath(pathname);
}

function readDiscoverFlowActive() {
  if (typeof window === "undefined") return false;
  try {
    return sessionStorage.getItem(DISCOVER_FLOW_ACTIVE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeDiscoverFlowActive(active) {
  if (typeof window === "undefined") return;
  try {
    if (active) {
      sessionStorage.setItem(DISCOVER_FLOW_ACTIVE_KEY, "1");
    } else {
      sessionStorage.removeItem(DISCOVER_FLOW_ACTIVE_KEY);
    }
  } catch {}
}

function normalizeDiscoverPath(path) {
  if (!path || typeof path !== "string") return "";
  const [pathname, search = ""] = path.split("?");
  const artistPath = getDiscoverArtistPath(pathname);
  if (artistPath) return artistPath;
  let normalizedPathname = pathname;
  if (normalizedPathname === "/shows") normalizedPathname = "/shows/all";
  if (normalizedPathname === "/history") {
    normalizedPathname = "/activity/history";
  }
  if (normalizedPathname === "/activity") {
    normalizedPathname = "/activity/queue";
  }
  if (!search) return normalizedPathname;
  const params = new URLSearchParams(search);
  const normalizedSearch = params.toString();
  return normalizedSearch ? `${normalizedPathname}?${normalizedSearch}` : normalizedPathname;
}

function buildDiscoverRecentLabel(path, state = {}) {
  const pathname = path.split("?")[0];
  const params = new URLSearchParams(path.includes("?") ? path.split("?")[1] : "");

  if (pathname.startsWith("/artist/")) {
    const isReleaseRoute = /\/release\/[^/]+$/.test(pathname);
    if (isReleaseRoute) {
      const releaseTitle = state?.focusReleaseGroup?.title || state?.focusTrackTitle || "";
      if (releaseTitle) {
        return state?.artistName ? `${releaseTitle} · ${state.artistName}` : releaseTitle;
      }
    }
    if (/\/albums$/.test(pathname)) {
      return state?.artistName ? `${state.artistName} albums` : "Albums";
    }
    if (/\/appears-on$/.test(pathname)) {
      return state?.artistName ? `${state.artistName} appears on` : "Appears on";
    }
    if (state?.artistName) return state.artistName;
    const segment = pathname.split("/")[2];
    if (segment) {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    }
    return "Artist";
  }

  if (pathname === "/search") {
    const type = params.get("type");
    if (type === "recommended") return "Recommended";
    if (type === "trending") return "Trending";
    if (type === "tag") {
      const query = params.get("q") || "";
      const tag = query.startsWith("#") ? query.slice(1) : query;
      return tag ? `#${tag}` : "Tag search";
    }
    const query = params.get("q");
    if (query) {
      try {
        return decodeURIComponent(query);
      } catch {
        return query;
      }
    }
    return "Search";
  }

  if (pathname.startsWith("/discover/playlists")) return "Playlists";
  if (pathname.startsWith("/shows")) return "Shows";
  if (pathname.startsWith("/playlists")) return "Playlist";
  if (pathname === "/library") return "Library";

  const segment = pathname.split("/").filter(Boolean).pop();
  if (!segment) return "Page";
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function filterDiscoverRecentPages(pages) {
  if (!Array.isArray(pages)) return [];
  return pages.filter((entry) => isDiscoverRecentArtistPath(entry?.path));
}

function readDiscoverRecentPages() {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(DISCOVER_RECENT_PAGES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return filterDiscoverRecentPages(parsed)
      .filter((entry) => entry?.label)
      .slice(0, DISCOVER_RECENT_PAGES_LIMIT)
      .map((entry) => ({
        id: entry.id || entry.path,
        path: normalizeDiscoverPath(entry.path),
        label: String(entry.label),
        state: pickDiscoverRecentPageState(entry.state),
      }));
  } catch {
    return [];
  }
}

function writeDiscoverRecentPages(pages) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(
      DISCOVER_RECENT_PAGES_KEY,
      JSON.stringify(pages.slice(0, DISCOVER_RECENT_PAGES_LIMIT)),
    );
  } catch {}
}

function DiscoverFlowLocationSync({
  recentPages,
  setDiscoverFlowActive,
  addRecentPage,
}) {
  const location = useLocation();

  useEffect(() => {
    const pathname = location.pathname;
    const path = getDiscoverPathFromLocation(location);
    const normalizedPath = normalizeDiscoverPath(path);

    if (isDiscoverExitPath(pathname)) {
      setDiscoverFlowActive(false);
      return;
    }

    if (isDiscoverHomePath(pathname)) {
      return;
    }

    if (recentPages.some((entry) => entry.path === normalizedPath)) {
      setDiscoverFlowActive(true);
      return;
    }

    if (isDiscoverBrowsePath(pathname) && shouldTrackDiscoverPath(path)) {
      addRecentPage(normalizedPath, location.state || {});
    }
  }, [addRecentPage, location, recentPages, setDiscoverFlowActive]);

  return null;
}

export function DiscoverRecentProvider({ children }) {
  const location = useLocation();
  const [recentPages, setRecentPages] = useState(() => readDiscoverRecentPages());
  const [discoverFlowActive, setDiscoverFlowActiveState] = useState(() => readDiscoverFlowActive());

  const setDiscoverFlowActive = useCallback((active) => {
    writeDiscoverFlowActive(active);
    setDiscoverFlowActiveState(active);
  }, []);

  const syncFromStorage = useCallback(() => {
    setRecentPages(readDiscoverRecentPages());
    setDiscoverFlowActiveState(readDiscoverFlowActive());
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const onStorage = (event) => {
      if (
        event.key === null ||
        event.key === DISCOVER_RECENT_PAGES_KEY ||
        event.key === DISCOVER_FLOW_ACTIVE_KEY
      ) {
        syncFromStorage();
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [syncFromStorage]);

  const addRecentPage = useCallback(
    (path, state = {}) => {
      const normalizedPath = normalizeDiscoverPath(path);
      if (!normalizedPath || !shouldTrackDiscoverPath(normalizedPath)) return;

      const label = buildDiscoverRecentLabel(normalizedPath, state);
      const pageState = pickDiscoverRecentPageState(state);
      setRecentPages((current) => {
        if (
          current[0]?.path === normalizedPath &&
          current[0]?.label === label &&
          JSON.stringify(current[0]?.state || {}) === JSON.stringify(pageState) &&
          current.length <= DISCOVER_RECENT_PAGES_LIMIT
        ) {
          return current;
        }
        const next = [
          {
            id: normalizedPath,
            path: normalizedPath,
            label,
            state: pageState,
          },
          ...current.filter((entry) => entry.path !== normalizedPath),
        ].slice(0, DISCOVER_RECENT_PAGES_LIMIT);
        writeDiscoverRecentPages(next);
        return next;
      });
      setDiscoverFlowActive(true);
    },
    [setDiscoverFlowActive],
  );

  const clearRecentPages = useCallback(() => {
    writeDiscoverRecentPages([]);
    setRecentPages([]);
    setDiscoverFlowActive(false);
  }, [setDiscoverFlowActive]);

  const visibleRecentPages = useMemo(() => filterDiscoverRecentPages(recentPages), [recentPages]);

  const shouldRecordNavigation = useCallback(
    (fromLocation = location) =>
      shouldRecordDiscoverNavigation(fromLocation, visibleRecentPages, discoverFlowActive),
    [discoverFlowActive, location, visibleRecentPages],
  );

  const isDiscoverDiscoverSubnavPage = useMemo(() => {
    const sp = new URLSearchParams(location.search);
    const type = sp.get("type");
    return location.pathname === "/search" && (type === "recommended" || type === "trending");
  }, [location.pathname, location.search]);

  const isDiscoverSectionActive = useMemo(
    () =>
      isDiscoverDiscoverSubnavPage ||
      isDiscoverBrowsePath(location.pathname) ||
      shouldKeepDiscoverSectionActive(location, visibleRecentPages, discoverFlowActive),
    [discoverFlowActive, isDiscoverDiscoverSubnavPage, location, visibleRecentPages],
  );

  const value = useMemo(
    () => ({
      recentPages: visibleRecentPages,
      discoverFlowActive,
      isDiscoverSectionActive,
      addRecentPage,
      clearRecentPages,
      shouldRecordNavigation,
    }),
    [
      addRecentPage,
      clearRecentPages,
      discoverFlowActive,
      isDiscoverSectionActive,
      visibleRecentPages,
      shouldRecordNavigation,
    ],
  );

  return (
    <DiscoverRecentContext.Provider value={value}>
      <DiscoverFlowLocationSync
        recentPages={recentPages}
        setDiscoverFlowActive={setDiscoverFlowActive}
        addRecentPage={addRecentPage}
      />
      {children}
    </DiscoverRecentContext.Provider>
  );
}

export function useDiscoverRecent() {
  const context = useContext(DiscoverRecentContext);
  if (!context) {
    throw new Error("useDiscoverRecent must be used within DiscoverRecentProvider");
  }
  return context;
}

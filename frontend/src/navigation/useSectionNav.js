import { useMemo } from "react";
import { useLocation } from "react-router";
import { useAuth } from "../contexts/AuthContext";
import { ACTIVITY_VIEWS, buildActivityPath, WANTED_VIEWS } from "./activityNavConfig";
import { LIBRARY_VIEWS } from "./libraryNavConfig";
import { DEFAULT_SHOWS_FILTER, SHOWS_FILTERS } from "./showsNavConfig";

const DISCOVER_BROWSE_TYPES = new Set(["recommended", "trending"]);

function firstSegment(pathname, prefix) {
  return pathname.slice(prefix.length).replace(/^\//, "").split("/")[0];
}

export function useSectionNav() {
  const { pathname, search } = useLocation();
  const { user, bootstrap } = useAuth();

  return useMemo(() => {
    const allowed = (permission) =>
      !permission || user?.role === "admin" || !!user?.permissions?.[permission];
    const searchType = new URLSearchParams(search).get("type");

    const isDiscoverBrowse =
      pathname === "/" ||
      pathname === "/discover/playlists" ||
      pathname === "/discover/news" ||
      (pathname === "/search" && DISCOVER_BROWSE_TYPES.has(searchType));
    if (isDiscoverBrowse) {
      const items = [
        { id: "home", label: "For you", path: "/", active: pathname === "/" },
        {
          id: "playlists",
          label: "Playlists",
          path: "/discover/playlists",
          active: pathname === "/discover/playlists",
        },
        {
          id: "recommended",
          label: "Recommended",
          path: "/search?type=recommended",
          active: pathname === "/search" && searchType === "recommended",
        },
        {
          id: "trending",
          label: "Trending",
          path: "/search?type=trending",
          active: pathname === "/search" && searchType === "trending",
        },
      ];
      if (bootstrap?.newsConfigured) {
        items.push({
          id: "news",
          label: "News",
          path: "/discover/news",
          active: pathname === "/discover/news",
        });
      }
      return { id: "discover", label: "Discover views", items };
    }

    if (pathname === "/library" || /^\/library\/[^/]+$/.test(pathname)) {
      const segment = firstSegment(pathname, "/library");
      const items = [
        { id: "home", label: "Overview", path: "/library", active: !segment },
        ...LIBRARY_VIEWS.filter((view) => allowed(view.permission)).map((view) => ({
          id: view.id,
          label: view.label,
          path: view.path,
          active: segment === view.id,
        })),
      ];
      return { id: "library", label: "Library views", items };
    }

    if (pathname.startsWith("/activity/")) {
      const segment = firstSegment(pathname, "/activity");
      const wantedTab = new URLSearchParams(search).get("tab") === "cutoff" ? "cutoff" : "missing";
      const items = ACTIVITY_VIEWS.filter((view) => view.id !== "missing").map((view) => ({
        id: view.id,
        label: view.label,
        path: buildActivityPath(view.id),
        active: segment === view.id,
      }));
      if (allowed("accessPlaylists")) {
        items.push(
          ...WANTED_VIEWS.map((view) => ({
            id: `wanted-${view.id}`,
            label: view.label,
            path: view.path,
            active: segment === "missing" && wantedTab === view.id,
          })),
        );
      }
      return { id: "activity", label: "Activity views", items };
    }

    if (pathname.startsWith("/shows")) {
      const segment = firstSegment(pathname, "/shows") || DEFAULT_SHOWS_FILTER;
      const items = SHOWS_FILTERS.map((filter) => ({
        id: filter.id,
        label: filter.label,
        path: `/shows/${filter.id}`,
        active: segment === filter.id,
      }));
      return { id: "shows", label: "Show filters", items };
    }

    return null;
  }, [bootstrap?.newsConfigured, pathname, search, user]);
}

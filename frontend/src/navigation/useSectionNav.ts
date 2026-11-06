import { useMemo } from "react";
import { useLocation } from "react-router";
import { useAuth } from "../contexts/AuthContext";
import { ACTIVITY_VIEWS, buildActivityPath, WANTED_VIEWS } from "./activityNavConfig";
import { LIBRARY_VIEWS } from "./libraryNavConfig";
import { lastRecommendedPath, RECOMMENDED_PATH } from "./recommendedPath";
import { DEFAULT_SHOWS_FILTER, SHOWS_FILTERS } from "./showsNavConfig";
import { resolveSection } from "./sectionParent.ts";

function firstSegment(pathname: string, prefix: string) {
  return pathname.slice(prefix.length).replace(/^\//, "").split("/")[0];
}

export function useSectionNav() {
  const { key, pathname, search } = useLocation();
  const { user, bootstrap } = useAuth();

  return useMemo(() => {
    const section = resolveSection(key, pathname);
    if (!section) return null;
    const { id, inherited } = section;
    const root = !inherited;
    const here = inherited ? "" : pathname;
    const allowed = (permission: string | undefined) =>
      !permission || user?.role === "admin" || !!user?.permissions?.[permission];

    if (id === "discover") {
      const items = [
        { id: "home", label: "For you", path: "/", active: here === "/" },
        {
          id: "playlists",
          label: "Playlists",
          path: "/discover/playlists",
          active: here.startsWith("/discover/playlists"),
        },
        {
          id: "recommended",
          label: "Recommended",
          path: lastRecommendedPath(here),
          active: here.startsWith(RECOMMENDED_PATH),
        },
        {
          id: "trending",
          label: "Trending",
          path: "/discover/trending",
          active: here.startsWith("/discover/trending"),
        },
      ];
      if (bootstrap?.newsConfigured) {
        items.push({
          id: "news",
          label: "News",
          path: "/discover/news",
          active: here === "/discover/news",
        });
      }
      return { id, root, title: "Discover", label: "Discover views", items };
    }

    if (id === "library") {
      const segment = inherited ? undefined : firstSegment(pathname, "/library");
      const items = [
        { id: "home", label: "Overview", path: "/library", active: segment === "" },
        ...LIBRARY_VIEWS.filter((view) => allowed(view.permission)).map((view) => ({
          id: view.id,
          label: view.label,
          path: view.path,
          active: segment === view.id,
        })),
      ];
      return { id, root, title: "Library", label: "Library views", items };
    }

    if (id === "activity") {
      const segment = inherited ? undefined : firstSegment(pathname, "/activity");
      const wantedTab = new URLSearchParams(search).get("tab") === "cutoff" ? "cutoff" : "missing";
      const items = ACTIVITY_VIEWS.filter((view) => view.id !== "missing").map((view) => ({
        id: view.id,
        label: view.label,
        path: buildActivityPath(view.id),
        active: segment === view.id,
      }));
      if (allowed("accessFlow")) {
        items.push(
          ...WANTED_VIEWS.map((view) => ({
            id: `wanted-${view.id}`,
            label: view.label,
            path: view.path,
            active: segment === "missing" && wantedTab === view.id,
          })),
        );
      }
      return { id, root, title: "Activity", label: "Activity views", items };
    }

    const segment = inherited
      ? undefined
      : firstSegment(pathname, "/shows") || DEFAULT_SHOWS_FILTER;
    const items = SHOWS_FILTERS.map((filter) => ({
      id: filter.id,
      label: filter.label,
      path: `/shows/${filter.id}`,
      active: segment === filter.id,
    }));
    return { id, root, title: "Shows", label: "Show filters", items };
  }, [bootstrap?.newsConfigured, key, pathname, search, user]);
}

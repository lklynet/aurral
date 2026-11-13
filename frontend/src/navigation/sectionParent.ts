export type SectionId = "discover" | "library" | "activity" | "shows";

function sectionOf(pathname: string): SectionId | "none" | "parent" {
  if (
    pathname === "/" ||
    /^\/discover\/playlists(\/[^/]+)?$/.test(pathname) ||
    pathname === "/discover/news" ||
    pathname === "/discover/releases" ||
    pathname.startsWith("/discover/trending") ||
    pathname.startsWith("/discover/recommended")
  ) {
    return "discover";
  }
  if (/^\/library(\/[^/]+)?$/.test(pathname)) return "library";
  if (pathname.startsWith("/activity/")) return "activity";
  if (pathname.startsWith("/shows")) return "shows";
  if (pathname.startsWith("/flows")) return "none";
  return "parent";
}

export function createSectionParents() {
  const parents = new Map<string, SectionId>();
  let last: SectionId = "discover";

  return (entryKey: string, pathname: string) => {
    const section = sectionOf(pathname);
    if (section === "none") {
      last = "discover";
      return null;
    }
    if (section !== "parent") {
      last = section;
      return { id: section, inherited: false };
    }
    const id = parents.get(entryKey) ?? last;
    parents.set(entryKey, id);
    last = id;
    return { id, inherited: true };
  };
}

export const resolveSection = createSectionParents();

export const DISCOVER_SECTION_IDS = [
  "recentlyAdded",
  "playlists",
  "recommendedShows",
  "recentReleases",
  "news",
  "recommended",
  "globalTop",
  "genreSections",
] as const;

export const DISCOVER_FEED_STYLES = ["list", "square", "wide"] as const;

export type DiscoverSectionId = (typeof DISCOVER_SECTION_IDS)[number];
export type DiscoverFeedStyle = (typeof DISCOVER_FEED_STYLES)[number];

export interface DiscoverLayoutEntry {
  id: DiscoverSectionId;
  enabled: boolean;
  style?: DiscoverFeedStyle;
}

const STYLED_SECTIONS: ReadonlySet<DiscoverSectionId> = new Set(["recommendedShows", "news"]);

const isSectionId = (value: unknown): value is DiscoverSectionId =>
  DISCOVER_SECTION_IDS.some((id) => id === value);

const isFeedStyle = (value: unknown): value is DiscoverFeedStyle =>
  DISCOVER_FEED_STYLES.some((style) => style === value);

export const isStyledSection = (id: DiscoverSectionId) => STYLED_SECTIONS.has(id);

export const normalizeDiscoverLayout = (value: unknown): DiscoverLayoutEntry[] | null => {
  if (!Array.isArray(value)) return null;
  const remaining = new Set<DiscoverSectionId>(DISCOVER_SECTION_IDS);
  const normalized: DiscoverLayoutEntry[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const id: unknown = "id" in item && typeof item.id === "string" ? item.id.trim() : null;
    if (!isSectionId(id) || !remaining.has(id)) continue;
    remaining.delete(id);
    const enabled = "enabled" in item && typeof item.enabled === "boolean" ? item.enabled : true;
    const style = "style" in item ? item.style : undefined;
    normalized.push(
      isStyledSection(id) && isFeedStyle(style) ? { id, enabled, style } : { id, enabled },
    );
  }
  for (const id of remaining) normalized.push({ id, enabled: true });
  return normalized;
};

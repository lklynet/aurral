export type ShowsFilterId = "all" | "library" | "discover";

export const SHOWS_FILTERS: { id: ShowsFilterId; label: string }[] = [
  { id: "all", label: "All" },
  { id: "library", label: "Library" },
  { id: "discover", label: "Discover" },
];

export const DEFAULT_SHOWS_FILTER: ShowsFilterId = "all";

export function normalizeShowsFilter(filter: string | null | undefined) {
  if (!filter) return DEFAULT_SHOWS_FILTER;
  return SHOWS_FILTERS.find((entry) => entry.id === filter)?.id ?? DEFAULT_SHOWS_FILTER;
}

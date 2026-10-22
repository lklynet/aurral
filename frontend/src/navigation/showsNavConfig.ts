export const SHOWS_FILTERS = [
  { id: "all", label: "All" },
  { id: "library", label: "Library" },
  { id: "discover", label: "Discover" },
];

export const DEFAULT_SHOWS_FILTER = "all";

export function normalizeShowsFilter(filter) {
  if (!filter) return DEFAULT_SHOWS_FILTER;
  return SHOWS_FILTERS.some((entry) => entry.id === filter) ? filter : DEFAULT_SHOWS_FILTER;
}

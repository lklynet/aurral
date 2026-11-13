import type { StaticPlaylist } from "./playlistStats.ts";

export const applyCustomOrder = <T extends { id: string }>(
  items: readonly T[],
  order: readonly string[],
) => {
  const rank = new Map(order.map((id, index) => [id, index]));
  const rankOf = (item: T) => rank.get(item.id) ?? order.length;
  return [...items].sort((left, right) => rankOf(left) - rankOf(right));
};

export const PLAYLIST_SORT_OPTIONS = [
  { value: "name", label: "Name" },
  { value: "created", label: "Date created" },
  { value: "edited", label: "Last edited" },
] as const;

export type PlaylistSort = (typeof PLAYLIST_SORT_OPTIONS)[number]["value"];
export type SortDirection = "asc" | "desc";

export const DEFAULT_PLAYLIST_SORT: PlaylistSort = "created";

const DEFAULT_DIRECTION: Record<PlaylistSort, SortDirection> = {
  name: "asc",
  created: "asc",
  edited: "desc",
};

export const readPlaylistSort = (params: URLSearchParams) => {
  const sort =
    PLAYLIST_SORT_OPTIONS.find((option) => option.value === params.get("sort"))?.value ??
    DEFAULT_PLAYLIST_SORT;
  const dir = params.get("dir");
  const direction: SortDirection = dir === "asc" || dir === "desc" ? dir : DEFAULT_DIRECTION[sort];
  return { sort, direction };
};

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

export const sortPlaylists = <T extends Pick<StaticPlaylist, "name" | "createdAt" | "updatedAt">>(
  playlists: readonly T[],
  sort: PlaylistSort,
  direction: SortDirection,
) => {
  const sorted = [...playlists].sort((left, right) => {
    if (sort === "name") return collator.compare(left.name, right.name);
    if (sort === "edited") return left.updatedAt - right.updatedAt;
    return left.createdAt - right.createdAt;
  });
  return direction === "asc" ? sorted : sorted.reverse();
};

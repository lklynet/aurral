const STATUS_SORT_ORDER: Partial<Record<string, number>> = {
  pending: 0,
  downloading: 1,
  done: 2,
  failed: 3,
  draft: 4,
};

interface SortableTrack {
  id: string;
  trackName?: string | null;
  artistName?: string | null;
  albumName?: string | null;
  releaseYear?: string | null;
  status?: string | null;
}

const compareText = (left: string | null | undefined, right: string | null | undefined) =>
  String(left || "").localeCompare(String(right || ""), undefined, {
    sensitivity: "base",
  });

const statusRank = (status: string | null | undefined) =>
  STATUS_SORT_ORDER[String(status || "").toLowerCase()] ?? 99;

export function sortPlaylistTracks<T extends SortableTrack>(
  tracks: T[],
  sortKey: string,
  sortDirection: string,
): T[] {
  const originalIndexById = new Map<string, number>(
    tracks.map((track, index): [string, number] => [track.id, index]),
  );
  const direction = sortDirection === "desc" ? -1 : 1;

  const originalIndexDiff = (left: T, right: T) =>
    (originalIndexById.get(left.id) ?? 0) - (originalIndexById.get(right.id) ?? 0);

  return [...tracks].sort((left, right) => {
    let diff: number;
    switch (sortKey) {
      case "song":
        diff = compareText(left.trackName, right.trackName);
        break;
      case "artist":
        diff = compareText(left.artistName, right.artistName);
        break;
      case "album":
        diff = compareText(left.albumName || "Unknown Album", right.albumName || "Unknown Album");
        break;
      case "year":
        diff = compareText(left.releaseYear, right.releaseYear);
        break;
      case "status":
        diff = statusRank(left.status) - statusRank(right.status);
        break;
      case "index":
      default:
        diff = originalIndexDiff(left, right);
        break;
    }

    if (diff === 0) {
      diff = originalIndexDiff(left, right);
    }

    return diff * direction;
  });
}

export const matchesPlaylistTrackQuery = (track: SortableTrack, normalizedQuery: string) =>
  [track.trackName, track.artistName, track.albumName].some((value) =>
    String(value || "")
      .toLocaleLowerCase()
      .includes(normalizedQuery),
  );

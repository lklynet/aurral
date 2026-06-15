const STATUS_SORT_ORDER = {
  pending: 0,
  downloading: 1,
  done: 2,
  failed: 3,
  draft: 4,
};

const compareText = (left, right) =>
  String(left || "").localeCompare(String(right || ""), undefined, {
    sensitivity: "base",
  });

const statusRank = (status) =>
  STATUS_SORT_ORDER[String(status || "").toLowerCase()] ?? 99;

export function sortFlowTracks(tracks, sortKey, sortDirection) {
  const originalIndexById = new Map(
    tracks.map((track, index) => [track.id, index]),
  );
  const direction = sortDirection === "desc" ? -1 : 1;

  const originalIndexDiff = (left, right) =>
    (originalIndexById.get(left.id) ?? 0) -
    (originalIndexById.get(right.id) ?? 0);

  return [...tracks].sort((left, right) => {
    let diff;
    switch (sortKey) {
      case "song":
        diff = compareText(left.trackName, right.trackName);
        break;
      case "artist":
        diff = compareText(left.artistName, right.artistName);
        break;
      case "album":
        diff = compareText(
          left.albumName || "Unknown Album",
          right.albumName || "Unknown Album",
        );
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

export function getFlowTrackDisplayNumber(
  track,
  { tracks, sortedTracks, sortedIndex, sortKey, sortDirection },
) {
  const originalNumber =
    tracks.findIndex((item) => item.id === track.id) + 1;

  if (sortKey !== "index") {
    return originalNumber;
  }

  if (sortDirection === "desc") {
    return sortedTracks.length - sortedIndex;
  }

  return sortedIndex + 1;
}

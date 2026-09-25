import path from "node:path";
import { getCanonicalLibraryForTrackIds } from "./libraryQueryService.js";
import { isAurralOwnedPath } from "./qualityProfileService.js";
import { downloadTracker } from "./weeklyFlow/weeklyFlowDownloadTracker.js";

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function resolveAurralOwnedTrackJob({ trackId, albumId } = {}) {
  const safeTrackId = positiveInteger(trackId);
  const safeAlbumId = albumId == null || String(albumId).trim() === ""
    ? null
    : positiveInteger(albumId);
  if (!safeTrackId || (albumId != null && String(albumId).trim() && !safeAlbumId)) {
    return null;
  }

  const library = getCanonicalLibraryForTrackIds({
    source: "aurral",
    availableOnly: true,
    ids: [safeTrackId],
    albumId: safeAlbumId,
  });
  const track = library.tracks.find((entry) => Number(entry.id) === safeTrackId);
  const ownedPaths = new Set(
    (track?.files || [])
      .filter((file) => file.source === "aurral" && file.available && file.path)
      .map((file) => path.resolve(file.path))
      .filter(isAurralOwnedPath),
  );
  if (!ownedPaths.size) return null;

  return downloadTracker
    .getAll()
    .filter(
      (job) =>
        job.status === "done" &&
        job.managedBy === "aurral" &&
        !job.upgradeForJobId &&
        job.finalPath &&
        ownedPaths.has(path.resolve(job.finalPath)) &&
        isAurralOwnedPath(job.finalPath),
    )
    .sort(
      (left, right) =>
        Number(right.completedAt || right.createdAt || 0) -
        Number(left.completedAt || left.createdAt || 0),
    )[0] || null;
}

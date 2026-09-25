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
  const ownedFiles = (track?.files || [])
    .filter((file) => file.source === "aurral" && file.available && file.path)
    .map((file) => ({ ...file, resolvedPath: path.resolve(file.path) }))
    .filter((file) => isAurralOwnedPath(file.resolvedPath));
  if (ownedFiles.length === 0) return null;

  const sourceJob = downloadTracker
    .getAll()
    .filter(
      (job) =>
        job.status === "done" &&
        job.managedBy === "aurral" &&
        !job.upgradeForJobId &&
        job.finalPath &&
        ownedFiles.some((file) => file.resolvedPath === path.resolve(job.finalPath)) &&
        isAurralOwnedPath(job.finalPath),
    )
    .sort(
      (left, right) =>
        Number(right.completedAt || right.createdAt || 0) -
        Number(left.completedAt || left.createdAt || 0),
    )[0];
  if (sourceJob) return sourceJob;

  const sourceFile = [...ownedFiles].sort(
    (left, right) =>
      Number(right.mtimeMs || right.createdAt || 0) -
      Number(left.mtimeMs || left.createdAt || 0),
  )[0];
  const album = library.albums.find(
    (entry) => String(entry.id) === String(sourceFile.albumId),
  );
  const artist = library.artists.find(
    (entry) => String(entry.id) === String(album?.artistId),
  );
  const albumTrack = track?.albums?.find(
    (entry) => String(entry.albumId) === String(sourceFile.albumId),
  );
  const releaseYear = String(album?.releaseDate || "").match(/^\d{4}/)?.[0] || null;

  return downloadTracker.ensureLibraryTrackJob(
    {
      artistName: artist?.name || album?.albumArtist || track?.artistName || "Unknown Artist",
      trackName: track?.title,
      albumName: album?.title || null,
      artistMbid: artist?.mbid || null,
      albumMbid: album?.mbid || album?.releaseGroupMbid || null,
      trackMbid: track?.mbid || null,
      releaseYear,
      durationMs: sourceFile.durationMs ?? track?.metadata?.durationMs ?? null,
      trackNumber: albumTrack?.trackNumber || 0,
      albumTrackCount: album?.trackIds?.length || null,
      artistAliases: Array.isArray(artist?.metadata?.aliases)
        ? artist.metadata.aliases
        : [],
      managedBy: "aurral",
    },
    sourceFile.resolvedPath,
  );
}

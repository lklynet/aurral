import path from "node:path";
import { getLibraryForAlbumIds, getLibraryForTrackIds } from "./libraryQueryService.ts";
import { isAurralOwnedPath } from "./qualityProfileService.ts";
import { downloadTracker } from "./downloadJobs/downloadTracker.ts";

function positiveInteger(value: unknown) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function resolveAurralOwnedTrackJob({
  trackId,
  albumId,
}: { trackId?: unknown; albumId?: unknown } = {}) {
  const safeTrackId = positiveInteger(trackId);
  const safeAlbumId =
    albumId == null || String(albumId).trim() === "" ? null : positiveInteger(albumId);
  if (!safeTrackId || (albumId != null && String(albumId).trim() && !safeAlbumId)) {
    return null;
  }

  const library = getLibraryForTrackIds({
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
        ownedFiles.some((file) => file.resolvedPath === path.resolve(job.finalPath!)) &&
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
      Number(right.mtimeMs || right.createdAt || 0) - Number(left.mtimeMs || left.createdAt || 0),
  )[0];
  const album = library.albums.find((entry) => String(entry.id) === String(sourceFile.albumId));
  const artist = library.artists.find((entry) => String(entry.id) === String(album?.artistId));
  const albumTrack = track?.albums?.find(
    (entry) => String(entry.albumId) === String(sourceFile.albumId),
  );
  const releaseYear = String(album?.releaseDate || "").match(/^\d{4}/)?.[0] || null;
  const albumTracks = album
    ? getLibraryForAlbumIds({ ids: [album.id] })
        .tracks.map((entry) => ({
          title: entry.title,
          position: entry.albums.find((place) => String(place.albumId) === String(album.id)),
        }))
        .filter((entry) => entry.title && entry.position)
        .sort(
          (left, right) =>
            Number(left.position!.discNumber || 1) - Number(right.position!.discNumber || 1) ||
            Number(left.position!.trackNumber || 0) - Number(right.position!.trackNumber || 0),
        )
    : [];

  return downloadTracker.ensureLibraryTrackJob(
    {
      artistName: artist?.name || album?.albumArtist || track?.artistName || "Unknown Artist",
      trackName: track?.title,
      albumName: album?.title || null,
      artistMbid: artist?.mbid || null,
      albumMbid: album?.releaseGroupMbid || album?.mbid || null,
      trackMbid: track?.mbid || null,
      releaseYear,
      durationMs: sourceFile.durationMs ?? track?.metadata?.durationMs ?? null,
      trackNumber: albumTrack?.trackNumber || 0,
      discNumber: albumTrack?.discNumber || null,
      albumTrackCount: albumTracks.length || null,
      albumTrackTitles: albumTracks.map((entry) => entry.title),
      artistAliases: Array.isArray(artist?.metadata?.aliases) ? artist.metadata.aliases : [],
      managedBy: "aurral",
    },
    sourceFile.resolvedPath,
  );
}

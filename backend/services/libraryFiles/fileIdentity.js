import path from "node:path";
import { parseFile } from "music-metadata";
import { db } from "../../config/db-sqlite.js";
import { resolveDownloadRoot } from "../downloadPaths.js";
import { downloadTracker } from "../downloadJobs/downloadTracker.js";
import { applyMetadataEnrichment, buildMetadataRecord, scanMusicRoot } from "../libraryFileScanner.js";
import { activeLidarrRoots, createLibraryScanExclusion } from "../libraryFolders.js";
import {
  findLibraryAlbumByArtistTitle,
  findLibraryAlbumByReleaseMbid,
  getLibraryMediaFile,
  moveLibraryMediaFilePath,
  rekeyLibraryAlbum,
  rekeyLibraryTrack,
  unlinkLibraryAlbumTrackWithoutMedia,
} from "../libraryMediaStore.js";

function jobMetadata(filePath) {
  const job = downloadTracker.getAll().find((entry) =>
    entry.status === "done" && entry.finalPath && path.resolve(entry.finalPath) === filePath);
  return job ? {
    artistName: job.artistName,
    albumName: job.albumName,
    trackName: job.trackName,
    artistMbid: job.artistMbid,
    albumMbid: job.albumMbid,
    trackMbid: job.trackMbid,
    releaseYear: job.releaseYear,
    trackNumber: job.trackNumber,
  } : null;
}

// An upgraded file with new identity tags keeps the Library's track and
// album rows, with their favorites, play counts, and monitoring, under the
// identity the scan now reads.
export async function adoptLibraryFileIdentity(filePath, { previousPath = filePath } = {}) {
  const root = path.resolve(resolveDownloadRoot());
  const current = path.resolve(filePath);
  const previous = path.resolve(previousPath);
  if (previous !== current) moveLibraryMediaFilePath("aurral", previous, current);
  const media = getLibraryMediaFile({ source: "aurral", path: current });
  const enrichment = jobMetadata(current);
  if (media) {
    const metadata = await parseFile(current, { skipCovers: true });
    const record = buildMetadataRecord(applyMetadataEnrichment(metadata, enrichment), current, root);
    const releaseAlbum = findLibraryAlbumByReleaseMbid(record.releaseGroupMbid);
    const artistId = db.prepare("SELECT artist_id FROM library_albums WHERE id = ?").get(media.album_id)?.artist_id;
    const namedAlbum = !record.releaseGroupMbid && !record.albumMbid && artistId
      ? findLibraryAlbumByArtistTitle(artistId, record.albumName)
      : null;
    const albumKey = (releaseAlbum || namedAlbum)?.identity_key || record.albumKey;
    if (media.album_id) rekeyLibraryAlbum(media.album_id, albumKey);
    rekeyLibraryTrack(media.track_id, record.trackKey);
  }
  const before = getLibraryMediaFile({ source: "aurral", path: current });
  await scanMusicRoot({
    rootPath: root,
    source: "aurral",
    filePaths: [current],
    force: true,
    metadataEnricher: () => enrichment,
    isExcluded: createLibraryScanExclusion("aurral", { downloadRoot: root, lidarrRoots: activeLidarrRoots(null) }),
  });
  const after = getLibraryMediaFile({ source: "aurral", path: current });
  if (before?.album_id && after?.album_id && before.album_id !== after.album_id) {
    unlinkLibraryAlbumTrackWithoutMedia(before.album_id, after.track_id);
  }
}

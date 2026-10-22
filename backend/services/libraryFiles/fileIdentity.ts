import path from "node:path";
import { parseFile } from "music-metadata";
import { db } from "../../config/db-sqlite.ts";
import type { LibraryAlbumsRow } from "../../db/rows.ts";
import { resolveDownloadRoot } from "../downloadPaths.ts";
import { downloadTracker } from "../downloadJobs/downloadTracker.ts";
import {
  applyMetadataEnrichment,
  buildMetadataRecord,
  scanMusicRoot,
} from "../libraryFileScanner.ts";
import {
  activeLidarrRoots,
  createLibraryScanExclusion,
  readOnlyFolderPaths,
} from "../libraryFolders.ts";
import {
  findLibraryAlbumByArtistTitle,
  findLibraryAlbumByReleaseMbid,
  getLibraryMediaFile,
  moveLibraryMediaFilePath,
  rekeyLibraryAlbum,
  rekeyLibraryTrack,
  unlinkLibraryAlbumTrackWithoutMedia,
} from "../libraryMediaStore.ts";

function jobMetadata(filePath: string) {
  const job = downloadTracker
    .getAll()
    .find(
      (entry) =>
        entry.status === "done" && entry.finalPath && path.resolve(entry.finalPath) === filePath,
    );
  return job
    ? {
        artistName: job.artistName,
        albumName: job.albumName,
        trackName: job.trackName,
        artistMbid: job.artistMbid,
        albumMbid: job.albumMbid,
        trackMbid: job.trackMbid,
        releaseYear: job.releaseYear,
        trackNumber: job.trackNumber,
        discNumber: job.discNumber,
      }
    : null;
}

// An upgraded file with new identity tags keeps the Library's track and
// album rows, with their favorites, play counts, and monitoring, under the
// identity the scan now reads.
export async function adoptLibraryFileIdentity(
  filePath: string,
  { previousPath = filePath }: { previousPath?: string } = {},
) {
  const root = path.resolve(resolveDownloadRoot());
  const current = path.resolve(filePath);
  const previous = path.resolve(previousPath);
  if (previous !== current) moveLibraryMediaFilePath("aurral", previous, current);
  const media = getLibraryMediaFile({ source: "aurral", path: current });
  const enrichment = jobMetadata(current);
  if (media) {
    const metadata = await parseFile(current, { skipCovers: true });
    const record = buildMetadataRecord(
      applyMetadataEnrichment(metadata, enrichment),
      current,
      root,
    );
    const releaseAlbum = findLibraryAlbumByReleaseMbid(record.releaseGroupMbid);
    const artistId = db
      .prepare<[number | null], Pick<LibraryAlbumsRow, "artist_id">>(
        "SELECT artist_id FROM library_albums WHERE id = ?",
      )
      .get(media.album_id)?.artist_id;
    const namedAlbum =
      !record.releaseGroupMbid && !record.albumMbid && artistId
        ? findLibraryAlbumByArtistTitle(artistId, record.albumName)
        : null;
    const albumKey = (releaseAlbum || namedAlbum)?.identity_key || record.albumKey;
    if (media.album_id && albumKey) rekeyLibraryAlbum(media.album_id, albumKey);
    if (record.trackKey) rekeyLibraryTrack(media.track_id, record.trackKey);
  }
  const before = getLibraryMediaFile({ source: "aurral", path: current });
  await scanMusicRoot({
    rootPath: root,
    source: "aurral",
    filePaths: [current],
    force: true,
    metadataEnricher: () => enrichment,
    isExcluded: createLibraryScanExclusion("aurral", {
      downloadRoot: root,
      lidarrRoots: activeLidarrRoots(null),
      readOnlyRoots: readOnlyFolderPaths(),
    }),
  });
  const after = getLibraryMediaFile({ source: "aurral", path: current });
  if (before?.album_id && after?.album_id && before.album_id !== after.album_id) {
    unlinkLibraryAlbumTrackWithoutMedia(before.album_id, after.track_id);
  }
}

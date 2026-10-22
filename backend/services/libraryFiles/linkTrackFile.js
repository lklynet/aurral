import fs from "node:fs/promises";
import path from "node:path";
import { db } from "../../config/db-sqlite.js";
import { buildLibraryTrackPath, isPathInsideRoot, resolveDownloadRoot } from "../downloadPaths.js";
import { buildResolvedJobTrack, writeAudioMetadata } from "../downloadUtils.js";
import { AUDIO_EXTENSIONS } from "../libraryFileScanner.js";
import { configuredLidarrFolders, isPathWithin, libraryFolderOwner } from "../libraryFolders.js";
import { getLibraryMediaFile, isSameLibraryName } from "../libraryMediaStore.js";
import { createCleanupContext, renameLibraryFile } from "./cleanup.js";
import { adoptLibraryFileIdentity } from "./fileIdentity.js";
import {
  LINKED_FOLDER_REASON,
  passesThroughLinkedFolder,
  placeFile,
  removeEmptyDirectories,
  transferSidecars,
} from "./fileTransfer.js";
import { IngestSourceError } from "./ingest.js";
import { OperationConflictError, getActiveLibraryFileOperation } from "./operationStore.js";

const TAKEN_NAME_REASON = "Another file already has this track's name in the Library.";

// A file the user says is a track is filed and tagged like a download of that
// track. A file in the Downloads Folder moves to the track's name and keeps its
// favorites and play counts. A file from anywhere else is copied in, since
// Aurral does not remove music from folders it does not own.
export async function linkTrackFile({ sourcePath, track } = {}) {
  const active = getActiveLibraryFileOperation();
  if (active) throw new OperationConflictError(active);
  const metadata = buildResolvedJobTrack({}, track);
  if (!metadata.artistName || !metadata.albumName || !metadata.trackName || !metadata.trackMbid) {
    throw new IngestSourceError("The track has no artist, album, title, or MusicBrainz ID.");
  }
  const requested = String(sourcePath || "").trim();
  const stat = path.isAbsolute(requested) ? await fs.lstat(requested).catch(() => null) : null;
  if (!stat?.isFile() || !AUDIO_EXTENSIONS.has(path.extname(requested).toLowerCase())) {
    throw new IngestSourceError("Choose a music file.");
  }
  const root = path.resolve(resolveDownloadRoot());
  // The file browser lists real paths, and the Library keeps the Downloads
  // Folder's own, which can be a link.
  const realRoot = await fs.realpath(root).catch(() => root);
  const source = isPathWithin(realRoot, requested)
    ? path.join(root, path.relative(realRoot, requested))
    : path.resolve(requested);
  const owned =
    libraryFolderOwner(source, {
      downloadRoot: root,
      lidarrRoots: configuredLidarrFolders(null),
    }) === "aurral";
  const target = buildLibraryTrackPath(root, metadata, path.extname(source));
  if (!isPathInsideRoot(target, root)) {
    throw new IngestSourceError("The track's name does not fit inside the Downloads Folder.");
  }
  if (await passesThroughLinkedFolder(root, target)) {
    throw new IngestSourceError(LINKED_FOLDER_REASON);
  }
  try {
    if (!owned) {
      await placeFile(source, target, "copy");
      await transferSidecars(source, target, "copy").catch(() => {});
    } else if (source !== target) {
      const context = createCleanupContext();
      await context.prepare();
      await renameLibraryFile(source, target, context);
    }
  } catch (error) {
    if (error?.code === "EEXIST") throw new IngestSourceError(TAKEN_NAME_REASON);
    throw error;
  }
  // The untagged album the file was in is this album when its artist and title
  // agree, and becomes it, so its other tracks stay with it. A file from
  // another album, such as Unknown Album, leaves that album as it was.
  const album = db
    .prepare(
      `SELECT album.title, album.release_group_mbid, artist.name AS artist_name
     FROM library_albums AS album JOIN library_artists AS artist ON artist.id = album.artist_id
     WHERE album.id = ?`,
    )
    .get(getLibraryMediaFile({ source: "aurral", path: target })?.album_id ?? null);
  const sameAlbum =
    Boolean(album) &&
    !album.release_group_mbid &&
    isSameLibraryName(album.artist_name, metadata.artistName) &&
    isSameLibraryName(album.title, metadata.albumName);
  await writeAudioMetadata(target, metadata);
  await adoptLibraryFileIdentity(target, { rekeyAlbum: sameAlbum });
  if (owned) await removeEmptyDirectories(path.dirname(source), root);
  return { path: target, moved: owned };
}

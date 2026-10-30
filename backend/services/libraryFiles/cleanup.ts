import fs from "node:fs/promises";
import path from "node:path";
import type { Stats } from "node:fs";
import { asAppError } from "../../../lib/errors.ts";
import { parseFile } from "music-metadata";
import { db } from "../../config/db-sqlite.ts";
import type { LibraryAlbumsRow, LibraryArtistsRow, LibraryMediaFilesRow } from "../../db/rows.ts";
import {
  buildLibraryTrackPath,
  findLibraryFileVariant,
  isPathInsideRoot,
  libraryPathKey,
  resolveDownloadRoot,
} from "../downloadPaths.ts";
import { downloadTracker } from "../downloadJobs/downloadTracker.ts";
import { writeAudioTags } from "../audioTags.ts";
import { buildMetadataRecord } from "../libraryFileScanner.ts";
import { configuredLidarrFolders, libraryFolderOwner } from "../libraryFolders.ts";
import {
  getLibraryMediaFile,
  moveLibraryMediaFilePath,
  removeLibraryMediaFiles,
} from "../libraryMediaStore.ts";
import type { createPlaybackDeletionGuard } from "../playback/playbackFileRetention.ts";
import { adoptLibraryFileIdentity } from "./fileIdentity.ts";
import {
  ALBUM_IMAGE_EXTENSIONS,
  LINKED_FOLDER_REASON,
  filesIdentical,
  isSameFile,
  passesThroughLinkedFolder,
  placeFile,
  removeEmptyDirectories,
  transferSidecars,
} from "./fileTransfer.ts";
import {
  SAME_LENGTH_MS,
  type Recording,
  compareQuality,
  differentTracks,
  formatGap,
  readRecording,
} from "./recordings.ts";
import { planTagFill } from "./tagFill.ts";
import {
  addLibraryFileOperationItems,
  type CleanupOperation,
  type listLibraryFileOperationItems,
  restoreUnremovedDuplicates,
  updateLibraryFileOperation,
  updateLibraryFileOperationItem,
} from "./operationStore.ts";

const TAKEN_NAME_REASON = "Another file already has this name.";

type LibraryFileOperation = CleanupOperation;
type LibraryFileItem = ReturnType<typeof listLibraryFileOperationItems>[number];
type AlbumFileRow = Pick<
  LibraryMediaFilesRow,
  "id" | "path" | "track_id" | "album_id" | "size" | "mtime_ms" | "duration_ms"
> & { title: string; disc_number: number | null; track_number: number | null };
type TagFillAlbums = NonNullable<Parameters<typeof planTagFill>[1]>;
type CleanupPlanContext = {
  root: string;
  lidarrRoots: string[];
  albums: TagFillAlbums;
  targets: Map<string, string>;
};
type CleanupApplyContext = ReturnType<typeof createCleanupContext>;
type DeletionGuard = ReturnType<typeof createPlaybackDeletionGuard>;
type TagFillTags = NonNullable<Awaited<ReturnType<typeof planTagFill>>["tags"]>;
type TagPlan =
  | { reason: string | null; tags?: never }
  | { reason?: never; tags: TagFillTags; tagFields: string[]; hardlinked?: true };
function libraryAlbumIds() {
  return db
    .prepare<[], number>(
      `SELECT DISTINCT album_id FROM library_media_files
     WHERE source = 'aurral' AND available = 1 AND album_id IS NOT NULL
     ORDER BY album_id`,
    )
    .pluck()
    .all();
}

function albumFiles(
  albumId: number,
  { root, lidarrRoots }: { root: string; lidarrRoots: string[] },
) {
  const seen = new Set<number>();
  return db
    .prepare<[number], AlbumFileRow>(
      `SELECT media.id, media.path, media.track_id, media.album_id, media.size, media.mtime_ms,
       media.duration_ms, track.title,
       link.disc_number, link.track_number
     FROM library_media_files AS media
     JOIN library_tracks AS track ON track.id = media.track_id
     LEFT JOIN library_album_tracks AS link ON link.album_id = media.album_id AND link.track_id = media.track_id
     WHERE media.album_id = ? AND media.source = 'aurral' AND media.available = 1
     ORDER BY link.disc_number, link.track_number, media.path`,
    )
    .all(albumId)
    .filter((file) => {
      if (seen.has(file.id) || !isPathInsideRoot(path.resolve(file.path), root)) return false;
      if (libraryFolderOwner(file.path, { downloadRoot: root, lidarrRoots }) !== "aurral")
        return false;
      seen.add(file.id);
      return true;
    });
}

async function planTags(
  file: AlbumFileRow,
  album: LibraryAlbumsRow,
  artist: LibraryArtistsRow | undefined,
  context: CleanupPlanContext,
): Promise<TagPlan> {
  const fill = await planTagFill(
    {
      filePath: file.path,
      album: {
        releaseGroupMbid: album.release_group_mbid,
        releaseMbid: album.mbid,
        title: album.title,
        year: album.release_date,
      },
      artist: { name: artist?.name, mbid: artist?.mbid },
      file: {
        title: file.title,
        trackNumber: file.track_number,
        discNumber: file.disc_number,
        durationMs: file.duration_ms,
      },
    },
    context.albums,
  );
  if (!fill.tags) return { reason: fill.reason || null };
  const fileStat = await fs.stat(file.path).catch(() => null);
  const hardlinked = fileStat !== null && fileStat.nlink > 1;
  return { tags: fill.tags, tagFields: fill.fields, ...(hardlinked ? { hardlinked } : {}) };
}

// The album's numbering wins. A file the album has no number for keeps the
// number its tags or name give it, so Clean up never drops a track number.
async function trackPosition(file: AlbumFileRow, root: string) {
  if (file.track_number !== null && file.track_number > 0)
    return { trackNumber: file.track_number, discNumber: file.disc_number };
  const record = await parseFile(file.path, { skipCovers: true, duration: false }).then(
    (metadata) => buildMetadataRecord(metadata, file.path, root),
    () => null,
  );
  if (record && record.trackNumber != null && record.trackNumber > 0)
    return { trackNumber: record.trackNumber, discNumber: record.discNumber };
  return { trackNumber: file.track_number, discNumber: file.disc_number };
}

// The better copy of a track comes first, so it is the one that keeps the name.
async function rankCopies(files: AlbumFileRow[]) {
  const tracks = new Map<number, AlbumFileRow[]>();
  for (const file of files) tracks.set(file.track_id, [...(tracks.get(file.track_id) || []), file]);
  const ranked: AlbumFileRow[] = [];
  for (const copies of tracks.values()) {
    if (copies.length > 1) {
      const quality = new Map<AlbumFileRow, Recording>(
        await Promise.all(
          copies.map(async (file): Promise<[AlbumFileRow, Recording]> => [
            file,
            await readRecording(file.path),
          ]),
        ),
      );
      copies.sort((left, right) => compareQuality(quality.get(right)!, quality.get(left)!));
    }
    ranked.push(...copies);
  }
  return ranked;
}

const libraryTrackAt = (filePath: string) => {
  const media = getLibraryMediaFile({ source: "aurral", path: filePath });
  return media?.available === 1 ? media.track_id : null;
};

// A file whose name differs only in case holds the name too, as it does on a
// case-insensitive drive.
async function nameHolder(
  target: string,
  variant: string | null,
  file: AlbumFileRow,
  context: CleanupPlanContext,
) {
  const existing = variant && (await fs.lstat(variant).catch(() => null));
  const sameFile =
    existing &&
    (await fs
      .stat(file.path)
      .then((stat) => stat.ino === existing.ino && stat.dev === existing.dev)
      .catch(() => false));
  const onDisk = existing && !sameFile ? variant : null;
  const holder = onDisk || context.targets.get(target);
  return holder
    ? { path: holder, onDisk: holder === onDisk, trackId: libraryTrackAt(holder) }
    : null;
}

// Two Library files of one track are the same recording when their lengths
// agree, as ingest decides. The holder keeps the name unless this copy is better.
async function compareCopies(filePath: string, holderPath: string) {
  if (await filesIdentical(filePath, holderPath).catch(() => false)) {
    return {
      same: true,
      keepHolder: true,
      reason: "An exact copy of this file already has this name.",
    };
  }
  const [mine, theirs] = await Promise.all([readRecording(filePath), readRecording(holderPath)]);
  if (differentTracks(mine, theirs)) {
    return {
      same: false,
      reason: `Name conflict: these files have different track numbers, ${mine.trackNumber} and ${theirs.trackNumber}. Check their tags.`,
    };
  }
  if (mine.durationMs == null || theirs.durationMs == null) {
    return {
      same: false,
      reason: "Name conflict. Could not compare track lengths. Check both files.",
    };
  }
  const gap = mine.durationMs - theirs.durationMs;
  if (Math.abs(gap) > SAME_LENGTH_MS) {
    return {
      same: false,
      reason: `Name conflict. Track lengths differ by ${formatGap(gap)}. Check their tags.`,
    };
  }
  const keepHolder = compareQuality(theirs, mine) >= 0;
  return {
    same: true,
    keepHolder,
    reason: keepHolder
      ? "Another copy of this track, at least as good, already has this name."
      : null,
  };
}

async function planAlbum(albumId: number, context: CleanupPlanContext) {
  const album = db
    .prepare<[number], LibraryAlbumsRow>("SELECT * FROM library_albums WHERE id = ?")
    .get(albumId);
  if (!album) return { items: [], unchanged: 0 };
  const artist = db
    .prepare<[number], LibraryArtistsRow>("SELECT * FROM library_artists WHERE id = ?")
    .get(album.artist_id);
  const items = [];
  const settled = new Set<string>();
  const winners = new Map<string, string>();
  let unchanged = 0;
  for (const listed of await rankCopies(albumFiles(albumId, context))) {
    if (settled.has(path.resolve(listed.path))) continue;
    const position = await trackPosition(listed, context.root);
    const file = {
      ...listed,
      track_number: position.trackNumber,
      disc_number: position.discNumber,
    };
    const details = { size: file.size, mtimeMs: file.mtime_ms };
    const target = buildLibraryTrackPath(
      context.root,
      {
        artistName: artist?.name,
        albumName: album.title,
        trackName: file.title,
        trackNumber: file.track_number,
        discNumber: file.disc_number,
      },
      path.extname(file.path),
    );
    const variant = target === path.resolve(file.path) ? target : findLibraryFileVariant(target);
    let rename = variant !== path.resolve(file.path);
    if (rename && !isPathInsideRoot(target, context.root)) {
      items.push({
        sourcePath: file.path,
        status: "skipped",
        reason: "The new name does not fit inside the Downloads Folder.",
        details,
      });
      continue;
    }
    const winner = winners.get(target);
    const holder = !rename
      ? null
      : winner
        ? { path: winner, onDisk: false, trackId: libraryTrackAt(winner) }
        : await nameHolder(target, variant, file, context);
    if (holder) {
      const copy =
        holder.trackId === file.track_id ? await compareCopies(file.path, holder.path) : null;
      if (copy?.keepHolder) {
        items.push({
          sourcePath: file.path,
          targetPath: holder.onDisk ? holder.path : target,
          status: "duplicate",
          reason: copy.reason,
          details: { ...details, removable: true },
        });
        continue;
      }
      if (!copy?.same || !holder.onDisk) {
        items.push({
          sourcePath: file.path,
          targetPath: target,
          status: "conflict",
          reason: copy?.reason || TAKEN_NAME_REASON,
          details,
        });
        continue;
      }
      items.push({
        sourcePath: holder.path,
        targetPath: file.path,
        status: "duplicate",
        reason: "A better copy exists. Removing this file gives that copy this name.",
        details: { removable: true, takesName: true },
      });
      settled.add(holder.path);
      winners.set(target, file.path);
      rename = false;
    }
    const { reason, ...fill } = await planTags(file, album, artist, context);
    const actions = [fill.tags && "tags", rename && "rename"].filter(Boolean);
    if (!actions.length) {
      if (reason) items.push({ sourcePath: file.path, status: "skipped", reason, details });
      else unchanged += 1;
      continue;
    }
    if (rename) context.targets.set(target, file.path);
    items.push({
      sourcePath: file.path,
      targetPath: rename ? target : null,
      status: "pending",
      reason,
      details: { ...details, ...fill, actions },
    });
  }
  return { items, unchanged };
}

export async function planCleanup(operation: LibraryFileOperation, deadline: number) {
  const root = path.resolve(resolveDownloadRoot());
  let cursor = operation.summary.cursor;
  if (!cursor) {
    cursor = { albumIds: libraryAlbumIds(), next: 0 };
    updateLibraryFileOperation(operation.id, { summary: { cursor, unchanged: 0 } });
  }
  const context: CleanupPlanContext = {
    root,
    lidarrRoots: configuredLidarrFolders(null),
    albums: new Map(),
    targets: new Map(
      db
        .prepare<[number], [string, string]>(
          `SELECT target_path, source_path FROM library_file_operation_items
       WHERE operation_id = ? AND status = 'pending' AND target_path IS NOT NULL`,
        )
        .raw()
        .all(operation.id),
    ),
  };
  let unchanged = Number(operation.summary.unchanged || 0);
  while (cursor.next < cursor.albumIds.length) {
    if (Date.now() >= deadline) return false;
    const planned = await planAlbum(cursor.albumIds[cursor.next], context);
    cursor = { ...cursor, next: cursor.next + 1 };
    unchanged += planned.unchanged;
    db.transaction(() => {
      addLibraryFileOperationItems(operation.id, planned.items);
      updateLibraryFileOperation(operation.id, { summary: { cursor, unchanged } });
    })();
  }
  updateLibraryFileOperation(operation.id, {
    summary: { cursor: { next: cursor.next, albumIds: [] }, albums: cursor.albumIds.length },
  });
  return true;
}

const LINK_FALLBACK = new Set<string | undefined>([
  "EPERM",
  "ENOTSUP",
  "EOPNOTSUPP",
  "ENOSYS",
  "EMLINK",
  "EXDEV",
]);

async function renameLibraryFile(from: string, to: string, context: CleanupApplyContext) {
  await fs.mkdir(path.dirname(to), { recursive: true });
  let keptOld = false;
  try {
    await fs.link(from, to);
    keptOld = true;
  } catch (error) {
    const failure = asAppError(error);
    if (failure?.code === "EEXIST") {
      const [a, b] = await Promise.all([fs.stat(from), fs.stat(to)]);
      if (a.ino !== b.ino || a.dev !== b.dev) {
        throw Object.assign(new Error(TAKEN_NAME_REASON), { code: "EEXIST" });
      }
      if (libraryPathKey(from) === libraryPathKey(to)) await fs.rename(from, to);
      else keptOld = true;
    } else if (LINK_FALLBACK.has(String(failure?.code))) {
      keptOld = !(await context.deletionGuard().canDelete(from));
      await placeFile(from, to, keptOld ? "copy" : "move");
      keptOld = false;
    } else {
      throw error;
    }
  }
  commitRename(from, to);
  if (keptOld && (await context.deletionGuard().canDelete(from)))
    await fs.unlink(from).catch(() => {});
  await transferSidecars(from, to, "move").catch(() => {});
}

function moveJobs(from: string, to: string) {
  for (const job of downloadTracker.getAll()) {
    if (job.status !== "done" || !job.finalPath || path.resolve(job.finalPath) !== from) continue;
    downloadTracker.updateFinalPath(job.id, to);
  }
}

// The Library row and every download job follow the file, so playlists,
// favorites, and media servers keep finding it.
function commitRename(from: string, to: string) {
  moveLibraryMediaFilePath("aurral", from, to);
  moveJobs(from, to);
}

export function createCleanupContext() {
  let guard: DeletionGuard | null = null;
  return {
    rescan: new Set<string>(),
    deletionGuard() {
      return guard!;
    },
    async prepare() {
      const { createPlaybackDeletionGuard } = await import("../playback/playbackFileRetention.ts");
      guard ||= createPlaybackDeletionGuard();
    },
  };
}

function requireTargetPath(item: LibraryFileItem) {
  if (item.targetPath === null)
    throw new TypeError("Library file operation item has no target path");
  return item.targetPath;
}

const COPY_CHANGED_REASON =
  "One of the copies changed since Clean up checked them, so this one stays. Run Clean up Library again.";

// Removing a copy the user asked to remove checks the two copies again, since
// either may have changed. The Library's track, with its favorites, and the
// download jobs that playlists use stay on the copy Aurral keeps.
async function removeDuplicate(item: LibraryFileItem, context: CleanupApplyContext) {
  const details = { ...item.details, removable: false };
  const extra = path.resolve(item.sourcePath);
  const kept = path.resolve(requireTargetPath(item));
  const onDisk = await fs.lstat(extra).catch(() => null);
  if (!(await fs.stat(kept).catch(() => null))) {
    if (!onDisk)
      return {
        status: "duplicate",
        reason: "This copy is already gone.",
        details: { ...details, sourceRemoved: true },
      };
    return {
      status: "skipped",
      reason: "Kept this file because the preferred copy is missing. Run Clean up Library again.",
      details,
    };
  }
  if (details.takesName && (await passesThroughLinkedFolder(resolveDownloadRoot(), extra))) {
    return { status: "skipped", reason: LINKED_FOLDER_REASON, details };
  }
  if (onDisk) {
    const trackId = libraryTrackAt(extra);
    const copy =
      trackId && trackId === libraryTrackAt(kept) ? await compareCopies(extra, kept) : null;
    if (!copy?.keepHolder) return { status: "skipped", reason: COPY_CHANGED_REASON, details };
    if (!(await context.deletionGuard().canDelete(extra, { retain: false }))) {
      return {
        status: "skipped",
        reason: "Still used by a media server playlist. Retry after the playlist updates.",
        details,
      };
    }
    await transferSidecars(extra, kept, "move").catch(() => {});
    await fs.unlink(extra);
  }
  removeLibraryMediaFiles("aurral", [extra]);
  moveJobs(extra, kept);
  const removed = { ...details, sourceRemoved: true };
  const done = onDisk ? "Removed this copy" : "This copy is already gone";
  if (!details.takesName) {
    return {
      status: "duplicate",
      reason: `${done}. The Library keeps the other one.`,
      details: removed,
    };
  }
  try {
    await renameLibraryFile(kept, extra, context);
  } catch {
    return {
      status: "duplicate",
      reason: `${done}, but Aurral could not give the better one its name. Run Clean up Library again.`,
      details: removed,
    };
  }
  return {
    status: "duplicate",
    reason: `${done}. The better copy now has its name.`,
    details: { ...removed, nameTaken: true },
  };
}

export async function applyCleanupItem(
  operation: LibraryFileOperation,
  item: LibraryFileItem,
  context: CleanupApplyContext,
) {
  if (item.details.action === "remove-source") return removeDuplicate(item, context);
  const details = { ...item.details, results: { ...(item.details.results || {}) } };
  const actions = details.actions || [];
  const save = () => updateLibraryFileOperationItem(operation.id, item.position, { details });
  let current = path.resolve(item.sourcePath);
  if (details.results.rename === "done" && item.targetPath) current = item.targetPath;
  const expected = (details.results.tags === "done" && details.tagged) || details;
  const matchesExpected = (fileStat: Stats) =>
    Number(expected.size) === fileStat.size && Number(expected.mtimeMs) === fileStat.mtimeMs;
  let stat = await fs.stat(current).catch(() => null);
  const placedTarget = !stat && actions.includes("rename") ? item.targetPath : null;
  const placed = placedTarget ? await fs.stat(placedTarget).catch(() => null) : null;
  if (placedTarget && placed && matchesExpected(placed)) {
    commitRename(current, placedTarget);
    await transferSidecars(current, placedTarget, "move").catch(() => {});
    details.results.rename = "done";
    current = placedTarget;
    stat = await fs.stat(current);
  }
  if (!stat) return { status: "failed", reason: "The file is gone.", details };
  if (!matchesExpected(stat)) {
    return {
      status: "skipped",
      reason: "The file changed while Aurral was checking it. Run Clean up Library again.",
      details,
    };
  }
  const renaming = actions.includes("rename") && details.results.rename !== "done";
  const renameTarget = renaming ? requireTargetPath(item) : null;
  if (
    renameTarget !== null &&
    (await passesThroughLinkedFolder(resolveDownloadRoot(), renameTarget))
  ) {
    return { status: "skipped", reason: LINKED_FOLDER_REASON, details };
  }
  const rename = async (target: string) => {
    try {
      await renameLibraryFile(current, target, context);
      details.results.rename = "done";
      current = target;
      save();
    } catch (error) {
      const failure = asAppError(error);
      if (failure?.code === "EEXIST")
        return { status: "conflict", reason: failure.message, details };
      details.results.rename = "failed";
      return {
        status: "failed",
        reason: `Aurral could not rename the file: ${failure?.code || failure?.message}`,
        details,
      };
    }
    return null;
  };
  // Tags give the file a new inode, so a name that already links to it is
  // taken first, or it would no longer be the same file.
  if (renameTarget !== null && (await isSameFile(current, renameTarget).catch(() => false))) {
    const stopped = await rename(renameTarget);
    if (stopped) return stopped;
  }
  if (actions.includes("tags") && details.results.tags !== "done") {
    try {
      await writeAudioTags(current, details.tags, { fillOnly: true });
    } catch (error) {
      details.results.tags = "failed";
      return {
        status: "failed",
        reason: `Aurral could not write the tags: ${asAppError(error)?.message || error}`,
        details,
      };
    }
    const tagged = await fs.stat(current);
    details.tagged = { size: tagged.size, mtimeMs: tagged.mtimeMs };
    details.results.tags = "done";
    save();
  }
  if (actions.includes("tags") && details.results.reindex !== "done") {
    await adoptLibraryFileIdentity(current).then(
      () => {
        details.results.reindex = "done";
        save();
      },
      () => {
        context.rescan.add(current);
      },
    );
  }
  if (renameTarget !== null && details.results.rename !== "done") {
    const stopped = await rename(renameTarget);
    if (stopped) return stopped;
  }
  return { status: "done", details };
}

async function moveAlbumImages(fromDirectory: string, toDirectory: string) {
  const entries = await fs.readdir(fromDirectory, { withFileTypes: true }).catch(() => []);
  if (
    entries.some(
      (entry) =>
        entry.isFile() && /\.(aac|aiff|ape|flac|m4a|mp3|oga|ogg|opus|wav|wv)$/i.test(entry.name),
    )
  ) {
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !ALBUM_IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
      continue;
    await placeFile(
      path.join(fromDirectory, entry.name),
      path.join(toDirectory, entry.name),
      "move",
    ).catch(() => {});
  }
}

// A removed copy leaves its folder for the kept copy's. A better copy that
// took a removed copy's name left its own folder instead.
function removedCopies(operationId: number): [string, string][] {
  return db
    .prepare<[number], { source_path: string; target_path: string; name_taken: number | null }>(
      `SELECT source_path, target_path, json_extract(details_json, '$.nameTaken') AS name_taken
     FROM library_file_operation_items
     WHERE operation_id = ? AND status = 'duplicate' AND json_extract(details_json, '$.sourceRemoved') = 1`,
    )
    .all(operationId)
    .map((row): [string, string] =>
      row.name_taken ? [row.target_path, row.source_path] : [row.source_path, row.target_path],
    );
}

export async function finishCleanup(operation: LibraryFileOperation) {
  restoreUnremovedDuplicates(operation.id);
  const root = path.resolve(resolveDownloadRoot());
  const removing = Boolean(operation.summary.removingSources);
  const moves = removing
    ? removedCopies(operation.id)
    : db
        .prepare<[number], [string, string]>(
          `SELECT source_path, target_path FROM library_file_operation_items
       WHERE operation_id = ? AND status = 'done' AND target_path IS NOT NULL`,
        )
        .raw()
        .all(operation.id);
  const folders = new Map();
  const renamed = new Set<string>();
  for (const [from, to] of moves) {
    renamed.add(path.resolve(to));
    const folder = path.dirname(from);
    const targets = folders.get(folder) || new Set();
    targets.add(path.dirname(to));
    folders.set(folder, targets);
  }
  const deepestFirst = [...folders.keys()].sort((left, right) => right.length - left.length);
  for (const folder of deepestFirst) {
    const targets = folders.get(folder);
    if (targets.size === 1 && folder !== root) await moveAlbumImages(folder, [...targets][0]);
    await removeEmptyDirectories(folder, root);
  }
  const playlistIds = new Set(
    downloadTracker
      .getAll()
      .filter(
        (job) => job.status === "done" && job.finalPath && renamed.has(path.resolve(job.finalPath)),
      )
      .map((job) => job.playlistId || job.playlistType)
      .filter(Boolean),
  );
  const { playlistManager } = await import("../playlists/playlistManager.ts");
  playlistManager.requestPlaylistSync([...playlistIds]);
  if (removing) updateLibraryFileOperation(operation.id, { summary: { removingSources: null } });
  return {
    includeLidarr: false,
    changedPaths: [...folders.keys(), ...[...folders.values()].flatMap((targets) => [...targets])],
  };
}

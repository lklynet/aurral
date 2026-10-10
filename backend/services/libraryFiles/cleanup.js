import fs from "node:fs/promises";
import path from "node:path";
import { parseFile } from "music-metadata";
import { db } from "../../config/db-sqlite.js";
import { buildLibraryTrackPath, isPathInsideRoot, resolveDownloadRoot } from "../downloadPaths.js";
import { downloadTracker } from "../downloadJobs/downloadTracker.js";
import { writeAudioTags } from "../audioTags.js";
import { buildMetadataRecord } from "../libraryFileScanner.js";
import { configuredLidarrFolders, libraryFolderOwner } from "../libraryFolders.js";
import { getLibraryMediaFile, moveLibraryMediaFilePath, removeLibraryMediaFiles } from "../libraryMediaStore.js";
import { adoptLibraryFileIdentity } from "./fileIdentity.js";
import {
  ALBUM_IMAGE_EXTENSIONS,
  LINKED_FOLDER_REASON,
  filesIdentical,
  isSameFile,
  passesThroughLinkedFolder,
  placeFile,
  removeEmptyDirectories,
  transferSidecars,
} from "./fileTransfer.js";
import { SAME_LENGTH_MS, compareQuality, formatGap, readRecording } from "./recordings.js";
import { planTagFill } from "./tagFill.js";
import {
  addLibraryFileOperationItems,
  restoreUnremovedDuplicates,
  updateLibraryFileOperation,
  updateLibraryFileOperationItem,
} from "./operationStore.js";

const TAKEN_NAME_REASON = "Another file already has this name.";

function libraryAlbumIds() {
  return db.prepare(
    `SELECT DISTINCT album_id FROM library_media_files
     WHERE source = 'aurral' AND available = 1 AND album_id IS NOT NULL
     ORDER BY album_id`,
  ).pluck().all();
}

function albumFiles(albumId, { root, lidarrRoots }) {
  const seen = new Set();
  return db.prepare(
    `SELECT media.id, media.path, media.track_id, media.album_id, media.size, media.mtime_ms,
       media.duration_ms, track.title,
       link.disc_number, link.track_number
     FROM library_media_files AS media
     JOIN library_tracks AS track ON track.id = media.track_id
     LEFT JOIN library_album_tracks AS link ON link.album_id = media.album_id AND link.track_id = media.track_id
     WHERE media.album_id = ? AND media.source = 'aurral' AND media.available = 1
     ORDER BY link.disc_number, link.track_number, media.path`,
  ).all(albumId).filter((file) => {
    if (seen.has(file.id) || !isPathInsideRoot(path.resolve(file.path), root)) return false;
    if (libraryFolderOwner(file.path, { downloadRoot: root, lidarrRoots }) !== "aurral") return false;
    seen.add(file.id);
    return true;
  });
}

async function planTags(file, album, artist, context) {
  const fill = await planTagFill({
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
  }, context.albums);
  if (!fill.tags) return { reason: fill.reason || null };
  const hardlinked = (await fs.stat(file.path).catch(() => null))?.nlink > 1;
  return { tags: fill.tags, tagFields: fill.fields, ...(hardlinked ? { hardlinked } : {}) };
}

// The album's numbering wins. A file the album has no number for keeps the
// number its tags or name give it, so Clean up never drops a track number.
async function trackPosition(file, root) {
  if (file.track_number > 0) return { trackNumber: file.track_number, discNumber: file.disc_number };
  const record = await parseFile(file.path, { skipCovers: true, duration: false })
    .then((metadata) => buildMetadataRecord(metadata, file.path, root), () => null);
  if (record?.trackNumber > 0) return { trackNumber: record.trackNumber, discNumber: record.discNumber };
  return { trackNumber: file.track_number, discNumber: file.disc_number };
}

// The better copy of a track comes first, so it is the one that keeps the name.
async function rankCopies(files) {
  const tracks = new Map();
  for (const file of files) tracks.set(file.track_id, [...(tracks.get(file.track_id) || []), file]);
  const ranked = [];
  for (const copies of tracks.values()) {
    if (copies.length > 1) {
      const quality = new Map(await Promise.all(copies.map(async (file) => [file, await readRecording(file.path)])));
      copies.sort((left, right) => compareQuality(quality.get(right), quality.get(left)));
    }
    ranked.push(...copies);
  }
  return ranked;
}

const libraryTrackAt = (filePath) => {
  const media = getLibraryMediaFile({ source: "aurral", path: filePath });
  return media?.available === 1 ? media.track_id : null;
};

async function nameHolder(target, file, context) {
  const existing = await fs.lstat(target).catch(() => null);
  const sameFile = existing && (await fs.stat(file.path).then((stat) =>
    stat.ino === existing.ino && stat.dev === existing.dev).catch(() => false));
  const holder = existing && !sameFile ? target : context.targets.get(target);
  return holder ? { path: holder, onDisk: holder === target, trackId: libraryTrackAt(holder) } : null;
}

// Two Library files of one track are the same recording when their lengths
// agree, as ingest decides. The holder keeps the name unless this copy is better.
async function compareCopies(filePath, holderPath) {
  if (await filesIdentical(filePath, holderPath).catch(() => false)) {
    return { same: true, keepHolder: true, reason: "An exact copy of this file already has this name." };
  }
  const [mine, theirs] = await Promise.all([readRecording(filePath), readRecording(holderPath)]);
  if (mine.durationMs == null || theirs.durationMs == null) {
    return {
      same: false,
      reason: "Another file of this track already has this name, but Aurral could not tell how long one of them is. Check the files.",
    };
  }
  const gap = mine.durationMs - theirs.durationMs;
  if (Math.abs(gap) > SAME_LENGTH_MS) {
    return {
      same: false,
      reason: `Another file of this track already has this name, but this one is ${formatGap(gap)} ${gap > 0 ? "longer" : "shorter"}, so they are different recordings. Check their tags.`,
    };
  }
  const keepHolder = compareQuality(theirs, mine) >= 0;
  return {
    same: true,
    keepHolder,
    reason: keepHolder ? "Another copy of this track, at least as good, already has this name." : null,
  };
}

async function planAlbum(albumId, context) {
  const album = db.prepare("SELECT * FROM library_albums WHERE id = ?").get(albumId);
  if (!album) return { items: [], unchanged: 0 };
  const artist = db.prepare("SELECT * FROM library_artists WHERE id = ?").get(album.artist_id);
  const items = [];
  const settled = new Set();
  let unchanged = 0;
  for (const listed of await rankCopies(albumFiles(albumId, context))) {
    if (settled.has(path.resolve(listed.path))) continue;
    const position = await trackPosition(listed, context.root);
    const file = { ...listed, track_number: position.trackNumber, disc_number: position.discNumber };
    const details = { size: file.size, mtimeMs: file.mtime_ms };
    const target = buildLibraryTrackPath(context.root, {
      artistName: artist?.name,
      albumName: album.title,
      trackName: file.title,
      trackNumber: file.track_number,
      discNumber: file.disc_number,
    }, path.extname(file.path));
    let rename = target !== path.resolve(file.path);
    if (rename && !isPathInsideRoot(target, context.root)) {
      items.push({ sourcePath: file.path, status: "skipped", reason: "The new name does not fit inside the Downloads Folder.", details });
      continue;
    }
    const holder = rename ? await nameHolder(target, file, context) : null;
    if (holder) {
      const copy = holder.trackId === file.track_id ? await compareCopies(file.path, holder.path) : null;
      if (copy?.keepHolder) {
        items.push({ sourcePath: file.path, targetPath: target, status: "duplicate", reason: copy.reason, details: { ...details, removable: true } });
        continue;
      }
      if (!copy?.same || !holder.onDisk) {
        items.push({ sourcePath: file.path, targetPath: target, status: "conflict", reason: copy?.reason || TAKEN_NAME_REASON, details });
        continue;
      }
      items.push({
        sourcePath: target,
        targetPath: file.path,
        status: "duplicate",
        reason: "A better copy of this track is in another file. Removing this one gives that copy this name.",
        details: { removable: true, takesName: true },
      });
      settled.add(target);
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

export async function planCleanup(operation, deadline) {
  const root = path.resolve(resolveDownloadRoot());
  let cursor = operation.summary.cursor;
  if (!cursor) {
    cursor = { albumIds: libraryAlbumIds(), next: 0 };
    updateLibraryFileOperation(operation.id, { summary: { cursor, unchanged: 0 } });
  }
  const context = {
    root,
    lidarrRoots: configuredLidarrFolders(null),
    albums: new Map(),
    targets: new Map(db.prepare(
      `SELECT target_path, source_path FROM library_file_operation_items
       WHERE operation_id = ? AND status = 'pending' AND target_path IS NOT NULL`,
    ).raw().all(operation.id)),
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
  updateLibraryFileOperation(operation.id, { summary: { cursor: { next: cursor.next, albumIds: [] }, albums: cursor.albumIds.length } });
  return true;
}

const LINK_FALLBACK = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EMLINK", "EXDEV"]);

async function renameLibraryFile(from, to, context) {
  await fs.mkdir(path.dirname(to), { recursive: true });
  let keptOld = false;
  try {
    await fs.link(from, to);
    keptOld = true;
  } catch (error) {
    if (error?.code === "EEXIST") {
      const [a, b] = await Promise.all([fs.stat(from), fs.stat(to)]);
      if (a.ino !== b.ino || a.dev !== b.dev) {
        throw Object.assign(new Error(TAKEN_NAME_REASON), { code: "EEXIST" });
      }
      keptOld = true;
    } else if (LINK_FALLBACK.has(error?.code)) {
      keptOld = !(await context.deletionGuard().canDelete(from));
      await placeFile(from, to, keptOld ? "copy" : "move");
      keptOld = false;
    } else {
      throw error;
    }
  }
  commitRename(from, to);
  if (keptOld && await context.deletionGuard().canDelete(from)) await fs.unlink(from).catch(() => {});
  await transferSidecars(from, to, "move").catch(() => {});
}

function moveJobs(from, to) {
  for (const job of downloadTracker.getAll()) {
    if (job.status !== "done" || !job.finalPath || path.resolve(job.finalPath) !== from) continue;
    downloadTracker.updateFinalPath(job.id, to);
  }
}

// The Library row and every download job follow the file, so playlists,
// favorites, and media servers keep finding it.
function commitRename(from, to) {
  moveLibraryMediaFilePath("aurral", from, to);
  moveJobs(from, to);
}

export function createCleanupContext() {
  let guard = null;
  return {
    rescan: new Set(),
    deletionGuard() {
      return guard;
    },
    async prepare() {
      const { createPlaybackDeletionGuard } = await import("../playback/playbackFileRetention.js");
      guard ||= createPlaybackDeletionGuard();
    },
  };
}

const COPY_CHANGED_REASON =
  "One of the copies changed since Clean up checked them, so this one stays. Run Clean up Library again.";

// Removing a copy the user asked to remove checks the two copies again, since
// either may have changed. The Library's track, with its favorites, and the
// download jobs that playlists use stay on the copy Aurral keeps.
async function removeDuplicate(item, context) {
  const details = { ...item.details, removable: false };
  const extra = path.resolve(item.sourcePath);
  const kept = path.resolve(item.targetPath);
  if (!(await fs.lstat(extra).catch(() => null))) {
    return { status: "duplicate", reason: "This copy is already gone.", details: { ...details, sourceRemoved: true } };
  }
  if (!(await fs.stat(kept).catch(() => null))) {
    return { status: "skipped", reason: "The copy Aurral kept is gone, so this one stays. Run Clean up Library again.", details };
  }
  const trackId = libraryTrackAt(extra);
  const copy = trackId && trackId === libraryTrackAt(kept) ? await compareCopies(extra, kept) : null;
  if (!copy?.keepHolder) return { status: "skipped", reason: COPY_CHANGED_REASON, details };
  if (!(await context.deletionGuard().canDelete(extra))) {
    return {
      status: "skipped",
      reason: "A media server playlist still uses this copy, so it stays. Try again once the playlist has updated.",
      details,
    };
  }
  await transferSidecars(extra, kept, "move").catch(() => {});
  await fs.unlink(extra);
  removeLibraryMediaFiles("aurral", [extra]);
  moveJobs(extra, kept);
  const removed = { ...details, sourceRemoved: true };
  if (!details.takesName) {
    return { status: "duplicate", reason: "Removed this copy. The Library keeps the other one.", details: removed };
  }
  try {
    await renameLibraryFile(kept, extra, context);
  } catch {
    return {
      status: "duplicate",
      reason: "Removed this copy, but Aurral could not give the better one its name. Run Clean up Library again.",
      details: removed,
    };
  }
  return { status: "duplicate", reason: "Removed this copy and gave the better one its name.", details: removed };
}

export async function applyCleanupItem(operation, item, context) {
  if (item.details.action === "remove-source") return removeDuplicate(item, context);
  const details = { ...item.details, results: { ...(item.details.results || {}) } };
  const actions = details.actions || [];
  const save = () => updateLibraryFileOperationItem(operation.id, item.position, { details });
  let current = path.resolve(item.sourcePath);
  if (details.results.rename === "done" && item.targetPath) current = item.targetPath;
  const expected = details.results.tags === "done" ? details.tagged : details;
  const matchesExpected = (fileStat) =>
    Number(expected.size) === fileStat.size && Number(expected.mtimeMs) === fileStat.mtimeMs;
  let stat = await fs.stat(current).catch(() => null);
  const placed = !stat && actions.includes("rename") && item.targetPath
    ? await fs.stat(item.targetPath).catch(() => null)
    : null;
  if (placed && matchesExpected(placed)) {
    commitRename(current, item.targetPath);
    await transferSidecars(current, item.targetPath, "move").catch(() => {});
    details.results.rename = "done";
    current = item.targetPath;
    stat = await fs.stat(current);
  }
  if (!stat) return { status: "failed", reason: "The file is gone.", details };
  if (!matchesExpected(stat)) {
    return { status: "skipped", reason: "The file changed while Aurral was checking it. Run Clean up Library again.", details };
  }
  const renaming = actions.includes("rename") && details.results.rename !== "done";
  if (renaming && await passesThroughLinkedFolder(resolveDownloadRoot(), item.targetPath)) {
    return { status: "skipped", reason: LINKED_FOLDER_REASON, details };
  }
  const rename = async () => {
    try {
      await renameLibraryFile(current, item.targetPath, context);
      details.results.rename = "done";
      current = item.targetPath;
      save();
    } catch (error) {
      if (error?.code === "EEXIST") return { status: "conflict", reason: error.message, details };
      details.results.rename = "failed";
      return { status: "failed", reason: `Aurral could not rename the file: ${error?.code || error?.message}`, details };
    }
    return null;
  };
  // Tags give the file a new inode, so a name that already links to it is
  // taken first, or it would no longer be the same file.
  if (renaming && await isSameFile(current, item.targetPath).catch(() => false)) {
    const stopped = await rename();
    if (stopped) return stopped;
  }
  if (actions.includes("tags") && details.results.tags !== "done") {
    try {
      await writeAudioTags(current, details.tags, { fillOnly: true });
    } catch (error) {
      details.results.tags = "failed";
      return { status: "failed", reason: `Aurral could not write the tags: ${error?.message || error}`, details };
    }
    const tagged = await fs.stat(current);
    details.tagged = { size: tagged.size, mtimeMs: tagged.mtimeMs };
    details.results.tags = "done";
    save();
  }
  if (actions.includes("tags") && details.results.reindex !== "done") {
    await adoptLibraryFileIdentity(current).then(() => {
      details.results.reindex = "done";
      save();
    }, () => {
      context.rescan.add(current);
    });
  }
  if (actions.includes("rename") && details.results.rename !== "done") {
    const stopped = await rename();
    if (stopped) return stopped;
  }
  return { status: "done", details };
}

async function moveAlbumImages(fromDirectory, toDirectory) {
  const entries = await fs.readdir(fromDirectory, { withFileTypes: true }).catch(() => []);
  if (entries.some((entry) => entry.isFile() && /\.(aac|aiff|ape|flac|m4a|mp3|oga|ogg|opus|wav|wv)$/i.test(entry.name))) {
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !ALBUM_IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
    await placeFile(path.join(fromDirectory, entry.name), path.join(toDirectory, entry.name), "move").catch(() => {});
  }
}

// A removed copy leaves its folder for the kept copy's. A better copy that
// took a removed copy's name left its own folder instead.
function removedCopies(operationId) {
  return db.prepare(
    `SELECT source_path, target_path, json_extract(details_json, '$.takesName') AS takes_name
     FROM library_file_operation_items
     WHERE operation_id = ? AND status = 'duplicate' AND json_extract(details_json, '$.sourceRemoved') = 1`,
  ).all(operationId).map((row) => (row.takes_name ? [row.target_path, row.source_path] : [row.source_path, row.target_path]));
}

export async function finishCleanup(operation) {
  restoreUnremovedDuplicates(operation.id);
  const root = path.resolve(resolveDownloadRoot());
  const removing = Boolean(operation.summary.removingSources);
  const moves = removing
    ? removedCopies(operation.id)
    : db.prepare(
      `SELECT source_path, target_path FROM library_file_operation_items
       WHERE operation_id = ? AND status = 'done' AND target_path IS NOT NULL`,
    ).raw().all(operation.id);
  const folders = new Map();
  const renamed = new Set();
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
  const playlistIds = new Set(downloadTracker.getAll()
    .filter((job) => job.status === "done" && job.finalPath && renamed.has(path.resolve(job.finalPath)))
    .map((job) => job.playlistId || job.playlistType)
    .filter(Boolean));
  const { playlistManager } = await import("../playlists/playlistManager.js");
  for (const playlistId of playlistIds) {
    await playlistManager.refreshPlaylist(playlistId).catch(() => {});
  }
  if (removing) updateLibraryFileOperation(operation.id, { summary: { removingSources: null } });
  return {
    includeLidarr: false,
    changedPaths: [...folders.keys(), ...[...folders.values()].flatMap((targets) => [...targets])],
  };
}

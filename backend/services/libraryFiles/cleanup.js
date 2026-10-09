import fs from "node:fs/promises";
import path from "node:path";
import { db } from "../../config/db-sqlite.js";
import { buildLibraryTrackPath, isPathInsideRoot, resolveDownloadRoot } from "../downloadPaths.js";
import { downloadTracker } from "../downloadJobs/downloadTracker.js";
import { writeAudioTags } from "../audioTags.js";
import { configuredLidarrFolders, libraryFolderOwner } from "../libraryFolders.js";
import { moveLibraryMediaFilePath } from "../libraryMediaStore.js";
import { adoptLibraryFileIdentity } from "./fileIdentity.js";
import {
  ALBUM_IMAGE_EXTENSIONS,
  LINKED_FOLDER_REASON,
  isSameFile,
  passesThroughLinkedFolder,
  placeFile,
  removeEmptyDirectories,
  transferSidecars,
} from "./fileTransfer.js";
import { planTagFill } from "./tagFill.js";
import {
  addLibraryFileOperationItems,
  updateLibraryFileOperation,
  updateLibraryFileOperationItem,
} from "./operationStore.js";

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

async function planAlbum(albumId, context) {
  const album = db.prepare("SELECT * FROM library_albums WHERE id = ?").get(albumId);
  if (!album) return { items: [], unchanged: 0 };
  const artist = db.prepare("SELECT * FROM library_artists WHERE id = ?").get(album.artist_id);
  const items = [];
  let unchanged = 0;
  for (const file of albumFiles(albumId, context)) {
    const details = { size: file.size, mtimeMs: file.mtime_ms };
    const target = buildLibraryTrackPath(context.root, {
      artistName: artist?.name,
      albumName: album.title,
      trackName: file.title,
      trackNumber: file.track_number,
    }, path.extname(file.path));
    const rename = target !== path.resolve(file.path);
    if (rename && !isPathInsideRoot(target, context.root)) {
      items.push({ sourcePath: file.path, status: "skipped", reason: "The new name does not fit inside the Downloads Folder.", details });
      continue;
    }
    if (rename) {
      const existing = await fs.lstat(target).catch(() => null);
      const sameFile = existing && (await fs.stat(file.path).then((stat) =>
        stat.ino === existing.ino && stat.dev === existing.dev).catch(() => false));
      if ((existing && !sameFile) || context.targets.has(target)) {
        items.push({ sourcePath: file.path, targetPath: target, status: "conflict", reason: "Another file already has this name.", details });
        continue;
      }
    }
    const { reason, ...fill } = await planTags(file, album, artist, context);
    const actions = [fill.tags && "tags", rename && "rename"].filter(Boolean);
    if (!actions.length) {
      if (reason) items.push({ sourcePath: file.path, status: "skipped", reason, details });
      else unchanged += 1;
      continue;
    }
    if (rename) context.targets.add(target);
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
    targets: new Set(db.prepare(
      `SELECT target_path FROM library_file_operation_items
       WHERE operation_id = ? AND status = 'pending' AND target_path IS NOT NULL`,
    ).pluck().all(operation.id)),
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
        throw Object.assign(new Error("Another file already has this name."), { code: "EEXIST" });
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

// The Library row and every download job follow the file, so playlists,
// favorites, and media servers keep finding it.
function commitRename(from, to) {
  moveLibraryMediaFilePath("aurral", from, to);
  for (const job of downloadTracker.getAll()) {
    if (job.status !== "done" || !job.finalPath || path.resolve(job.finalPath) !== from) continue;
    downloadTracker.updateFinalPath(job.id, to);
  }
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

export async function applyCleanupItem(operation, item, context) {
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

export async function finishCleanup(operation) {
  const root = path.resolve(resolveDownloadRoot());
  const folders = new Map();
  const renamed = new Set();
  for (const row of db.prepare(
    `SELECT source_path, target_path FROM library_file_operation_items
     WHERE operation_id = ? AND status = 'done' AND target_path IS NOT NULL`,
  ).iterate(operation.id)) {
    renamed.add(path.resolve(row.target_path));
    const folder = path.dirname(row.source_path);
    const targets = folders.get(folder) || new Set();
    targets.add(path.dirname(row.target_path));
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
  return {
    includeLidarr: false,
    changedPaths: [...folders.keys(), ...[...folders.values()].flatMap((targets) => [...targets])],
  };
}

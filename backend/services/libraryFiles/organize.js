import fs from "node:fs/promises";
import path from "node:path";
import { db } from "../../config/db-sqlite.js";
import { dbOps } from "../../db/helpers/index.js";
import { buildLibraryTrackPath, isPathInsideRoot, resolveDownloadRoot } from "../downloadPaths.js";
import { downloadTracker } from "../downloadJobs/downloadTracker.js";
import { getLibraryMediaFile, moveLibraryMediaFilePath } from "../libraryMediaStore.js";
import {
  classifyLibraryFileQuality,
  getQualityProfile,
  hasUpgradeSource,
  queueQualityUpgrade,
} from "../qualityProfileService.js";
import { getQualityState, getQualityTier } from "../qualityProfileModel.js";
import { ALBUM_IMAGE_EXTENSIONS, placeFile, removeEmptyDirectories, transferSidecars } from "./fileTransfer.js";
import {
  addLibraryFileOperationItems,
  updateLibraryFileOperation,
  updateLibraryFileOperationItem,
} from "./operationStore.js";

export const ORGANIZE_ACTIONS = ["rename", "upgrade"];

export class OrganizeOptionsError extends Error {
  constructor(message) {
    super(message);
    this.code = "ORGANIZE_OPTIONS_INVALID";
  }
}

export function enabledOrganizeActions(settings = dbOps.getSettings()) {
  return ORGANIZE_ACTIONS.filter((action) => (
    action === "upgrade"
      ? settings.qualityProfile?.libraryTracks === true
      : settings.libraryFiles?.[action] === true
  ));
}

export function validateOrganizeOptions({ scope, actions } = {}) {
  const enabled = new Set(enabledOrganizeActions());
  const requested = [...new Set(Array.isArray(actions) ? actions : [])];
  if (!requested.length) throw new OrganizeOptionsError("Choose what to organize.");
  const disabled = requested.filter((action) => !enabled.has(action));
  if (disabled.length) {
    throw new OrganizeOptionsError(`Turn on ${disabled.join(" and ")} in Settings > Library files first.`);
  }
  const kind = scope?.kind || "library";
  const id = Number(scope?.id);
  if (kind !== "library" && !(["artist", "album"].includes(kind) && Number.isSafeInteger(id) && id > 0)) {
    throw new OrganizeOptionsError("Choose the library, an artist, or an album.");
  }
  const table = kind === "artist" ? "library_artists" : "library_albums";
  if (kind !== "library" && !db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id)) {
    throw new OrganizeOptionsError(`That ${kind} is not in the Library.`);
  }
  return { scope: kind === "library" ? { kind } : { kind, id }, actions: ORGANIZE_ACTIONS.filter((action) => requested.includes(action)) };
}

function scopeAlbumIds({ kind, id }) {
  if (kind === "album") return [id];
  if (kind === "artist") {
    return db.prepare("SELECT id FROM library_albums WHERE artist_id = ? ORDER BY id").pluck().all(id);
  }
  return db.prepare(
    `SELECT DISTINCT album_id FROM library_media_files
     WHERE source = 'aurral' AND available = 1 AND album_id IS NOT NULL
     ORDER BY album_id`,
  ).pluck().all();
}

function albumFiles(albumId, root) {
  const seen = new Set();
  return db.prepare(
    `SELECT media.id, media.path, media.track_id, media.album_id, media.size, media.mtime_ms,
       media.duration_ms, media.quality_json, track.title, track.monitored,
       link.disc_number, link.track_number
     FROM library_media_files AS media
     JOIN library_tracks AS track ON track.id = media.track_id
     LEFT JOIN library_album_tracks AS link ON link.album_id = media.album_id AND link.track_id = media.track_id
     WHERE media.album_id = ? AND media.source = 'aurral' AND media.available = 1
     ORDER BY link.disc_number, link.track_number, media.path`,
  ).all(albumId).filter((file) => {
    if (seen.has(file.id) || !isPathInsideRoot(path.resolve(file.path), root)) return false;
    seen.add(file.id);
    return true;
  });
}

async function planAlbum(operation, albumId, context) {
  const { actions } = operation.options;
  const album = db.prepare("SELECT * FROM library_albums WHERE id = ?").get(albumId);
  if (!album) return { items: [], unchanged: 0 };
  const artist = db.prepare("SELECT * FROM library_artists WHERE id = ?").get(album.artist_id);
  const files = albumFiles(albumId, context.root);
  const items = [];
  let unchanged = 0;
  for (const file of files) {
    const planned = [];
    const notes = [];
    const details = { size: file.size, mtimeMs: file.mtime_ms };
    const names = {
      artistName: artist?.name,
      albumName: album.title,
      trackName: file.title,
      trackNumber: file.track_number,
    };
    let targetPath = null;
    if (actions.includes("rename")) {
      const target = buildLibraryTrackPath(context.root, names, path.extname(file.path));
      if (target !== path.resolve(file.path)) {
        const existing = await fs.lstat(target).catch(() => null);
        const sameFile = existing && (await fs.stat(file.path).then((stat) =>
          stat.ino === existing.ino && stat.dev === existing.dev).catch(() => false));
        if (!isPathInsideRoot(target, context.root)) notes.push("The new name does not fit inside the Downloads Folder.");
        else if ((existing && !sameFile) || context.targets.has(target)) {
          items.push({
            sourcePath: file.path,
            targetPath: target,
            status: "conflict",
            reason: "Another file already has this name.",
            details,
          });
          continue;
        } else {
          planned.push("rename");
          targetPath = target;
          context.targets.add(target);
        }
      }
    }
    if (actions.includes("upgrade") && file.monitored === 1 && context.canUpgrade) {
      const quality = classifyLibraryFileQuality(file);
      if (getQualityState(quality, context.profile) !== "preferred") {
        planned.push("upgrade");
        details.quality = getQualityTier(quality.tier)?.label || "Unknown";
      }
    }
    if (planned.length) {
      items.push({
        sourcePath: file.path,
        targetPath,
        status: "pending",
        reason: notes[0] || null,
        details: { ...details, actions: planned },
      });
    } else if (notes.length) {
      items.push({ sourcePath: file.path, status: "skipped", reason: notes[0], details });
    } else {
      unchanged += 1;
    }
  }
  return { items, unchanged };
}

export async function planOrganize(operation, deadline) {
  const root = path.resolve(resolveDownloadRoot());
  let cursor = operation.summary.cursor;
  if (!cursor) {
    cursor = { albumIds: scopeAlbumIds(operation.options.scope), next: 0 };
    const canUpgrade = !operation.options.actions.includes("upgrade") || hasUpgradeSource();
    updateLibraryFileOperation(operation.id, {
      summary: {
        cursor,
        unchanged: 0,
        notice: canUpgrade ? null : "Upgrades need Soulseek, Usenet, or Deemix set up as a download client.",
      },
    });
  }
  const context = {
    root,
    profile: getQualityProfile(),
    canUpgrade: hasUpgradeSource(),
    targets: new Set(db.prepare(
      `SELECT target_path FROM library_file_operation_items
       WHERE operation_id = ? AND status = 'pending' AND target_path IS NOT NULL`,
    ).pluck().all(operation.id)),
  };
  let unchanged = Number(operation.summary.unchanged || 0);
  while (cursor.next < cursor.albumIds.length) {
    if (Date.now() >= deadline) return false;
    const planned = await planAlbum(operation, cursor.albumIds[cursor.next], context);
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

export function createOrganizeContext() {
  let guard = null;
  return {
    deletionGuard() {
      return guard;
    },
    async prepare() {
      const { createPlaybackDeletionGuard } = await import("../playback/playbackFileRetention.js");
      guard ||= createPlaybackDeletionGuard();
    },
  };
}

export async function applyOrganizeItem(operation, item, context) {
  const details = { ...item.details, results: { ...(item.details.results || {}) } };
  const actions = details.actions || [];
  const save = () => updateLibraryFileOperationItem(operation.id, item.position, { details });
  let current = path.resolve(item.sourcePath);
  if (details.results.rename === "done" && item.targetPath) current = item.targetPath;
  const matchesExpected = (fileStat) =>
    Number(details.size) === fileStat.size && Number(details.mtimeMs) === fileStat.mtimeMs;
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
    return { status: "skipped", reason: "The file changed after the preview. Run Organize again.", details };
  }
  if (actions.includes("rename") && details.results.rename !== "done") {
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
  }
  if (actions.includes("upgrade") && !details.results.upgrade) {
    const media = getLibraryMediaFile({ source: "aurral", path: current });
    const { resolveAurralOwnedTrackJob } = await import("../libraryTrackResearchService.js");
    const job = media ? resolveAurralOwnedTrackJob({ trackId: media.track_id, albumId: media.album_id }) : null;
    details.results.upgrade = job ? await queueQualityUpgrade(job) : "ineligible";
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

export async function finishOrganize(operation) {
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

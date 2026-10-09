import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { parseFile } from "music-metadata";
import { db } from "../../config/db-sqlite.js";
import { buildLibraryTrackPath, isPathInsideRoot, resolveDownloadRoot } from "../downloadPaths.js";
import { AUDIO_EXTENSIONS, buildMetadataRecord } from "../libraryFileScanner.js";
import { configuredLidarrFolders, isPathWithin } from "../libraryFolders.js";
import { getLibraryMediaFile } from "../libraryMediaStore.js";
import { invalidateLibraryQueryCache } from "../libraryQueryService.js";
import { logger, safeLogDiagnostic } from "../logger.js";
import {
  ALBUM_IMAGE_EXTENSIONS,
  LINKED_FOLDER_REASON,
  TRANSFER_MODES,
  filesIdentical,
  isSameFile,
  passesThroughLinkedFolder,
  placeFile,
  probeHardlink,
  removeEmptyDirectories,
  transferSidecars,
} from "./fileTransfer.js";
import { writeAudioTags } from "../audioTags.js";
import { rekeyLibraryAlbum } from "../libraryMediaStore.js";
import { findLibraryTrackAtPath, matchLibraryRecord } from "./libraryMatch.js";
import { planTagFill } from "./tagFill.js";
import {
  OperationConflictError,
  addLibraryFileOperationItems,
  deleteLibraryFileOperationItems,
  getActiveLibraryFileOperation,
  getLibraryFileOperation,
  listLibraryFileOperationItems,
  updateLibraryFileOperation,
  updateLibraryFileOperationItem,
} from "./operationStore.js";

const CHUNK = 200;

export class IngestSourceError extends Error {
  constructor(message) {
    super(message);
    this.code = "INGEST_SOURCE_INVALID";
  }
}

async function* walkAudioFiles(directory) {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    throw new IngestSourceError(`Aurral cannot read ${directory}. Give Aurral access to it, or move it out of the folder.`);
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* walkAudioFiles(entryPath);
    else if (entry.isFile() && AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) yield entryPath;
  }
}

const overlaps = (left, right) => isPathWithin(left, right) || isPathWithin(right, left);

export async function resolveIngestSource(sourcePath, { downloadRoot = resolveDownloadRoot() } = {}) {
  const requested = String(sourcePath || "").trim();
  if (!requested || !path.isAbsolute(requested)) {
    throw new IngestSourceError("Enter the full path of the folder to ingest.");
  }
  const stat = await fs.stat(requested).catch(() => null);
  if (!stat) throw new IngestSourceError("The folder does not exist, or Aurral cannot read it.");
  if (!stat.isDirectory()) throw new IngestSourceError("Choose a folder, not a file.");
  const source = await fs.realpath(requested);
  const root = await fs.realpath(downloadRoot).catch(() => path.resolve(downloadRoot));
  if (isPathWithin(root, source)) {
    throw new IngestSourceError("This folder is already in the Downloads Folder. Use Clean up Library to rename files there.");
  }
  if (isPathWithin(source, root)) {
    throw new IngestSourceError("The Downloads Folder is inside this folder. Choose a folder outside it.");
  }
  return source;
}

export async function checkIngestSource({ sourcePath, lidarrClient = null } = {}) {
  const downloadRoot = resolveDownloadRoot();
  const source = await resolveIngestSource(sourcePath, { downloadRoot });
  let audioFiles = 0;
  let firstFile = null;
  for await (const filePath of walkAudioFiles(source)) {
    firstFile ||= filePath;
    audioFiles += 1;
  }
  const lidarrRoot = configuredLidarrFolders(lidarrClient).find((root) => overlaps(root, source)) || null;
  return {
    sourcePath: source,
    downloadRoot: path.resolve(downloadRoot),
    audioFiles,
    hardlink: firstFile
      ? await probeHardlink(firstFile, downloadRoot)
      : { available: false, reason: "The folder has no music files." },
    lidarrRoot,
  };
}

const MONITOR_CHOICES = new Set(["none", "tracks", "albums"]);

export function validateIngestOptions({ mode, monitor } = {}) {
  if (!TRANSFER_MODES.has(mode)) throw new IngestSourceError("Choose Move, Copy, or Hardlink.");
  if (!MONITOR_CHOICES.has(monitor)) throw new IngestSourceError("Choose None, Tracks, or Albums to monitor.");
}

async function listSourceFiles(operation) {
  deleteLibraryFileOperationItems(operation.id, ["new"]);
  const files = [];
  for await (const filePath of walkAudioFiles(operation.options.sourcePath)) {
    files.push({ sourcePath: filePath, status: "new" });
    if (files.length >= 500) {
      addLibraryFileOperationItems(operation.id, files.splice(0));
    }
  }
  if (files.length) addLibraryFileOperationItems(operation.id, files);
}

const unknownIdentity = (record) =>
  record.artistName === "Unknown Artist" || record.albumName === "Unknown Album";

async function planFill(item, record, match, metadata, albums) {
  const durationS = Number(metadata.format?.duration);
  return planTagFill({
    filePath: item.sourcePath,
    album: {
      releaseGroupMbid: record.releaseGroupMbid || match.album?.release_group_mbid || null,
      releaseMbid: record.albumMbid || match.album?.mbid || null,
      title: match.albumName,
      year: metadata.common?.year || match.album?.release_date || null,
    },
    artist: { name: match.artistName, mbid: match.artistMbid },
    file: {
      title: record.title,
      trackNumber: record.trackNumber || null,
      discNumber: record.discNumber || null,
      durationMs: Number.isFinite(durationS) ? Math.round(durationS * 1000) : null,
    },
  }, albums);
}

const SAME_LENGTH_MS = 3000;
const STOPPED_REASON = "The ingest stopped before Aurral got to this file. Ingest the folder again to file it.";
const TAKEN_NAME_REASON =
  "A different file already has this name in the Library. Aurral never replaces a file. Rename or remove one of them, then ingest again.";

async function readRecording(filePath, metadata = null) {
  try {
    const parsed = metadata || await parseFile(filePath, { skipCovers: true, duration: false });
    let seconds = Number(parsed.format?.duration);
    if (!(seconds > 0)) seconds = Number((await parseFile(filePath, { skipCovers: true, duration: true })).format?.duration);
    return { durationMs: seconds > 0 ? Math.round(seconds * 1000) : null, lossless: parsed.format?.lossless === true };
  } catch {
    return { durationMs: null, lossless: false };
  }
}

const formatGap = (ms) => {
  const seconds = Math.round(Math.abs(ms) / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

// Matching tags are not proof: a mistagged demo can claim to be an album
// track. The Library has the same recording only when the lengths agree.
async function compareWithLibrary(source, candidates, title) {
  const copies = await Promise.all(candidates.map(async (targetPath) => ({ targetPath, ...(await readRecording(targetPath)) })));
  const measured = source.durationMs == null
    ? []
    : copies.filter((copy) => copy.durationMs != null).map((copy) => ({ ...copy, gap: source.durationMs - copy.durationMs }));
  if (!measured.length) {
    return {
      targetPath: candidates[0],
      reason: `Its tags match ${title}, which the Library already has, but Aurral could not tell how long one of them is. Check the file.`,
    };
  }
  const same = measured.filter((copy) => Math.abs(copy.gap) <= SAME_LENGTH_MS);
  if (!same.length) {
    const nearest = measured.reduce((best, copy) => (Math.abs(copy.gap) < Math.abs(best.gap) ? copy : best));
    return {
      targetPath: nearest.targetPath,
      reason: `Its tags match ${title}, which the Library already has, but it is ${formatGap(nearest.gap)} ${nearest.gap > 0 ? "longer" : "shorter"}. Check its tags.`,
    };
  }
  if (source.lossless && !same.some((copy) => copy.lossless)) {
    return {
      targetPath: same[0].targetPath,
      reason: `It is a lossless copy of ${title}, which the Library has only in a lossy format. To use it instead, remove the Library's copy and ingest again.`,
    };
  }
  return { targetPath: (same.find((copy) => copy.lossless === source.lossless) || same[0]).targetPath };
}

async function planItem(operation, item, plannedTargets, albums) {
  const { sourcePath: sourceRoot, mode } = operation.options;
  const root = resolveDownloadRoot();
  let metadata;
  try {
    const stat = await fs.stat(item.sourcePath);
    if (stat.size === 0) return { status: "skipped", reason: "The file is empty." };
    metadata = await parseFile(item.sourcePath, { skipCovers: true, duration: false });
  } catch {
    return { status: "skipped", reason: "Aurral could not read this file." };
  }
  const record = buildMetadataRecord(metadata, item.sourcePath, sourceRoot);
  if (unknownIdentity(record)) {
    return {
      status: "skipped",
      reason: "Aurral could not tell the artist and album. Tag the file, or put it in an Artist/Album folder.",
    };
  }
  const match = matchLibraryRecord(record);
  const details = {
    artistName: match.artistName,
    albumName: match.albumName,
    title: record.title,
    trackNumber: record.trackNumber || null,
    existingAlbum: Boolean(match.album),
  };
  const libraryCopy = async (candidates) => {
    for (const candidate of candidates) {
      if (await filesIdentical(item.sourcePath, candidate).catch(() => false)) return candidate;
    }
    return null;
  };
  const identicalCopy = (targetPath) => mode === "move"
    ? { status: "pending", targetPath, details: { ...details, action: "remove-duplicate" } }
    : { status: "duplicate", targetPath, reason: "The Library already has this file.", details };
  const sameRecording = async (candidates, title) => {
    const verdict = await compareWithLibrary(await readRecording(item.sourcePath, metadata), candidates, title);
    if (verdict.reason) return { status: "skipped", targetPath: verdict.targetPath, reason: verdict.reason, details };
    return {
      status: "duplicate",
      targetPath: verdict.targetPath,
      reason: "The Library already has this track in a different file.",
      details: mode === "move" ? { ...details, removable: true } : details,
    };
  };
  if (match.files.length) {
    const identical = await libraryCopy(match.files);
    return identical ? identicalCopy(identical) : sameRecording(match.files, match.track.title);
  }
  const target = buildLibraryTrackPath(
    root,
    { artistName: match.artistName, albumName: match.albumName, trackName: record.title, trackNumber: record.trackNumber, discNumber: record.discNumber },
    path.extname(item.sourcePath),
  );
  if (!isPathInsideRoot(target, root)) {
    return { status: "skipped", reason: "The file's name does not fit inside the Downloads Folder.", details };
  }
  if (await fs.lstat(target).catch(() => null)) {
    if (await libraryCopy([target])) return identicalCopy(target);
    const occupant = findLibraryTrackAtPath(target, { ...record, artistName: match.artistName, albumName: match.albumName });
    if (occupant) return sameRecording([target], occupant.title);
    return { status: "skipped", targetPath: target, reason: TAKEN_NAME_REASON, details };
  }
  if (plannedTargets.has(target)) {
    const claim = [record.discNumber > 1 && `disc ${record.discNumber}`, record.trackNumber && `track ${record.trackNumber}`]
      .filter(Boolean)
      .join(", ");
    return {
      status: "skipped",
      targetPath: target,
      reason: `Its tags say it is ${claim ? `${claim}, ` : ""}${record.title}, which another file in this folder also claims. Retag it and ingest again.`,
      details,
    };
  }
  plannedTargets.add(target);
  if (!operation.options.fillTags) {
    return { status: "pending", targetPath: target, details: { ...details, action: "file" } };
  }
  const fill = await planFill(item, record, match, metadata, albums);
  return {
    status: "pending",
    targetPath: target,
    reason: fill.reason || null,
    details: {
      ...details,
      action: "file",
      ...(fill.tags
        ? { actions: ["file", "tags"], tags: fill.tags, tagFields: fill.fields, albumId: match.album?.id || null }
        : {}),
    },
  };
}

export async function planIngest(operation, deadline) {
  if (!operation.summary.listed) {
    await listSourceFiles(operation);
    updateLibraryFileOperation(operation.id, { summary: { listed: true } });
  }
  const plannedTargets = new Set(db.prepare(
    `SELECT target_path FROM library_file_operation_items
     WHERE operation_id = ? AND status = 'pending' AND target_path IS NOT NULL`,
  ).pluck().all(operation.id));
  const albums = new Map();
  while (Date.now() < deadline) {
    const batch = listLibraryFileOperationItems(operation.id, { statuses: ["new"], limit: CHUNK });
    if (!batch.length) return true;
    for (const item of batch) {
      updateLibraryFileOperationItem(operation.id, item.position, await planItem(operation, item, plannedTargets, albums));
      if (Date.now() >= deadline) return false;
    }
  }
  return false;
}

async function removeDuplicateSource(item) {
  if (!(await fs.lstat(item.sourcePath).catch(() => null))) {
    await transferSidecars(item.sourcePath, item.targetPath, "move").catch(() => {});
    return { status: "duplicate", reason: "The Library already has this file." };
  }
  if (!(await filesIdentical(item.sourcePath, item.targetPath).catch(() => false))) {
    return { status: "skipped", reason: "The Library's copy changed before Aurral could compare it. Ingest again to check it." };
  }
  await transferSidecars(item.sourcePath, item.targetPath, "move").catch(() => {});
  await fs.unlink(item.sourcePath);
  return { status: "duplicate", reason: "The Library already had this file, so the source copy was removed." };
}

// Removing a source the user asked to remove checks it against the Library's
// copy again, since either file may have changed since the ingest.
async function removeKeptSource(item) {
  const details = { ...item.details, removable: false };
  if (!(await fs.lstat(item.sourcePath).catch(() => null))) {
    return { status: "duplicate", reason: "The Library already has this track, and the source file is gone.", details: { ...details, sourceRemoved: true } };
  }
  if (!(await fs.stat(item.targetPath).catch(() => null))) {
    return { status: "skipped", reason: "The Library's copy is gone, so Aurral kept this file. Ingest it again to file it.", details };
  }
  const verdict = await compareWithLibrary(await readRecording(item.sourcePath), [item.targetPath], item.details.title);
  if (verdict.reason) return { status: "skipped", reason: verdict.reason, details };
  await transferSidecars(item.sourcePath, item.targetPath, "move").catch(() => {});
  await fs.unlink(item.sourcePath);
  return {
    status: "duplicate",
    reason: "The Library already had this track, so the source copy was removed.",
    details: { ...details, sourceRemoved: true },
  };
}

async function fileItem(operation, item) {
  const { mode } = operation.options;
  const source = item.sourcePath;
  const target = item.targetPath;
  const sourceStat = await fs.lstat(source).catch(() => null);
  const targetStat = await fs.lstat(target).catch(() => null);
  if (targetStat) {
    if (!sourceStat) {
      if (mode !== "move") return { status: "failed", reason: "The source file is gone." };
      await transferSidecars(source, target, mode).catch(() => {});
      return { status: "done" };
    }
    if (!(await filesIdentical(source, target).catch(() => false))) {
      return { status: "skipped", reason: TAKEN_NAME_REASON };
    }
    if (mode === "hardlink" && !(await isSameFile(source, target))) {
      return { status: "duplicate", reason: "The Library already has this file." };
    }
    if (mode === "move") await fs.unlink(source);
  } else {
    if (!sourceStat) return { status: "failed", reason: "The source file is gone." };
    try {
      await placeFile(source, target, mode);
    } catch (error) {
      if (error?.code === "EEXIST") return fileItem(operation, item);
      return { status: "failed", reason: `Aurral could not ${mode} this file: ${error?.code || error?.message}` };
    }
  }
  await transferSidecars(source, target, mode).catch(() => {});
  return { status: "done" };
}

const resolvesToSameFile = async (left, right) => {
  const [a, b] = await Promise.all([fs.realpath(left).catch(() => null), fs.realpath(right).catch(() => null)]);
  return Boolean(a) && a === b;
};

// A file that gains a release group ID would otherwise start a second copy of
// the untagged album it joined.
function keepAlbumTogether(albumId, tags) {
  if (!albumId || !tags.releaseGroupMbid) return;
  const album = db.prepare("SELECT release_group_mbid FROM library_albums WHERE id = ?").get(albumId);
  if (album && !album.release_group_mbid) rekeyLibraryAlbum(albumId, `release-group:${tags.releaseGroupMbid}`);
}

// Tags are filled in on the Library's copy once it is in place, so the
// source keeps its own tags.
async function fillTags(item) {
  try {
    await writeAudioTags(item.targetPath, item.details.tags, { fillOnly: true });
  } catch (error) {
    return { status: "done", reason: `Filed, but Aurral could not write the tags: ${error?.message || error}` };
  }
  keepAlbumTogether(item.details.albumId, item.details.tags);
  return { status: "done" };
}

// A restart can stop an ingest after the tags were filled in on the Library's
// copy. That copy is the source with the planned tags filled in, so the resume
// finishes it instead of calling it a conflict.
async function isFilledCopy({ sourcePath, targetPath, details }) {
  if (!(await fs.stat(sourcePath).catch(() => null)) || !(await fs.stat(targetPath).catch(() => null))) return false;
  const scratch = path.join(path.dirname(targetPath), `.${randomUUID()}.filled${path.extname(targetPath)}`);
  try {
    await fs.copyFile(sourcePath, scratch, fs.constants.COPYFILE_FICLONE);
    if (!(await writeAudioTags(scratch, details.tags, { fillOnly: true })).length) return false;
    return await filesIdentical(scratch, targetPath);
  } catch {
    return false;
  } finally {
    await fs.rm(scratch, { force: true });
  }
}

export async function applyIngestItem(operation, item) {
  const root = resolveDownloadRoot();
  if (!isPathInsideRoot(item.targetPath, root)) {
    return { status: "failed", reason: "The destination is outside the Downloads Folder." };
  }
  if (await passesThroughLinkedFolder(root, item.targetPath)) {
    return { status: "skipped", reason: LINKED_FOLDER_REASON };
  }
  if (await resolvesToSameFile(item.sourcePath, item.targetPath)) {
    return { status: "failed", reason: "A link in the Downloads Folder leads back to this file, so Aurral left it alone." };
  }
  if (item.details.action === "remove-duplicate") return removeDuplicateSource(item);
  if (item.details.action === "remove-source") return removeKeptSource(item);
  const tagging = item.details.actions?.includes("tags");
  if (tagging && await isFilledCopy(item)) {
    if (operation.options.mode === "move") await fs.rm(item.sourcePath, { force: true });
    await transferSidecars(item.sourcePath, item.targetPath, operation.options.mode).catch(() => {});
    return fillTags(item);
  }
  const result = await fileItem(operation, item);
  return result.status === "done" && tagging ? fillTags(item) : result;
}

export function ingestScanRequest(operation, items) {
  const changedPaths = items
    .filter((item) => ["done", "duplicate"].includes(item.status) && item.targetPath)
    .map((item) => item.targetPath);
  if (operation.options.mode === "move") changedPaths.push(...items.map((item) => item.sourcePath));
  return { includeLidarr: operation.options.mode === "move", changedPaths };
}

// Album art beside the music follows it when the whole folder went to one
// album. A moved folder that is left empty is removed. A source that Move kept
// because the Library already has its track keeps its folder and art.
export async function finishIngest(operation) {
  const { sourcePath: sourceRoot, mode } = operation.options;
  db.prepare(
    `UPDATE library_file_operation_items SET status = 'duplicate', updated_at = ?
     WHERE operation_id = ? AND status = 'pending' AND json_extract(details_json, '$.action') = 'remove-source'`,
  ).run(Date.now(), operation.id);
  const folders = new Map();
  const unfiled = new Set();
  const items = db.prepare(
    "SELECT source_path, target_path, status, details_json FROM library_file_operation_items WHERE operation_id = ?",
  ).all(operation.id);
  for (const item of items) {
    const folder = path.dirname(item.source_path);
    const kept = mode === "move" && item.status === "duplicate" && JSON.parse(item.details_json || "{}").removable === true;
    if (!["done", "duplicate"].includes(item.status) || !item.target_path || kept) {
      unfiled.add(folder);
      continue;
    }
    const targets = folders.get(folder) || new Set();
    targets.add(path.dirname(item.target_path));
    folders.set(folder, targets);
  }
  for (const [folder, targets] of folders) {
    if (targets.size !== 1 || unfiled.has(folder)) continue;
    const [target] = targets;
    const entries = await fs.readdir(folder, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !ALBUM_IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      const from = path.join(folder, entry.name);
      const to = path.join(target, entry.name);
      await placeFile(from, to, mode).catch(async (error) => {
        if (mode === "move" && error?.code === "EEXIST" && await filesIdentical(from, to).catch(() => false)) {
          await fs.rm(from, { force: true });
        }
      });
    }
  }
  if (mode === "move") {
    const deepestFirst = [...folders.keys()].sort((left, right) => right.length - left.length);
    for (const folder of deepestFirst) await removeEmptyDirectories(folder, sourceRoot);
  }
  const filed = items.some((item) => item.status === "done");
  const monitor = filed && !operation.summary.monitor && operation.options.monitor && operation.options.monitor !== "none";
  if (monitor || operation.summary.removingSources) {
    updateLibraryFileOperation(operation.id, {
      summary: { removingSources: null, ...(monitor ? { monitor: "pending" } : {}) },
    });
  }
  return ingestScanRequest(operation, items.map((item) => ({
    status: item.status,
    sourcePath: item.source_path,
    targetPath: item.target_path,
  })));
}

// Move keeps a source whose track the Library has in a different file until
// the user asks to remove it. The ingest then runs again over just those
// sources, each checked against the Library's copy before it is removed.
// Files a stopped ingest never reached are skipped, so they stay where they are.
export function reopenIngestToRemoveSources(id) {
  return db.transaction(() => {
    const operation = getLibraryFileOperation(id);
    if (operation?.kind !== "ingest" || operation.options.mode !== "move") {
      throw new IngestSourceError("Only a Move ingest removes its source files.");
    }
    const active = getActiveLibraryFileOperation();
    if (active) throw new OperationConflictError(active);
    if (operation.status === "cancelled" && !operation.summary.finished) {
      throw Object.assign(new OperationConflictError(operation), {
        message: "The ingest is still stopping. Try again in a moment.",
      });
    }
    const requested = db.prepare(
      `UPDATE library_file_operation_items
       SET status = 'pending', details_json = json_set(details_json, '$.action', 'remove-source'), updated_at = ?
       WHERE operation_id = ? AND status = 'duplicate' AND json_extract(details_json, '$.removable') = 1`,
    ).run(Date.now(), operation.id).changes;
    if (!requested) return false;
    db.prepare(
      `UPDATE library_file_operation_items SET status = 'skipped', reason = ?, updated_at = ?
       WHERE operation_id = ? AND (status = 'new'
         OR (status = 'pending' AND COALESCE(json_extract(details_json, '$.action'), '') != 'remove-source'))`,
    ).run(STOPPED_REASON, Date.now(), operation.id);
    updateLibraryFileOperation(operation.id, {
      status: "running",
      summary: { finished: false, removingSources: requested },
    });
    return true;
  }).immediate();
}

export function countIngestSources(operation) {
  if (operation.kind !== "ingest" || operation.options.mode !== "move") return null;
  const counts = db.prepare(
    `SELECT
       COALESCE(SUM(json_extract(details_json, '$.removable') = 1), 0) AS removable,
       COALESCE(SUM(json_extract(details_json, '$.sourceRemoved') = 1), 0) AS removed
     FROM library_file_operation_items WHERE operation_id = ? AND status = 'duplicate'`,
  ).get(operation.id);
  return { removable: counts.removable, removed: counts.removed };
}

const fileExists = (filePath) => fs.lstat(filePath).then(() => true, () => false);

async function monitorIngestedMusic(operation) {
  const trackIds = new Set();
  const albumIds = new Set();
  const targets = db.prepare(
    "SELECT target_path FROM library_file_operation_items WHERE operation_id = ? AND status = 'done'",
  ).pluck().all(operation.id);
  for (const target of targets) {
    const media = getLibraryMediaFile({ source: "aurral", path: target });
    if (media?.available === 1) {
      trackIds.add(media.track_id);
      if (media.album_id) albumIds.add(media.album_id);
    } else if (await fileExists(target)) {
      return;
    }
  }
  const monitorTrack = db.prepare("UPDATE library_tracks SET monitored = 1 WHERE id = ?");
  db.transaction(() => {
    for (const trackId of trackIds) monitorTrack.run(trackId);
  })();
  invalidateLibraryQueryCache({ persistedGenres: false });
  if (operation.options.monitor === "albums") {
    const { libraryManager } = await import("../libraryManager.js");
    for (const albumId of albumIds) {
      const result = await libraryManager.setAurralAlbumMonitoring(albumId, { monitored: true });
      if (result?.error) {
        logger.warn("library-files", "Ingest could not monitor an album", { albumId, reason: result.error });
      }
    }
  }
  updateLibraryFileOperation(operation.id, { summary: { monitor: "applied" } });
}

// The Library learns about ingested files from a scan, so an ingest's Monitor
// choice waits until the scan has indexed every file it placed.
export async function applyIngestMonitoring() {
  const pending = db.prepare(
    `SELECT id FROM library_file_operations
     WHERE kind = 'ingest' AND json_extract(summary_json, '$.monitor') = 'pending'
     ORDER BY id`,
  ).pluck().all();
  for (const id of pending) {
    try {
      await monitorIngestedMusic(getLibraryFileOperation(id));
    } catch (error) {
      logger.warn("library-files", "Ingest could not monitor its music", {
        operationId: id,
        reason: safeLogDiagnostic(error),
      });
    }
  }
}

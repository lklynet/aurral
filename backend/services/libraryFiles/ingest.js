import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { parseFile } from "music-metadata";
import { db } from "../../config/db-sqlite.js";
import {
  buildLibraryTrackPath,
  findLibraryFileVariant,
  isPathInsideRoot,
  libraryPathKey,
  resolveDownloadRoot,
} from "../downloadPaths.js";
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
  removeEmptiedFolder,
  removeEmptyDirectories,
  removeSidecars,
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

const plannedIdentity = (record, tags = {}) => {
  const planned = {
    ...record,
    trackMbid: record.trackMbid || tags.recordingMbid || null,
    releaseGroupMbid: record.releaseGroupMbid || tags.releaseGroupMbid || null,
    albumMbid: record.albumMbid || tags.releaseMbid || null,
  };
  const changed = ["trackMbid", "releaseGroupMbid", "albumMbid"].some((field) => planned[field] !== record[field]);
  return changed ? planned : null;
};

// A source's own tags can miss the Library's copy of its track, such as when
// they number the disc differently. The MusicBrainz IDs the ingest would fill
// in are what the Library scan matches the filed copy by, so the ingest looks
// the track up by them too, whether or not it writes them.
async function placeRecord(item, record, metadata, albums) {
  const match = matchLibraryRecord(record);
  if (match.files.length) return { match, fill: null };
  const fill = await planFill(item, record, match, metadata, albums);
  const planned = plannedIdentity(record, fill.tags);
  const byIds = planned ? matchLibraryRecord(planned) : null;
  const better = byIds && (byIds.files.length || (byIds.album && !match.album));
  return { match: better ? byIds : match, fill };
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
  const { match, fill } = await placeRecord(item, record, metadata, albums);
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
  const taken = findLibraryFileVariant(target);
  if (taken) {
    if (await libraryCopy([taken])) return identicalCopy(taken);
    const occupant = findLibraryTrackAtPath(taken, { ...record, artistName: match.artistName, albumName: match.albumName });
    if (occupant) return sameRecording([taken], occupant.title);
    return { status: "skipped", targetPath: taken, reason: TAKEN_NAME_REASON, details };
  }
  if (plannedTargets.has(libraryPathKey(target))) {
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
  plannedTargets.add(libraryPathKey(target));
  if (!operation.options.fillTags) {
    return { status: "pending", targetPath: target, details: { ...details, action: "file" } };
  }
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
  ).pluck().all(operation.id).map(libraryPathKey));
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
  const doubles = filed && !operation.summary.doubles;
  if (monitor || doubles || operation.summary.removingSources) {
    updateLibraryFileOperation(operation.id, {
      summary: {
        removingSources: null,
        ...(monitor ? { monitor: "pending" } : {}),
        ...(doubles ? { doubles: "pending" } : {}),
      },
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

async function rescan(changedPaths, { includeLidarr }) {
  if (!changedPaths.length) return;
  const { scheduleLibraryScan } = await import("../libraryScanWorker.js");
  scheduleLibraryScan({ includeLidarr, changedPaths });
}

// Album art that Move brought along goes back with the last music in its folder.
async function returnAlbumArt(folder, sourceFolder) {
  const entries = await fs.readdir(folder, { withFileTypes: true }).catch(() => null);
  if (!entries) return;
  if (entries.some((entry) => !entry.isFile() || !ALBUM_IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))) {
    return;
  }
  for (const entry of entries) {
    await placeFile(path.join(folder, entry.name), path.join(sourceFolder, entry.name), "move").catch(() => {});
  }
  await removeEmptyDirectories(folder, resolveDownloadRoot());
}

// Where a filed copy is the second file of its track on its album, the same
// recording the Library already had, the ingest takes it back out: Copy and
// Hardlink remove it, since the source still has it, and Move returns it to
// the source folder to be offered for removal like any source the Library has.
async function takeBackDouble(operation, item, media, removed) {
  const others = db.prepare(
    `SELECT path FROM library_media_files
     WHERE track_id = ? AND album_id IS ? AND source = 'aurral' AND available = 1 AND path != ?
     ORDER BY id`,
  ).pluck().all(media.track_id, media.album_id, item.target_path).filter((other) => !removed.has(other));
  const kept = [];
  for (const other of others) if (await fileExists(other)) kept.push(other);
  if (!kept.length) return null;
  const details = JSON.parse(item.details_json || "{}");
  const title = db.prepare("SELECT title FROM library_tracks WHERE id = ?").pluck().get(media.track_id) || details.title;
  const verdict = await compareWithLibrary(await readRecording(item.target_path), kept, title);
  if (verdict.reason) return null;
  if (operation.options.mode === "move") {
    if (await fileExists(item.source_path)) return null;
    await placeFile(item.target_path, item.source_path, "move");
    await transferSidecars(item.target_path, item.source_path, "move").catch(() => {});
    updateLibraryFileOperationItem(operation.id, item.position, {
      status: "duplicate",
      targetPath: verdict.targetPath,
      reason: "The Library already has this track in a different file.",
      details: { ...details, removable: true },
    });
  } else {
    await fs.unlink(item.target_path);
    await removeSidecars(item.target_path);
    updateLibraryFileOperationItem(operation.id, item.position, {
      status: "duplicate",
      targetPath: verdict.targetPath,
      reason: "The Library already had this track in a different file, so Aurral removed the copy it filed.",
    });
  }
  removed.add(item.target_path);
  if (operation.options.mode === "move") {
    await returnAlbumArt(path.dirname(item.target_path), path.dirname(item.source_path));
    return [item.target_path, item.source_path];
  }
  await removeEmptiedFolder(path.dirname(item.target_path), resolveDownloadRoot());
  return [item.target_path];
}

async function monitorTracks(operation, placed) {
  const trackIds = new Set(placed.map(({ media }) => media.track_id));
  const albumIds = new Set(placed.map(({ media }) => media.album_id).filter(Boolean));
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
}

async function settleIngest(operation) {
  const items = db.prepare(
    `SELECT position, source_path, target_path, details_json FROM library_file_operation_items
     WHERE operation_id = ? AND status = 'done' ORDER BY position`,
  ).all(operation.id);
  let placed = [];
  for (const item of items) {
    const media = getLibraryMediaFile({ source: "aurral", path: item.target_path });
    if (media?.available === 1) placed.push({ item, media });
    else if (await fileExists(item.target_path)) return;
  }
  if (operation.summary.doubles === "pending") {
    const removed = new Set();
    const changed = [];
    for (const entry of placed) {
      try {
        const taken = await takeBackDouble(operation, entry.item, entry.media, removed);
        if (taken) changed.push(...taken);
      } catch (error) {
        logger.warn("library-files", "Ingest could not take back a file the Library already had", {
          operationId: operation.id,
          path: entry.item.target_path,
          reason: safeLogDiagnostic(error),
        });
      }
    }
    placed = placed.filter(({ item }) => !removed.has(item.target_path));
    updateLibraryFileOperation(operation.id, { summary: { doubles: "checked" } });
    await rescan(changed, { includeLidarr: operation.options.mode === "move" });
  }
  if (operation.summary.monitor === "pending") {
    await monitorTracks(operation, placed);
    updateLibraryFileOperation(operation.id, { summary: { monitor: "applied" } });
  }
}

// The Library learns about ingested files from a scan, so the check for
// tracks it already had and the ingest's Monitor choice wait until the scan
// has indexed every file the ingest placed.
export async function settleIngestedMusic() {
  const pending = db.prepare(
    `SELECT id FROM library_file_operations
     WHERE kind = 'ingest' AND status IN ('complete', 'cancelled') AND (
       json_extract(summary_json, '$.monitor') = 'pending'
       OR json_extract(summary_json, '$.doubles') = 'pending')
     ORDER BY id`,
  ).pluck().all();
  for (const id of pending) {
    try {
      await settleIngest(getLibraryFileOperation(id));
    } catch (error) {
      logger.warn("library-files", "Ingest could not finish checking its music", {
        operationId: id,
        reason: safeLogDiagnostic(error),
      });
    }
  }
}

import fs from "node:fs/promises";
import path from "node:path";
import { parseFile } from "music-metadata";
import { db } from "../../config/db-sqlite.js";
import { buildLibraryTrackPath, isPathInsideRoot, resolveDownloadRoot } from "../downloadPaths.js";
import { AUDIO_EXTENSIONS, buildMetadataRecord } from "../libraryFileScanner.js";
import { configuredLidarrFolders, isPathWithin } from "../libraryFolders.js";
import {
  ALBUM_IMAGE_EXTENSIONS,
  TRANSFER_MODES,
  filesIdentical,
  isSameFile,
  placeFile,
  probeHardlink,
  removeEmptyDirectories,
  transferSidecars,
} from "./fileTransfer.js";
import { matchLibraryRecord } from "./libraryMatch.js";
import {
  addLibraryFileOperationItems,
  deleteLibraryFileOperationItems,
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
    throw new IngestSourceError("This folder is already in the Downloads Folder. Use Organize to rename files there.");
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

export function validateIngestOptions({ mode } = {}) {
  if (!TRANSFER_MODES.has(mode)) throw new IngestSourceError("Choose Move, Copy, or Hardlink.");
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

async function planItem(operation, item, plannedTargets) {
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
  if (match.files.length) {
    const identical = await libraryCopy(match.files);
    if (identical) {
      return mode === "move"
        ? { status: "pending", targetPath: identical, details: { ...details, action: "remove-duplicate" } }
        : { status: "duplicate", targetPath: identical, reason: "The Library already has this file.", details };
    }
    return {
      status: "conflict",
      targetPath: match.files[0],
      reason: "The Library already has this track in a different file.",
      details,
    };
  }
  const target = buildLibraryTrackPath(
    root,
    { artistName: match.artistName, albumName: match.albumName, trackName: record.title, trackNumber: record.trackNumber },
    path.extname(item.sourcePath),
  );
  if (!isPathInsideRoot(target, root)) {
    return { status: "skipped", reason: "The file's name does not fit inside the Downloads Folder.", details };
  }
  if (await fs.lstat(target).catch(() => null)) {
    if (await libraryCopy([target])) {
      return mode === "move"
        ? { status: "pending", targetPath: target, details: { ...details, action: "remove-duplicate" } }
        : { status: "duplicate", targetPath: target, reason: "The Library already has this file.", details };
    }
    return { status: "conflict", targetPath: target, reason: "A different file already has this name.", details };
  }
  if (plannedTargets.has(target)) {
    return {
      status: "conflict",
      targetPath: target,
      reason: "Another file in this folder gets the same name in the Library.",
      details,
    };
  }
  plannedTargets.add(target);
  return { status: "pending", targetPath: target, details: { ...details, action: "file" } };
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
  while (Date.now() < deadline) {
    const batch = listLibraryFileOperationItems(operation.id, { statuses: ["new"], limit: CHUNK });
    if (!batch.length) return true;
    for (const item of batch) {
      updateLibraryFileOperationItem(operation.id, item.position, await planItem(operation, item, plannedTargets));
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
    return { status: "conflict", reason: "The Library's copy changed before Aurral could compare it." };
  }
  await transferSidecars(item.sourcePath, item.targetPath, "move").catch(() => {});
  await fs.unlink(item.sourcePath);
  return { status: "duplicate", reason: "The Library already had this file, so the source copy was removed." };
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
      return { status: "conflict", reason: "A different file already has this name." };
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

export async function applyIngestItem(operation, item) {
  if (!isPathInsideRoot(item.targetPath, resolveDownloadRoot())) {
    return { status: "failed", reason: "The destination is outside the Downloads Folder." };
  }
  if (await resolvesToSameFile(item.sourcePath, item.targetPath)) {
    return { status: "failed", reason: "A link in the Downloads Folder leads back to this file, so Aurral left it alone." };
  }
  return item.details.action === "remove-duplicate"
    ? removeDuplicateSource(item)
    : fileItem(operation, item);
}

export function ingestScanRequest(operation, items) {
  const changedPaths = items
    .filter((item) => ["done", "duplicate"].includes(item.status) && item.targetPath)
    .map((item) => item.targetPath);
  if (operation.options.mode === "move") changedPaths.push(...items.map((item) => item.sourcePath));
  return { includeLidarr: operation.options.mode === "move", changedPaths };
}

// Album art beside the music follows it when the whole folder went to one
// album. A moved folder that is left empty is removed.
export async function finishIngest(operation) {
  const { sourcePath: sourceRoot, mode } = operation.options;
  const folders = new Map();
  const unfiled = new Set();
  const items = db.prepare(
    "SELECT source_path, target_path, status FROM library_file_operation_items WHERE operation_id = ?",
  ).all(operation.id);
  for (const item of items) {
    const folder = path.dirname(item.source_path);
    if (!["done", "duplicate"].includes(item.status) || !item.target_path) {
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
      await placeFile(path.join(folder, entry.name), path.join(target, entry.name), mode).catch(() => {});
    }
  }
  if (mode === "move") {
    const deepestFirst = [...folders.keys()].sort((left, right) => right.length - left.length);
    for (const folder of deepestFirst) await removeEmptyDirectories(folder, sourceRoot);
  }
  return ingestScanRequest(operation, items.map((item) => ({
    status: item.status,
    sourcePath: item.source_path,
    targetPath: item.target_path,
  })));
}

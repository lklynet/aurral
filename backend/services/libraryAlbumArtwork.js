import fs from "node:fs/promises";
import path from "node:path";
import { parseFile, selectCover } from "music-metadata";
import { db } from "../config/db-sqlite.js";
import createCache from "./apiClients/simpleCache.js";
import {
  MAX_SOURCE_IMAGE_BYTES,
  inspectImageBuffer,
  optimizeImageBuffer,
} from "./imageProxyService.js";

const SIDECAR_NAMES = ["cover", "folder", "front", "album"];
const SIDECAR_CONTENT_TYPES = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};
const missingArtwork = createCache(24 * 60 * 60, 10_000);
const lookups = new Map();

const latestScanCompletion = () =>
  db.prepare("SELECT MAX(completed_at) AS completedAt FROM library_scan_runs").get()?.completedAt ??
  0;

async function renderCover(buffer, contentType) {
  if (!buffer?.length || buffer.length > MAX_SOURCE_IMAGE_BYTES) return null;
  try {
    await inspectImageBuffer(buffer, contentType);
    return await optimizeImageBuffer(buffer, contentType);
  } catch {
    return null;
  }
}

function sidecarRank(name) {
  const extension = path.extname(name).toLowerCase();
  if (!SIDECAR_CONTENT_TYPES[extension]) return -1;
  return SIDECAR_NAMES.indexOf(path.basename(name, path.extname(name)).toLowerCase());
}

async function readSidecarCover(folder) {
  let realFolder;
  let names;
  try {
    realFolder = await fs.realpath(folder);
    names = await fs.readdir(folder);
  } catch {
    return null;
  }
  const candidates = names
    .map((name) => ({ name, rank: sidecarRank(name) }))
    .filter((candidate) => candidate.rank >= 0)
    .sort((left, right) => left.rank - right.rank || left.name.localeCompare(right.name));
  for (const { name } of candidates) {
    try {
      const artworkPath = await fs.realpath(path.join(folder, name));
      if (path.dirname(artworkPath) !== realFolder) continue;
      const stat = await fs.stat(artworkPath);
      if (!stat.isFile() || stat.size > MAX_SOURCE_IMAGE_BYTES) continue;
      const contentType = SIDECAR_CONTENT_TYPES[path.extname(name).toLowerCase()];
      const cover = await renderCover(await fs.readFile(artworkPath), contentType);
      if (cover) return cover;
    } catch {
      continue;
    }
  }
  return null;
}

async function readEmbeddedCover(filePath) {
  try {
    const metadata = await parseFile(filePath, { duration: false });
    const picture = selectCover(metadata.common.picture);
    const contentType = String(picture?.format || "")
      .toLowerCase()
      .replace(/^image\/jpg$/, "image/jpeg");
    return await renderCover(picture?.data, contentType);
  } catch {
    return null;
  }
}

async function findAlbumArtwork(albumId) {
  const scannedAt = latestScanCompletion();
  if (missingArtwork.get(albumId) === scannedAt) return null;
  const files = db
    .prepare(`SELECT path FROM library_media_files
    WHERE album_id = ? AND available = 1 ORDER BY path COLLATE NOCASE LIMIT 100`)
    .all(Number(albumId));
  const checkedFolders = new Set();
  for (const file of files) {
    const embedded = await readEmbeddedCover(file.path);
    if (embedded) return embedded;
    const folder = path.dirname(file.path);
    if (checkedFolders.has(folder)) continue;
    checkedFolders.add(folder);
    const sidecar = await readSidecarCover(folder);
    if (sidecar) return sidecar;
  }
  missingArtwork.set(albumId, scannedAt);
  return null;
}

export function getLibraryAlbumArtwork(albumId) {
  const key = String(albumId);
  if (!/^[1-9]\d*$/.test(key)) return Promise.resolve(null);
  if (!lookups.has(key)) {
    lookups.set(
      key,
      findAlbumArtwork(key).finally(() => lookups.delete(key)),
    );
  }
  return lookups.get(key);
}

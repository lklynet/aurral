import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { db } from "../config/db-sqlite.js";
import { resolveAurralDataDir } from "../config/data-dir.js";
import {
  inspectImageBuffer,
  optimizeImageBuffer,
  warmImageProxy,
} from "./imageProxyService.js";

const ARTWORK_DIR = path.join(resolveAurralDataDir(), "custom-artwork");
const ENTITY_KINDS = new Set(["album", "track", "playlist-track"]);
const targetOperations = new Map();

const getArtworkStmt = db.prepare(
  "SELECT entity_kind, entity_id, content_type, source_url, updated_at FROM custom_artwork WHERE entity_kind = ? AND entity_id = ?",
);
const saveArtworkStmt = db.prepare(`
  INSERT INTO custom_artwork (entity_kind, entity_id, content_type, source_url, updated_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(entity_kind, entity_id) DO UPDATE SET
    content_type = excluded.content_type,
    source_url = excluded.source_url,
    updated_at = excluded.updated_at
`);
const deleteArtworkStmt = db.prepare(
  "DELETE FROM custom_artwork WHERE entity_kind = ? AND entity_id = ?",
);

function normalizeTarget(kind, id) {
  const entityKind = String(kind || "").trim().toLowerCase();
  const entityId = String(id || "").trim();
  if (!ENTITY_KINDS.has(entityKind) || !entityId) {
    throw new Error("Invalid artwork target");
  }
  return { entityKind, entityId };
}

function artworkPath(kind, id) {
  const key = crypto.createHash("sha256").update(`${kind}:${id}`).digest("hex");
  return path.join(ARTWORK_DIR, `${key}.image`);
}

async function withTargetOperation(kind, id, operation) {
  const target = normalizeTarget(kind, id);
  const key = `${target.entityKind}:${target.entityId}`;
  const previous = targetOperations.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(() => operation(target));
  targetOperations.set(key, current);
  try {
    return await current;
  } finally {
    if (targetOperations.get(key) === current) targetOperations.delete(key);
  }
}

async function writeArtwork(target, buffer, contentType, sourceUrl = null) {
  await fs.promises.mkdir(ARTWORK_DIR, { recursive: true });
  const destination = artworkPath(target.entityKind, target.entityId);
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
  await fs.promises.writeFile(temporary, buffer);
  try {
    await fs.promises.rename(temporary, destination);
  } catch (error) {
    if (!["EEXIST", "EPERM"].includes(error?.code)) throw error;
    await fs.promises.unlink(destination).catch(() => {});
    await fs.promises.rename(temporary, destination);
  } finally {
    await fs.promises.unlink(temporary).catch(() => {});
  }
  const updatedAt = Date.now();
  saveArtworkStmt.run(
    target.entityKind,
    target.entityId,
    contentType,
    sourceUrl,
    updatedAt,
  );
  return getCustomArtwork(target.entityKind, target.entityId);
}

export async function saveCustomArtworkUpload(kind, id, buffer, contentType) {
  return withTargetOperation(kind, id, async (target) => {
    const normalizedContentType = String(contentType || "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    await inspectImageBuffer(buffer, normalizedContentType);
    const optimized = await optimizeImageBuffer(buffer, normalizedContentType);
    return writeArtwork(target, optimized.buffer, optimized.contentType);
  });
}

export async function saveCustomArtworkUrl(kind, id, sourceUrl) {
  return withTargetOperation(kind, id, async (target) => {
    const url = String(sourceUrl || "").trim();
    if (!url) throw new Error("Image URL is required");
    const cached = await warmImageProxy(url);
    const buffer = await fs.promises.readFile(cached.imagePath);
    return writeArtwork(target, buffer, cached.meta.contentType, url);
  });
}

export function getCustomArtwork(kind, id) {
  const target = normalizeTarget(kind, id);
  const row = getArtworkStmt.get(target.entityKind, target.entityId);
  if (!row) return null;
  const filePath = artworkPath(target.entityKind, target.entityId);
  if (!fs.existsSync(filePath)) return null;
  return {
    kind: row.entity_kind,
    id: row.entity_id,
    contentType: row.content_type,
    sourceUrl: row.source_url || null,
    updatedAt: row.updated_at,
    filePath,
  };
}

export function getCustomArtworkMap(kind, ids) {
  const entityKind = normalizeTarget(kind, "placeholder").entityKind;
  const entityIds = [...new Set((ids || []).map((id) => String(id || "").trim()).filter(Boolean))];
  if (!entityIds.length) return new Map();
  const placeholders = entityIds.map(() => "?").join(", ");
  const rows = db.prepare(
    `SELECT entity_id, updated_at FROM custom_artwork WHERE entity_kind = ? AND entity_id IN (${placeholders})`,
  ).all(entityKind, ...entityIds);
  return new Map(rows.map((row) => [String(row.entity_id), Number(row.updated_at)]));
}

export async function removeCustomArtwork(kind, id) {
  return withTargetOperation(kind, id, async (target) => {
    deleteArtworkStmt.run(target.entityKind, target.entityId);
    await fs.promises.unlink(artworkPath(target.entityKind, target.entityId)).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  });
}

export function buildCustomArtworkUrl(kind, id, updatedAt, query = {}) {
  const target = normalizeTarget(kind, id);
  const route = target.entityKind === "playlist-track"
    ? `/api/playlists/track-artwork/${encodeURIComponent(target.entityId)}`
    : `/api/library/artwork/${encodeURIComponent(target.entityKind)}/${encodeURIComponent(target.entityId)}`;
  const params = new URLSearchParams({
    ...Object.fromEntries(Object.entries(query).filter(([, value]) => value != null && value !== "")),
    v: String(updatedAt || "current"),
  });
  return `${route}?${params}`;
}

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { db } from "../config/db-sqlite.ts";
import { resolveAurralDataDir } from "../config/data-dir.ts";
import type { CustomArtworkRow } from "../db/rows.ts";
import { asAppError } from "../../lib/errors.ts";
import { inspectImageBuffer, optimizeImageBuffer, warmImageProxy } from "./imageProxyService.ts";

const ARTWORK_DIR = path.join(resolveAurralDataDir(), "custom-artwork");
const ENTITY_KINDS = new Set(["album", "track", "playlist-track"]);
const targetOperations = new Map<string, Promise<unknown>>();

const getArtworkStmt = db.prepare<[string, string], CustomArtworkRow>(
  "SELECT entity_kind, entity_id, content_type, source_url, updated_at FROM custom_artwork WHERE entity_kind = ? AND entity_id = ?",
);
const saveArtworkStmt = db.prepare<[string, string, string, string | null, number]>(`
  INSERT INTO custom_artwork (entity_kind, entity_id, content_type, source_url, updated_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(entity_kind, entity_id) DO UPDATE SET
    content_type = excluded.content_type,
    source_url = excluded.source_url,
    updated_at = excluded.updated_at
`);
const deleteArtworkStmt = db.prepare<[string, string]>(
  "DELETE FROM custom_artwork WHERE entity_kind = ? AND entity_id = ?",
);
const getArtworkRevisionStmt = db.prepare<[string], { value: string }>(
  "SELECT value FROM settings WHERE key = ?",
);
const saveArtworkRevisionStmt = db.prepare<[string, string]>(`
  INSERT INTO settings (key, value) VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`);

const artworkRevisionKey = (kind: string) => `custom-artwork:revision:${kind}`;

function advanceArtworkRevision(kind: string, candidate = Date.now()) {
  const key = artworkRevisionKey(kind);
  const current = Number(getArtworkRevisionStmt.get(key)?.value) || 0;
  const revision = Math.max(Date.now(), Number(candidate) || 0, current + 1);
  saveArtworkRevisionStmt.run(key, String(revision));
  return revision;
}

function normalizeTarget(kind: string, id: string | number) {
  const entityKind = String(kind || "")
    .trim()
    .toLowerCase();
  const entityId = String(id || "").trim();
  if (!ENTITY_KINDS.has(entityKind) || !entityId) {
    throw new Error("Invalid artwork target");
  }
  return { entityKind, entityId };
}

type ArtworkTarget = ReturnType<typeof normalizeTarget>;

function artworkPath(kind: string, id: string) {
  const key = crypto.createHash("sha256").update(`${kind}:${id}`).digest("hex");
  return path.join(ARTWORK_DIR, `${key}.image`);
}

async function withTargetOperation<T>(
  kind: string,
  id: string | number,
  operation: (target: ArtworkTarget) => Promise<T>,
) {
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

async function writeArtwork(
  target: ArtworkTarget,
  buffer: Buffer,
  contentType: string,
  sourceUrl: string | null = null,
) {
  await fs.promises.mkdir(ARTWORK_DIR, { recursive: true });
  const destination = artworkPath(target.entityKind, target.entityId);
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
  await fs.promises.writeFile(temporary, buffer);
  try {
    await fs.promises.rename(temporary, destination);
  } catch (error) {
    const code = asAppError(error)?.code;
    if (!code || !["EEXIST", "EPERM"].includes(String(code))) throw error;
    await fs.promises.unlink(destination).catch(() => {});
    await fs.promises.rename(temporary, destination);
  } finally {
    await fs.promises.unlink(temporary).catch(() => {});
  }
  const previousUpdatedAt =
    Number(getArtworkStmt.get(target.entityKind, target.entityId)?.updated_at) || 0;
  const updatedAt = Math.max(Date.now(), previousUpdatedAt + 1);
  saveArtworkStmt.run(target.entityKind, target.entityId, contentType, sourceUrl, updatedAt);
  advanceArtworkRevision(target.entityKind, updatedAt);
  return getCustomArtwork(target.entityKind, target.entityId)!;
}

export async function saveCustomArtworkUpload(
  kind: string,
  id: string | number,
  buffer: Buffer,
  contentType: string | undefined,
) {
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

export async function saveCustomArtworkUrl(kind: string, id: string | number, sourceUrl: unknown) {
  return withTargetOperation(kind, id, async (target) => {
    const url = String(sourceUrl || "").trim();
    if (!url) throw new Error("Image URL is required");
    const cached = await warmImageProxy(url);
    const buffer = await fs.promises.readFile(cached.imagePath);
    const { contentType } = cached.meta;
    if (!contentType) throw new Error("The image has no known content type");
    return writeArtwork(target, buffer, contentType, url);
  });
}

export function getCustomArtwork(kind: string, id: string | number) {
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

export function getCustomArtworkMap(kind: string, ids: (string | number)[]) {
  const entityKind = normalizeTarget(kind, "placeholder").entityKind;
  const entityIds = [...new Set((ids || []).map((id) => String(id || "").trim()).filter(Boolean))];
  if (!entityIds.length) return new Map();
  const placeholders = entityIds.map(() => "?").join(", ");
  const rows = db
    .prepare<(string | number)[], Pick<CustomArtworkRow, "entity_id" | "updated_at">>(
      `SELECT entity_id, updated_at FROM custom_artwork WHERE entity_kind = ? AND entity_id IN (${placeholders})`,
    )
    .all(entityKind, ...entityIds);
  return new Map(rows.map((row) => [String(row.entity_id), Number(row.updated_at)]));
}

export function getCustomArtworkRevision(kind: string) {
  const entityKind = normalizeTarget(kind, "placeholder").entityKind;
  return Number(getArtworkRevisionStmt.get(artworkRevisionKey(entityKind))?.value) || 0;
}

export async function removeCustomArtwork(kind: string, id: string | number) {
  return withTargetOperation(kind, id, async (target) => {
    const removed = deleteArtworkStmt.run(target.entityKind, target.entityId).changes > 0;
    await fs.promises.unlink(artworkPath(target.entityKind, target.entityId)).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
    if (removed) advanceArtworkRevision(target.entityKind);
  });
}

export function buildCustomArtworkUrl(
  kind: string,
  id: string | number,
  updatedAt?: number,
  query: Record<string, string | null | undefined> = {},
) {
  const target = normalizeTarget(kind, id);
  const route =
    target.entityKind === "playlist-track"
      ? `/api/playlists/track-artwork/${encodeURIComponent(target.entityId)}`
      : `/api/library/artwork/${encodeURIComponent(target.entityKind)}/${encodeURIComponent(target.entityId)}`;
  const params = new URLSearchParams({
    ...Object.fromEntries(
      Object.entries(query).filter(([, value]) => value != null && value !== ""),
    ),
    v: String(updatedAt || "current"),
  });
  return `${route}?${params}`;
}

import type { D1Database } from "@cloudflare/workers-types/index.ts";
import { MAX_SHARE_BYTES, parseShareManifest, withoutShareFiles } from "../../lib/shareManifest.ts";
import { allowedText } from "./handles.ts";

const SHELF_LIMIT = 60;
const SHELF_PER_ACCOUNT = 3;

const MAX_REF_LENGTH = 128;

export function readPublication(raw: string) {
  if (new TextEncoder().encode(raw).length > MAX_SHARE_BYTES) return "too_large" as const;
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return "invalid" as const;
  }
  if (!body || typeof body !== "object") return "invalid" as const;
  const manifest = parseShareManifest("manifest" in body ? body.manifest : null);
  if (manifest?.kind !== "playlist") return "invalid" as const;
  if (!allowedText(manifest.title)) return "title_not_allowed" as const;
  const ref =
    "ref" in body && typeof body.ref === "string" && body.ref.length <= MAX_REF_LENGTH
      ? body.ref
      : null;
  return { ref, playlist: withoutShareFiles(manifest) };
}

type Playlist = Extract<ReturnType<typeof readPublication>, object>["playlist"];

export const linkedLinkId = (db: D1Database, tokenHash: string) =>
  db
    .prepare("SELECT id FROM links WHERE token_hash = ? AND account_id IS NOT NULL")
    .bind(tokenHash)
    .first<string>("id");

export const publish = (
  db: D1Database,
  linkId: string,
  ref: string,
  playlist: Playlist,
  now = Date.now(),
) =>
  db
    .prepare(
      `INSERT INTO publications (id, link_id, ref, title, track_count, manifest, published_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (link_id, ref) DO UPDATE SET
         title = excluded.title, track_count = excluded.track_count,
         manifest = excluded.manifest, updated_at = excluded.updated_at
       RETURNING id, delisted`,
    )
    .bind(
      crypto.randomUUID(),
      linkId,
      ref,
      playlist.title,
      playlist.tracks.length,
      JSON.stringify(playlist),
      now,
      now,
    )
    .first<{ id: string; delisted: number }>();

export async function updatePublication(
  db: D1Database,
  linkId: string,
  id: string,
  playlist: Playlist,
  now = Date.now(),
) {
  const result = await db
    .prepare(
      "UPDATE publications SET title = ?, track_count = ?, manifest = ?, updated_at = ? WHERE id = ? AND link_id = ?",
    )
    .bind(playlist.title, playlist.tracks.length, JSON.stringify(playlist), now, id, linkId)
    .run();
  return result.meta.changes > 0;
}

export const unpublish = (db: D1Database, linkId: string, id: string) =>
  db
    .prepare("DELETE FROM publications WHERE id = ? AND link_id = ? AND delisted = 0")
    .bind(id, linkId)
    .run();

export const shelf = async (db: D1Database) =>
  (
    await db
      .prepare(
        `SELECT id, title, track_count AS trackCount, published_at AS publishedAt, handle,
           json_extract(manifest, '$.tracks[0].artistName') AS artist FROM (
           SELECT publications.*, handles.handle, ROW_NUMBER() OVER (
             PARTITION BY links.account_id ORDER BY publications.published_at DESC
           ) AS place
           FROM publications
           JOIN links ON links.id = publications.link_id
           JOIN handles ON handles.account_id = links.account_id
           WHERE publications.delisted = 0
         ) WHERE place <= ? ORDER BY publishedAt DESC LIMIT ?`,
      )
      .bind(SHELF_PER_ACCOUNT, SHELF_LIMIT)
      .all<{
        id: string;
        title: string;
        trackCount: number;
        publishedAt: number;
        handle: string;
        artist: string | null;
      }>()
  ).results;

export async function publicPlaylist(db: D1Database, id: string) {
  const row = await db
    .prepare(
      `SELECT publications.manifest, handles.handle FROM publications
       JOIN links ON links.id = publications.link_id
       JOIN handles ON handles.account_id = links.account_id
       WHERE publications.id = ? AND publications.delisted = 0`,
    )
    .bind(id)
    .first<{ manifest: string; handle: string }>();
  const manifest = row && parseShareManifest(JSON.parse(row.manifest));
  return manifest && row ? { id, handle: row.handle, manifest } : null;
}

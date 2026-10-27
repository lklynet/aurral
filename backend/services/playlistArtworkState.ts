import { db } from "../config/db-sqlite.ts";
import { PLAYLIST_COVER_TEMPLATES, type PlaylistCoverTemplate } from "./playlistCoverTemplates.ts";
import type { SettingsRow } from "../db/rows.ts";

export type PlaylistArtworkStyle = "artist" | "simple";
export type PlaylistArtworkState = {
  baseName?: string | null;
  flowRunAt?: number | null;
  revision?: number;
  mode: PlaylistArtworkStyle | "original" | "upload" | "removed";
  artistKey: string | null;
  template: PlaylistCoverTemplate | null;
  sourceUrl: string | null;
  fallbackSignature: string | null;
};
const read = db.prepare<[string], Pick<SettingsRow, "value">>(
  "SELECT value FROM settings WHERE key = ?",
);
const write = db.prepare<[string, string]>(
  "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
);
const remove = db.prepare<[string]>("DELETE FROM settings WHERE key = ?");
const revisions = db.prepare<[], Pick<SettingsRow, "key"> & { revision: number | null }>(
  "SELECT key, CAST(json_extract(value, '$.revision') AS INTEGER) AS revision FROM settings WHERE key GLOB 'playlist-artwork:*' AND json_valid(value)",
);
const key = (playlistId: string) => `playlist-artwork:${playlistId}`;

export function getPlaylistArtworkState(playlistId: string): PlaylistArtworkState | null {
  try {
    const value: unknown = JSON.parse(read.get(key(playlistId))?.value || "null");
    if (!value || typeof value !== "object") return null;
    const mode: unknown = Reflect.get(value, "mode");
    if (
      mode !== "artist" &&
      mode !== "simple" &&
      mode !== "original" &&
      mode !== "upload" &&
      mode !== "removed"
    )
      return null;
    const field = (name: string) => {
      const result: unknown = Reflect.get(value, name);
      return typeof result === "string" ? result : null;
    };
    const flowRunAt: unknown = Reflect.get(value, "flowRunAt");
    const revision: unknown = Reflect.get(value, "revision");
    return {
      mode,
      revision: typeof revision === "number" && Number.isFinite(revision) ? revision : 0,
      baseName: field("baseName"),
      flowRunAt: typeof flowRunAt === "number" && Number.isFinite(flowRunAt) ? flowRunAt : null,
      artistKey: field("artistKey"),
      template: PLAYLIST_COVER_TEMPLATES.find((template) => template === field("template")) || null,
      sourceUrl: field("sourceUrl"),
      fallbackSignature: field("fallbackSignature"),
    };
  } catch {
    return null;
  }
}

export function setPlaylistArtworkState(playlistId: string, state: PlaylistArtworkState) {
  const revision = Math.max(Date.now(), (getPlaylistArtworkState(playlistId)?.revision || 0) + 1);
  write.run(key(playlistId), JSON.stringify({ ...state, revision }));
}

export function deletePlaylistArtworkState(playlistId: string) {
  remove.run(key(playlistId));
}

export function getPlaylistArtworkRevisions() {
  return new Map(
    revisions
      .all()
      .flatMap(({ key, revision }) =>
        key && revision != null ? [[key.slice("playlist-artwork:".length), revision] as const] : [],
      ),
  );
}

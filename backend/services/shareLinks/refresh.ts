import { db } from "../../config/db-sqlite.ts";
import type { ShareLinksRow } from "../../db/rows.ts";
import {
  findSharedTrack,
  MAX_SHARE_BYTES,
  parseShareManifest,
} from "../../../lib/shareManifest.ts";
import { asAppError } from "../../../lib/errors.ts";
import { logger } from "../logger.ts";
import { resolveShareManifest } from "./metadata.ts";
import { publishShareManifest } from "./hosting.ts";
import { flowPlaylistConfig } from "../playlists/flowPlaylistConfig.ts";

export async function refreshPlaylistShares(now = Date.now()) {
  const rows = db
    .prepare<[], ShareLinksRow>(
      "SELECT * FROM share_links WHERE kind = 'playlist' AND manifest IS NOT NULL",
    )
    .all();
  let published = 0;
  for (const row of rows) {
    const previous = parseShareManifest(JSON.parse(row.manifest!));
    const filesLive = row.share_files === 1 && (row.expires_at == null || row.expires_at > now);
    const sharedTracks = filesLive
      ? (previous?.tracks.filter((track) => track.path !== null) ?? [])
      : [];
    const shared = new Set(sharedTracks.map((track) => track.path));
    try {
      if (!flowPlaylistConfig.getStaticPlaylist(row.target_ref)) {
        await publishShareManifest(row.token, null);
        db.prepare<[number]>("DELETE FROM share_links WHERE id = ?").run(row.id);
        continue;
      }
      const manifest = resolveShareManifest(
        { kind: "playlist", targetRef: row.target_ref, albumRef: null },
        null,
      );
      if (!manifest) {
        logger.warn("share", "Shared playlist is too large to update", { title: row.title });
        continue;
      }
      manifest.tracks = manifest.tracks.map((track) => {
        if (shared.has(track.path)) return track;
        const file = findSharedTrack(sharedTracks, track);
        return {
          ...track,
          path: file?.path ?? null,
          size: file?.size ?? null,
          format: file?.format ?? null,
        };
      });
      const next = JSON.stringify(manifest);
      if (next === row.manifest) continue;
      if (Buffer.byteLength(next) > MAX_SHARE_BYTES - 1024) {
        logger.warn("share", "Shared playlist is too large to update", { title: manifest.title });
        continue;
      }
      await publishShareManifest(row.token, manifest, filesLive);
      const saved = db
        .prepare<[string, string, number]>(
          "UPDATE share_links SET manifest = ?, title = ? WHERE id = ?",
        )
        .run(next, manifest.title, row.id).changes;
      if (!saved) {
        await publishShareManifest(row.token, null);
        continue;
      }
      published += 1;
    } catch (error) {
      logger.warn("share", "Could not update a shared playlist", {
        title: row.title,
        message: asAppError(error)?.message,
      });
    }
  }
  return { checked: rows.length, published };
}

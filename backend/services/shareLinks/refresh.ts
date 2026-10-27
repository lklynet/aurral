import { db } from "../../config/db-sqlite.ts";
import type { ShareLinksRow } from "../../db/rows.ts";
import { MAX_SHARE_BYTES, parseShareManifest } from "../../../lib/shareManifest.ts";
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
    const shared = new Set(filesLive ? previous?.tracks.map((track) => track.path) : []);
    shared.delete(null);
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
      manifest.tracks = manifest.tracks.map((track) =>
        shared.has(track.path) ? track : { ...track, path: null, size: null, format: null },
      );
      const next = JSON.stringify(manifest);
      if (next === row.manifest) continue;
      if (Buffer.byteLength(next) > MAX_SHARE_BYTES - 1024) {
        logger.warn("share", "Shared playlist is too large to update", { title: manifest.title });
        continue;
      }
      await publishShareManifest(row.token, manifest, filesLive);
      db.prepare<[string, string, number]>(
        "UPDATE share_links SET manifest = ?, title = ? WHERE id = ?",
      ).run(next, manifest.title, row.id);
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

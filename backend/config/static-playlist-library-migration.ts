import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { DownloadJobsRow, JobsRow } from "../db/rows.ts";
import { logger } from "../services/logger.ts";
import { pairJobsWithPlaylistTracks } from "../services/playlists/playlistTracks.ts";
import { isRecord } from "../../lib/isRecord.ts";

const MIGRATION_KEY = "migration:static-playlists-reference-library-v1";

type OwnedRow = Pick<
  DownloadJobsRow,
  | "artist_name"
  | "track_name"
  | "album_name"
  | "artist_mbid"
  | "album_mbid"
  | "track_mbid"
  | "release_year"
  | "status"
  | "final_path"
  | "external_path"
  | "managed_by"
  | "reused_library_file"
  | "upgrade_for_job_id"
  | "created_at"
> & { id: string };

const playlistTrack = (row: OwnedRow) => ({
  id: row.id,
  artistName: row.artist_name,
  trackName: row.track_name,
  albumName: row.album_name,
  artistMbid: row.artist_mbid,
  albumMbid: row.album_mbid,
  trackMbid: row.track_mbid,
  releaseYear: row.release_year,
  createdAt: row.created_at,
});

const readJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const ownFile = (row: OwnedRow) =>
  row.status === "done" && row.final_path && !row.upgrade_for_job_id ? row.final_path : null;

export function migrateStaticPlaylistsToLibrary(db: Database.Database) {
  db.transaction(() => {
    const claimed = db
      .prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, '1')")
      .run(MIGRATION_KEY);
    if (claimed.changes === 0) return;
    const stored = db
      .prepare<[], { value: string }>("SELECT value FROM settings WHERE key = 'staticPlaylists'")
      .get();
    const parsed = stored ? readJson(stored.value) : [];
    const playlists = (Array.isArray(parsed) ? parsed : []).filter(isRecord);
    const playlistIds = playlists
      .map((playlist) => playlist.id)
      .filter((id) => typeof id === "string");
    if (playlistIds.length === 0) return;

    const libraryGeneration =
      db
        .prepare<[], { generation: number }>(
          "SELECT generation FROM download_cancellations WHERE owner_id = 'library'",
        )
        .get()?.generation ?? 0;
    const libraryFiles = new Map(
      db
        .prepare<[], { id: string; final_path: string }>(
          `SELECT id, final_path FROM download_jobs
           WHERE owner_id = 'library' AND status = 'done' AND final_path IS NOT NULL
             AND upgrade_for_job_id IS NULL
           ORDER BY created_at, id`,
        )
        .all()
        .map((row) => [row.final_path, row.id]),
    );
    const ownedStmt = db.prepare<[string], OwnedRow>(
      "SELECT * FROM download_jobs WHERE owner_id = ? ORDER BY created_at, id",
    );
    const moveStmt = db.prepare<[number, string | null, string]>(
      `UPDATE download_jobs
       SET owner_id = 'library', owner_type = 'library', playlist_generation = ?, started_by_playlist = ?
       WHERE id = ?`,
    );
    const deleteStmt = db.prepare<[string]>("DELETE FROM download_jobs WHERE id = ?");
    const upgradeStmt = db.prepare<[string, string]>(
      "UPDATE download_jobs SET upgrade_for_job_id = ? WHERE upgrade_for_job_id = ?",
    );

    const redirect = new Map<string, string>();
    const pairings = new Map<string, ReturnType<typeof pairJobsWithPlaylistTracks>>();
    let moved = 0;
    for (const playlist of playlists) {
      if (typeof playlist.id !== "string") continue;
      const rows = ownedStmt.all(playlist.id);
      if (rows.length === 0) continue;
      const ownedIds = new Set(rows.map((row) => row.id));
      const tracks = (Array.isArray(playlist.tracks) ? playlist.tracks : []).map((track) =>
        isRecord(track) && (!track.canonicalJobId || ownedIds.has(String(track.canonicalJobId)))
          ? track
          : {},
      );
      pairings.set(
        playlist.id,
        pairJobsWithPlaylistTracks(
          rows.filter((row) => !row.upgrade_for_job_id).map(playlistTrack),
          tracks,
        ),
      );
      for (const row of rows) {
        const file = ownFile(row);
        const survivor = file ? libraryFiles.get(file) : undefined;
        if (survivor) {
          upgradeStmt.run(survivor, row.id);
          deleteStmt.run(row.id);
          redirect.set(row.id, survivor);
          continue;
        }
        const downloaded =
          row.status !== "done" ||
          (row.managed_by !== "lidarr" && !row.external_path && !row.reused_library_file);
        moveStmt.run(libraryGeneration, downloaded ? playlist.id : null, row.id);
        if (file) libraryFiles.set(file, row.id);
        moved += 1;
      }
    }

    const nextPlaylists = playlists.map((playlist) => {
      const tracks: Record<string, unknown>[] = (
        Array.isArray(playlist.tracks) ? playlist.tracks : []
      ).filter(isRecord);
      for (const { job, trackIndex } of pairings.get(String(playlist.id)) ?? []) {
        const { id, createdAt: _, ...track } = job;
        if (trackIndex >= 0) tracks[trackIndex] = { ...tracks[trackIndex], canonicalJobId: id };
        else tracks.push({ ...track, canonicalJobId: id, membershipId: randomUUID() });
      }
      return {
        ...playlist,
        tracks: tracks.map((track) => {
          const jobId = String(track.canonicalJobId || "");
          return redirect.has(jobId) ? { ...track, canonicalJobId: redirect.get(jobId) } : track;
        }),
      };
    });
    db.prepare("UPDATE settings SET value = ? WHERE key = 'staticPlaylists'").run(
      JSON.stringify(nextPlaylists),
    );
    const clearSharedMark = db.prepare<[string, string]>(
      "UPDATE download_jobs SET started_by_playlist = NULL WHERE id = ? AND started_by_playlist != ?",
    );
    for (const [index, { tracks }] of nextPlaylists.entries()) {
      for (const { canonicalJobId } of tracks) {
        if (canonicalJobId)
          clearSharedMark.run(String(canonicalJobId), String(playlists[index]?.id));
      }
    }

    const staticIds = new Set(playlistIds);
    const rewritePayload = db.prepare<[string, number]>("UPDATE jobs SET payload = ? WHERE id = ?");
    for (const row of db
      .prepare<[], Pick<JobsRow, "id" | "payload">>(
        "SELECT id, payload FROM jobs WHERE queue = 'download-pipeline' AND state IN ('pending', 'running')",
      )
      .all()) {
      const payload = readJson(row.payload);
      if (!isRecord(payload) || !staticIds.has(String(payload.playlistId))) continue;
      const upgradeFor = redirect.get(String(payload.upgradeForJobId));
      rewritePayload.run(
        JSON.stringify({
          ...payload,
          playlistId: "library",
          playlistGeneration: libraryGeneration,
          ...(upgradeFor && { upgradeForJobId: upgradeFor }),
        }),
        row.id,
      );
    }
    const placeholders = playlistIds.map(() => "?").join(", ");
    db.prepare(
      `UPDATE download_provider_work SET owner_id = 'library' WHERE owner_id IN (${placeholders})`,
    ).run(...playlistIds);
    db.prepare(`DELETE FROM download_cancellations WHERE owner_id IN (${placeholders})`).run(
      ...playlistIds,
    );
    db.exec(`
      DELETE FROM settings
      WHERE key LIKE 'playlistRemovedMedia:%' OR key LIKE 'playlistTrackRemovalSync:%'
    `);
    if (moved || redirect.size) {
      logger.info("system", "Static playlist downloads now belong to the Library", {
        moved,
        merged: redirect.size,
      });
    }
  })();
}

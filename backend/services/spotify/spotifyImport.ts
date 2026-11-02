import { db } from "../../config/db-sqlite.ts";
import type { SpotifyImportArtist } from "../../../lib/spotifyExport.ts";
import type { SpotifyImportArtistsRow } from "../../db/rows.ts";

const deleteStmt = db.prepare<[number]>("DELETE FROM spotify_import_artists WHERE user_id = ?");
const insertStmt = db.prepare<
  [number, string, number, number, number, number, number | null, number | null, number]
>(`
  INSERT OR REPLACE INTO spotify_import_artists
    (user_id, artist, plays, score, liked_tracks, followed, first_played_at, last_played_at, imported_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const summaryStmt = db.prepare<
  [number],
  {
    artists: number;
    plays: number | null;
    liked_tracks: number | null;
    followed: number | null;
    first_played_at: number | null;
    last_played_at: number | null;
    imported_at: number | null;
  }
>(`
  SELECT COUNT(*) AS artists, SUM(plays) AS plays, SUM(liked_tracks) AS liked_tracks,
         SUM(followed) AS followed, MIN(first_played_at) AS first_played_at,
         MAX(last_played_at) AS last_played_at, MAX(imported_at) AS imported_at
  FROM spotify_import_artists
  WHERE user_id = ?
`);
const topStmt = db.prepare<[number, number], Pick<SpotifyImportArtistsRow, "artist" | "score">>(
  "SELECT artist, score FROM spotify_import_artists WHERE user_id = ? ORDER BY score DESC LIMIT ?",
);

export const getSpotifyImportSummary = (userId: number) => {
  const row = summaryStmt.get(userId);
  if (!row?.artists || row.imported_at == null) return null;
  return {
    artists: row.artists,
    plays: row.plays ?? 0,
    likedTracks: row.liked_tracks ?? 0,
    followedArtists: row.followed ?? 0,
    firstPlayedAt: row.first_played_at,
    lastPlayedAt: row.last_played_at,
    importedAt: row.imported_at,
  };
};

export const saveSpotifyImport = db.transaction(
  (userId: number, artists: SpotifyImportArtist[], importedAt = Date.now()) => {
    deleteStmt.run(userId);
    for (const artist of artists) {
      insertStmt.run(
        userId,
        artist.name,
        artist.plays,
        artist.score,
        artist.likedTracks,
        artist.followed ? 1 : 0,
        artist.firstPlayedAt,
        artist.lastPlayedAt,
        importedAt,
      );
    }
  },
);

export const clearSpotifyImport = (userId: number) => deleteStmt.run(userId).changes > 0;

export const getTopSpotifyImportArtists = (userId: number, limit: number) =>
  topStmt.all(userId, limit).map((row) => ({
    artistName: row.artist,
    mbid: null,
    playcount: Math.round(row.score),
  }));

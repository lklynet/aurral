import { db } from "../config/db-sqlite.ts";
import type { LibraryTracksRow } from "../db/rows.ts";
import { toQueueTracks } from "./queueTracks.ts";

const WEEK_MS = 7 * 86_400_000;
const WEEKS = 52;
const MIN_PLAYS = 10;
const MAX_RANK = 20;
const TOP_TRACKS = 3;

// The unary plus keeps SQLite on the artist name index instead of walking every play without an ID.
const ARTIST_PLAYS = `(
  SELECT * FROM play_events WHERE user_id = @userId AND artist_mbid = @mbid
  UNION ALL
  SELECT * FROM play_events
  WHERE user_id = @userId AND +artist_mbid IS NULL AND artist = @artistName COLLATE NOCASE
)`;

type ArtistParams = { userId: number; mbid: string; artistName: string };

const summaryStmt = db.prepare<
  [ArtistParams],
  { plays: number; durationMs: number | null; firstPlayedAt: number | null }
>(
  `SELECT COUNT(*) AS plays, SUM(duration_ms) AS durationMs, MIN(played_at) AS firstPlayedAt
   FROM ${ARTIST_PLAYS}`,
);

const weeksStmt = db.prepare<[ArtistParams & { since: number }], { week: number; plays: number }>(
  `SELECT CAST((played_at - @since) / ${WEEK_MS} AS INTEGER) AS week, COUNT(*) AS plays
   FROM ${ARTIST_PLAYS} WHERE +played_at >= @since
   GROUP BY week`,
);

const rankStmt = db.prepare<[ArtistParams & { since: number; plays: number }], { ahead: number }>(
  `SELECT COUNT(*) AS ahead FROM (
     SELECT 1 FROM play_events
     WHERE user_id = @userId AND played_at >= @since AND artist_mbid IS NOT @mbid
       AND NOT (artist_mbid IS NULL AND artist = @artistName COLLATE NOCASE)
     GROUP BY artist COLLATE NOCASE HAVING COUNT(*) > @plays
   )`,
);

const topTracksStmt = db.prepare<
  [ArtistParams],
  { title: string; album: string | null; trackMbid: string | null; plays: number }
>(
  `SELECT title, album, track_mbid AS trackMbid, COUNT(*) AS plays, MAX(played_at) AS lastPlayedAt
   FROM ${ARTIST_PLAYS}
   GROUP BY title COLLATE NOCASE
   ORDER BY plays DESC, lastPlayedAt DESC
   LIMIT ${TOP_TRACKS}`,
);

const libraryTracksStmt = db.prepare<[...(string | null)[]], Pick<LibraryTracksRow, "id">>(
  `SELECT DISTINCT track.id FROM library_tracks AS track
   JOIN library_album_tracks AS link ON link.track_id = track.id
   JOIN library_albums AS album ON album.id = link.album_id
   JOIN library_artists AS artist ON artist.id = album.artist_id
   WHERE track.title COLLATE NOCASE IN (${Array.from({ length: TOP_TRACKS }, () => "?").join(", ")})
     AND (artist.mbid = ? OR artist.name = ? COLLATE NOCASE OR track.artist_name = ? COLLATE NOCASE)`,
);

const libraryArtistPlaysStmt = db.prepare<[number, number, number], { plays: number }>(
  `SELECT
     (SELECT COUNT(*) FROM play_events AS play
      WHERE play.user_id = ? AND play.artist_mbid = library.mbid)
     + (SELECT COUNT(*) FROM play_events AS play
        WHERE play.user_id = ? AND play.artist = library.name COLLATE NOCASE
          AND (play.artist_mbid IS NULL OR library.mbid IS NULL)) AS plays
   FROM library_artists AS library
   WHERE library.id = ?`,
);

export const getLibraryArtistPlays = (userId: number, artistId: number) =>
  libraryArtistPlaysStmt.get(userId, userId, artistId)?.plays ?? null;

const sameText = (left: string | null | undefined, right: string | null | undefined) =>
  Boolean(left && right && left.localeCompare(right, undefined, { sensitivity: "accent" }) === 0);

function playableTracks(
  mbid: string,
  artistName: string,
  tracks: { title: string; trackMbid: string | null }[],
) {
  const titles = Array.from({ length: TOP_TRACKS }, (_, index) => tracks[index]?.title ?? null);
  const ids = libraryTracksStmt.all(...titles, mbid, artistName, artistName).map((row) => row.id);
  const queue = ids.length ? toQueueTracks(ids) : [];
  return tracks.map(
    (track) =>
      queue.find((entry) => track.trackMbid && entry.trackMbid === track.trackMbid) ??
      queue.find((entry) => sameText(entry.title, track.title)) ??
      null,
  );
}

export function getArtistListening(
  userId: number,
  mbid: string,
  artistName: string,
  now = Date.now(),
) {
  const artist = { userId, mbid, artistName };
  const summary = summaryStmt.get(artist);
  if (!summary || summary.plays < MIN_PLAYS) return null;
  const since = now - WEEKS * WEEK_MS;
  const counts = new Map<number, number>();
  for (const row of weeksStmt.all({ ...artist, since })) {
    const week = Math.min(row.week, WEEKS - 1);
    counts.set(week, (counts.get(week) ?? 0) + row.plays);
  }
  const weeks = Array.from({ length: WEEKS }, (_, week) => counts.get(week) ?? 0);
  const yearPlays = weeks.reduce((total, plays) => total + plays, 0);
  const rank =
    yearPlays > 0 ? (rankStmt.get({ ...artist, since, plays: yearPlays })?.ahead ?? 0) + 1 : null;
  const topTracks = topTracksStmt.all(artist);
  const queue = playableTracks(mbid, artistName, topTracks);
  return {
    plays: summary.plays,
    durationMs: summary.durationMs ?? 0,
    firstPlayedAt: summary.firstPlayedAt,
    rank: rank !== null && rank <= MAX_RANK ? rank : null,
    weeksSince: since,
    weeks,
    topTracks: topTracks.map((track, index) => ({
      title: track.title,
      album: track.album,
      plays: track.plays,
      queueTrack: queue[index] ?? null,
    })),
  };
}

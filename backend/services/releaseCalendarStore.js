import { db } from "../config/db-sqlite.js";

const parseJsonArray = (value) => {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const upsertRelease = db.prepare(`
  INSERT INTO library_release_calendar (
    release_group_mbid,
    artist_id,
    title,
    release_date,
    release_type,
    secondary_types_json,
    release_statuses_json,
    present,
    refreshed_at,
    created_at,
    updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
  ON CONFLICT(release_group_mbid) DO UPDATE SET
    artist_id = excluded.artist_id,
    title = excluded.title,
    release_date = excluded.release_date,
    release_type = excluded.release_type,
    secondary_types_json = excluded.secondary_types_json,
    release_statuses_json = excluded.release_statuses_json,
    present = 1,
    refreshed_at = excluded.refreshed_at,
    updated_at = excluded.updated_at
`);

const selectArtistReleases = db.prepare(`
  SELECT release_group_mbid, present
  FROM library_release_calendar
  WHERE artist_id = ?
`);

const markReleaseAbsent = db.prepare(`
  UPDATE library_release_calendar
  SET present = 0, refreshed_at = ?, updated_at = ?
  WHERE release_group_mbid = ?
`);

export function upsertReleaseCalendarEntry({
  releaseGroupMbid,
  artistId,
  title,
  releaseDate,
  releaseType = null,
  secondaryTypes = [],
  releaseStatuses = [],
  refreshedAt = Date.now(),
}) {
  const timestamp = Number(refreshedAt) || Date.now();
  upsertRelease.run(
    String(releaseGroupMbid || "").trim(),
    Number(artistId),
    String(title || "Unknown Album").trim() || "Unknown Album",
    String(releaseDate || "").trim(),
    releaseType ? String(releaseType).trim() : null,
    JSON.stringify(Array.isArray(secondaryTypes) ? secondaryTypes : []),
    JSON.stringify(Array.isArray(releaseStatuses) ? releaseStatuses : []),
    timestamp,
    timestamp,
    timestamp,
  );
}

export function markUnseenReleaseCalendarEntries(artistId, seenReleaseGroupMbids, refreshedAt = Date.now()) {
  const seen = new Set(seenReleaseGroupMbids);
  const timestamp = Number(refreshedAt) || Date.now();
  let stale = 0;
  for (const row of selectArtistReleases.all(Number(artistId))) {
    if (seen.has(row.release_group_mbid) || row.present === 0) continue;
    stale += markReleaseAbsent.run(timestamp, timestamp, row.release_group_mbid).changes;
  }
  return stale;
}

export function getReleaseCalendarEntries({
  from,
  to = null,
  limit = 100,
  artistIds = [],
} = {}) {
  const fromDate = String(from || "").trim();
  const toDate = String(to || "").trim();
  if (!fromDate) return [];
  const conditions = [
    "calendar.present = 1",
    "calendar.release_date >= ?",
    `NOT EXISTS (
      SELECT 1
      FROM library_albums AS owned_album
      JOIN library_album_tracks AS owned_relation ON owned_relation.album_id = owned_album.id
      JOIN library_media_files AS owned_media
        ON owned_media.track_id = owned_relation.track_id
        AND (owned_media.album_id = owned_relation.album_id OR owned_media.album_id IS NULL)
      WHERE owned_album.artist_id = calendar.artist_id
        AND (
          owned_album.release_group_mbid = calendar.release_group_mbid
          OR owned_album.mbid = calendar.release_group_mbid
        )
        AND owned_media.available = 1
    )`,
  ];
  const parameters = [fromDate];
  if (toDate) {
    conditions.push("calendar.release_date <= ?");
    parameters.push(toDate);
  }
  const normalizedArtistIds = [...new Set(
    (Array.isArray(artistIds) ? artistIds : [])
      .map((value) => Number(value))
      .filter((value) => Number.isSafeInteger(value) && value > 0),
  )];
  if (Array.isArray(artistIds) && artistIds.length > 0) {
    if (normalizedArtistIds.length === 0) return [];
    conditions.push("calendar.artist_id IN (SELECT CAST(value AS INTEGER) FROM json_each(?))");
    parameters.push(JSON.stringify(normalizedArtistIds));
  }
  parameters.push(Math.min(1000, Math.max(1, Number.parseInt(limit, 10) || 100)));

  const rows = db.prepare(`
    WITH calendar_page AS MATERIALIZED (
      SELECT calendar.*
      FROM library_release_calendar AS calendar
      WHERE ${conditions.join(" AND ")}
      ORDER BY calendar.release_date DESC, calendar.release_group_mbid
      LIMIT ?
    ), matched_albums AS MATERIALIZED (
      SELECT
        calendar.release_group_mbid,
        album.id AS album_id
      FROM calendar_page AS calendar
      LEFT JOIN library_albums AS album ON album.id = (
        SELECT candidate.id
        FROM library_albums AS candidate
        WHERE candidate.artist_id = calendar.artist_id
          AND (
            candidate.release_group_mbid = calendar.release_group_mbid
            OR candidate.mbid = calendar.release_group_mbid
          )
        ORDER BY candidate.id
        LIMIT 1
      )
    )
    SELECT
      calendar.*,
      artist.mbid AS artist_mbid,
      artist.name AS artist_name,
      matched.album_id,
      COUNT(DISTINCT relation.track_id) AS track_count,
      COUNT(DISTINCT CASE WHEN media.available = 1 THEN relation.track_id END) AS available_track_count,
      COALESCE(SUM(CASE WHEN media.available = 1 THEN media.size ELSE 0 END), 0) AS size_on_disk
    FROM calendar_page AS calendar
    JOIN library_artists AS artist ON artist.id = calendar.artist_id
    LEFT JOIN matched_albums AS matched
      ON matched.release_group_mbid = calendar.release_group_mbid
    LEFT JOIN library_album_tracks AS relation ON relation.album_id = matched.album_id
    LEFT JOIN library_media_files AS media
      ON media.track_id = relation.track_id
      AND (media.album_id = relation.album_id OR media.album_id IS NULL)
    GROUP BY calendar.release_group_mbid
    ORDER BY calendar.release_date DESC, calendar.release_group_mbid
  `).all(...parameters);

  return rows.map((row) => {
    const trackCount = Number(row.track_count || 0);
    const availableTrackCount = Number(row.available_track_count || 0);
    return {
      id: row.release_group_mbid,
      providerId: row.release_group_mbid,
      artistId: String(row.artist_id),
      artistName: row.artist_name,
      artistMbid: row.artist_mbid || null,
      foreignArtistId: row.artist_mbid || null,
      mbid: row.release_group_mbid,
      releaseGroupMbid: row.release_group_mbid,
      foreignAlbumId: row.release_group_mbid,
      albumName: row.title,
      title: row.title,
      releaseDate: row.release_date,
      albumType: row.release_type || null,
      secondaryTypes: parseJsonArray(row.secondary_types_json),
      releaseStatuses: parseJsonArray(row.release_statuses_json),
      available: false,
      trackCount,
      availableTrackCount,
      statistics: {
        trackCount,
        trackFileCount: availableTrackCount,
        sizeOnDisk: Number(row.size_on_disk || 0),
        percentOfTracks: 0,
      },
    };
  });
}

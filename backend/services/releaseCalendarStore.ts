import * as v from "valibot";
import { db, dbHelpers } from "../config/db-sqlite.ts";
import { listOf } from "../db/helpers/storedSchemas.ts";
import { MONITORED_AURRAL_ALBUM_CONDITION } from "./monitoring.ts";
import type { LibraryReleaseCalendarRow, ReleaseFeedRow } from "../db/rows.ts";

type CalendarEntryRow = LibraryReleaseCalendarRow & {
  artist_mbid: string | null;
  cover_url: ReleaseFeedRow["cover_url"];
  artist_name: string;
  album_id: number | null;
  track_count: number;
  available_track_count: number;
  size_on_disk: number;
  requested: number;
};

const parseStringList = (value: string | null) =>
  dbHelpers.readJSON(listOf(v.string()), value, "release calendar") ?? [];

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
  ON CONFLICT(release_group_mbid, artist_id) DO UPDATE SET
    title = excluded.title,
    release_date = excluded.release_date,
    release_type = excluded.release_type,
    secondary_types_json = excluded.secondary_types_json,
    release_statuses_json = excluded.release_statuses_json,
    present = 1,
    refreshed_at = excluded.refreshed_at,
    updated_at = excluded.updated_at
`);

const selectCalendarArtist = db.prepare(`
  SELECT 1 FROM library_artists WHERE mbid IS NOT NULL AND TRIM(mbid) != '' LIMIT 1
`);

const ownedReleaseGroupCondition = (releaseGroupMbid: string) => `EXISTS (
  SELECT 1
  FROM library_albums AS owned_album
  JOIN library_album_tracks AS owned_relation ON owned_relation.album_id = owned_album.id
  JOIN library_media_files AS owned_media
    ON owned_media.track_id = owned_relation.track_id
    AND (owned_media.album_id = owned_relation.album_id OR owned_media.album_id IS NULL)
  WHERE (
      owned_album.release_group_mbid = ${releaseGroupMbid}
      OR owned_album.mbid = ${releaseGroupMbid}
    )
    AND owned_media.available = 1
)`;

export function upsertReleaseCalendarEntry({
  releaseGroupMbid,
  artistId,
  title,
  releaseDate,
  releaseType = null,
  secondaryTypes = [],
  releaseStatuses = [],
  refreshedAt = Date.now(),
}: {
  releaseGroupMbid: string;
  artistId: number;
  title: string;
  releaseDate: string;
  releaseType?: string | null;
  secondaryTypes?: string[];
  releaseStatuses?: string[];
  refreshedAt?: number;
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

export function hasReleaseCalendarArtists() {
  return Boolean(selectCalendarArtist.get());
}

const selectFeedFetchedAt = db.prepare<[], { fetched_at: ReleaseFeedRow["fetched_at"] | null }>(
  "SELECT MAX(fetched_at) AS fetched_at FROM release_feed",
);
const clearFeed = db.prepare("DELETE FROM release_feed");
const insertFeedRelease = db.prepare<
  [string, string, string, string, string, string | null, number]
>(`
  INSERT OR REPLACE INTO release_feed (
    artist_mbid, release_group_mbid, title, release_date, release_type, cover_url, fetched_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const projectFeed = db.prepare<[number, number, number]>(`
  INSERT INTO library_release_calendar (
    release_group_mbid, artist_id, title, release_date, release_type,
    secondary_types_json, release_statuses_json, present, refreshed_at, created_at, updated_at
  )
  SELECT feed.release_group_mbid, artist.id, feed.title, feed.release_date, feed.release_type,
    '[]', '[]', 1, ?, ?, ?
  FROM release_feed AS feed
  JOIN library_artists AS artist ON LOWER(artist.mbid) = feed.artist_mbid
  WHERE true
  ON CONFLICT(release_group_mbid, artist_id) DO UPDATE SET
    title = excluded.title,
    release_date = excluded.release_date,
    release_type = excluded.release_type,
    secondary_types_json = excluded.secondary_types_json,
    release_statuses_json = excluded.release_statuses_json,
    present = 1,
    refreshed_at = excluded.refreshed_at,
    updated_at = excluded.updated_at
`);
const markGone = db.prepare<[number, string, string]>(`
  UPDATE library_release_calendar AS entry
  SET present = 0, updated_at = ?
  WHERE present = 1
    AND release_date BETWEEN ? AND ?
    AND NOT EXISTS (
      SELECT 1 FROM release_feed AS feed
      JOIN library_artists AS artist ON LOWER(artist.mbid) = feed.artist_mbid
      WHERE feed.release_group_mbid = entry.release_group_mbid AND artist.id = entry.artist_id
    )
`);

export function releaseFeedFetchedAt() {
  return selectFeedFetchedAt.get()?.fetched_at ?? null;
}

export function replaceReleaseFeed(
  releases: {
    artistMbids: string[];
    releaseGroupMbid: string;
    title: string;
    releaseDate: string;
    type: string;
    coverUrl: string | null;
  }[],
  at: number,
) {
  clearFeed.run();
  for (const release of releases) {
    for (const artistMbid of release.artistMbids) {
      insertFeedRelease.run(
        artistMbid,
        release.releaseGroupMbid,
        release.title,
        release.releaseDate,
        release.type,
        release.coverUrl,
        at,
      );
    }
  }
}

export function projectReleaseFeed({ from, to, at }: { from: string; to: string; at: number }) {
  return {
    releases: projectFeed.run(at, at, at).changes,
    gone: markGone.run(at, from, to).changes,
  };
}

export function getReleaseCalendarEntries({
  from,
  to = null,
  limit = 100,
  artistIds = [],
  soonestFirst = false,
}: {
  from?: string;
  to?: string | null;
  limit?: number;
  artistIds?: unknown[];
  soonestFirst?: boolean;
} = {}) {
  const fromDate = String(from || "").trim();
  const toDate = String(to || "").trim();
  if (!fromDate) return [];
  const conditions = [
    "calendar.present = 1",
    "calendar.release_date >= ?",
    `NOT ${ownedReleaseGroupCondition("calendar.release_group_mbid")}`,
  ];
  const parameters: (string | number)[] = [fromDate];
  if (toDate) {
    conditions.push("calendar.release_date <= ?");
    parameters.push(toDate);
  }
  const normalizedArtistIds = [
    ...new Set(
      (Array.isArray(artistIds) ? artistIds : [])
        .map((value) => Number(value))
        .filter((value) => Number.isSafeInteger(value) && value > 0),
    ),
  ];
  if (Array.isArray(artistIds) && artistIds.length > 0) {
    if (normalizedArtistIds.length === 0) return [];
    conditions.push("calendar.artist_id IN (SELECT CAST(value AS INTEGER) FROM json_each(?))");
    parameters.push(JSON.stringify(normalizedArtistIds));
  }
  parameters.push(Math.min(1000, Math.max(1, Number.parseInt(String(limit), 10) || 100)));
  const order = soonestFirst ? "ASC" : "DESC";

  const rows = db
    .prepare<(string | number)[], CalendarEntryRow>(`
    WITH eligible_calendar AS MATERIALIZED (
      SELECT
        calendar.*,
        ROW_NUMBER() OVER (
          PARTITION BY calendar.release_group_mbid
          ORDER BY calendar.artist_id
        ) AS release_rank
      FROM library_release_calendar AS calendar
      WHERE ${conditions.join(" AND ")}
    ), calendar_page AS MATERIALIZED (
      SELECT *
      FROM eligible_calendar
      WHERE release_rank = 1
      ORDER BY release_date ${order}, release_group_mbid
      LIMIT ?
    ), matched_albums AS MATERIALIZED (
      SELECT
        calendar.release_group_mbid,
        calendar.artist_id,
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
      (
        SELECT feed.cover_url FROM release_feed AS feed
        WHERE feed.artist_mbid = LOWER(artist.mbid)
          AND feed.release_group_mbid = calendar.release_group_mbid
      ) AS cover_url,
      matched.album_id,
      COUNT(DISTINCT relation.track_id) AS track_count,
      COUNT(DISTINCT CASE WHEN media.available = 1 THEN relation.track_id END) AS available_track_count,
      COALESCE(SUM(CASE WHEN media.available = 1 THEN media.size ELSE 0 END), 0) AS size_on_disk,
      EXISTS (
        SELECT 1
        FROM library_management AS management
        JOIN library_albums AS album ON album.id = management.entity_id
        WHERE album.id = matched.album_id AND ${MONITORED_AURRAL_ALBUM_CONDITION}
      ) AS requested
    FROM calendar_page AS calendar
    JOIN library_artists AS artist ON artist.id = calendar.artist_id
    LEFT JOIN matched_albums AS matched
      ON matched.release_group_mbid = calendar.release_group_mbid
      AND matched.artist_id = calendar.artist_id
    LEFT JOIN library_album_tracks AS relation ON relation.album_id = matched.album_id
    LEFT JOIN library_media_files AS media
      ON media.track_id = relation.track_id
      AND (media.album_id = relation.album_id OR media.album_id IS NULL)
    GROUP BY calendar.release_group_mbid, calendar.artist_id
    ORDER BY calendar.release_date ${order}, calendar.release_group_mbid
  `)
    .all(...parameters);

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
      coverUrl: row.cover_url,
      albumType: row.release_type || null,
      secondaryTypes: parseStringList(row.secondary_types_json),
      releaseStatuses: parseStringList(row.release_statuses_json),
      available: false,
      requested: row.requested === 1,
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

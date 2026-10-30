import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import path from "node:path";
import { db, dbHelpers } from "../config/db-sqlite.ts";
import * as v from "valibot";
import {
  invalidateLibraryManagementCache,
  notifyLibraryManagementChanged,
} from "./libraryManagementStore.ts";
import { getLibraryIndexLastModified, invalidateLibraryQueryCache } from "./libraryQueryService.ts";
import { isVariousArtistsCredit, withoutRemasterLabel } from "./trackMatching/titleText.ts";
import { isSameSongAtPlace } from "./trackMatching/nativeMatcher.ts";
import { clearLibraryManagement } from "./libraryManagementStore.ts";
import { readRawLibraryMetadata } from "./libraryMetadata.ts";
import { logger, safeLogDiagnostic } from "./logger.ts";
import { asAppError } from "../../lib/errors.ts";
import {
  removeLibrarySearchDocument,
  syncLibrarySearchAlbum,
  syncLibrarySearchArtist,
  syncLibrarySearchTrack,
} from "./librarySearchIndex.ts";
import type {
  LibraryAlbumCreditsRow,
  LibraryAlbumsRow,
  LibraryAlbumTracksRow,
  LibraryArtistsRow,
  LibraryMediaFilesRow,
  LibraryTracksRow,
  PlayAlbumStatsRow,
  PlayEventsRow,
  SubsonicPlayQueuesRow,
} from "../db/rows.ts";
import type {
  NormalizedAlbum,
  NormalizedRelease,
  NormalizedTrack,
} from "./providers/brainzmashMappers.ts";

const now = () => Date.now();

const stringify = (value: unknown) => dbHelpers.stringifyJSON(value) || null;

const normalizeText = (value: unknown) => String(value || "").trim();

const LETTER_SPELLINGS = { æ: "ae", œ: "oe", ß: "ss", ø: "o", đ: "d", ð: "d", ł: "l", þ: "th" };
const spellLetters = (value: unknown) =>
  normalizeText(value)
    .toLowerCase()
    .replace(/[æœßøđðłþ]/g, (letter) => LETTER_SPELLINGS[letter as keyof typeof LETTER_SPELLINGS]);

const hasNonLatinLetters = (value: unknown) =>
  /(?![a-z0-9])[\p{L}\p{N}]/u.test(
    spellLetters(value)
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, ""),
  );

const asciiKeyPart = (value: unknown) =>
  normalizeText(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

// A name with letters ASCII cannot spell keeps them as written, or every
// name written only in such letters, such as Japanese, would share one key.
const normalizeKeyPart = (value: unknown) =>
  hasNonLatinLetters(value)
    ? normalizeText(value)
        .normalize("NFKC")
        .toLowerCase()
        .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")
        .trim()
    : asciiKeyPart(value);

type KeyPart = (value: unknown) => string;

const joinFallbackKey = (keyPart: KeyPart, parts: unknown[]) => {
  const normalized = parts.map(keyPart).filter(Boolean);
  return normalized.length ? `name:${normalized.join(":")}` : null;
};

const LIDARR_METADATA_KEYS = [
  "librarySource",
  "id",
  "monitored",
  "monitor",
  "monitorNewItems",
  "addOptions",
  "path",
  "qualityProfile",
  "rootFolderPath",
  "statistics",
];

const getLibraryMediaFileStmt = db.prepare<[string, string], LibraryMediaFilesRow>(
  "SELECT * FROM library_media_files WHERE source = ? AND path = ?",
);
const upsertLibraryMediaFileStmt = db.prepare<
  [
    number,
    number | null,
    string,
    string,
    string | null,
    number,
    number | null,
    number | null,
    string | null,
    string | null,
    number,
    number,
    number,
    number,
  ]
>(
  `INSERT INTO library_media_files
    (track_id, album_id, source, path, format, size, mtime_ms, duration_ms, quality_json, artist_tag, available, last_seen_scan_id, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(source, path) DO UPDATE SET
     track_id = excluded.track_id,
     album_id = COALESCE(excluded.album_id, library_media_files.album_id),
     source = excluded.source,
     format = excluded.format,
     size = excluded.size,
     mtime_ms = excluded.mtime_ms,
     duration_ms = excluded.duration_ms,
     quality_json = COALESCE(excluded.quality_json, library_media_files.quality_json),
     artist_tag = excluded.artist_tag,
     available = excluded.available,
     last_seen_scan_id = excluded.last_seen_scan_id,
     updated_at = excluded.updated_at`,
);

let libraryScanDepth = 0;
let libraryCacheInvalidationPending = false;
const libraryScanContext = new AsyncLocalStorage<{ changed: boolean }>();

const invalidateLibraryCache = () => {
  const scan = libraryScanContext.getStore();
  if (scan) {
    scan.changed = true;
    libraryCacheInvalidationPending = true;
    return;
  }
  invalidateLibraryQueryCache();
};

export function buildIdentityKey(prefix: string, value: unknown) {
  const normalized = normalizeText(value);
  if (!normalized) return null;
  return `${prefix}:${normalized}`;
}

const MBID_GLOB = [8, 4, 4, 4, 12].map((length) => "[0-9a-f]".repeat(length)).join("-");

export function buildFallbackIdentityKey(...parts: unknown[]) {
  return joinFallbackKey(normalizeKeyPart, parts);
}

type LibraryScanCounts = { filesSeen?: number; filesIndexed?: number; filesFailed?: number };

export function beginLibraryScan({
  source,
  rootPath = null,
}: { source?: string; rootPath?: string | null } = {}) {
  const startedAt = now();
  const result = db
    .prepare<[string, string | null, number]>(
      `INSERT INTO library_scan_runs (source, root_path, status, started_at)
       VALUES (?, ?, 'running', ?)`,
    )
    .run(normalizeText(source), rootPath ? normalizeText(rootPath) : null, startedAt);
  return Number(result.lastInsertRowid);
}

export function finishLibraryScan(
  scanId: number,
  {
    status = "complete",
    error = null,
    filesSeen = 0,
    filesIndexed = 0,
    filesFailed = 0,
  }: { status?: string; error?: unknown } & LibraryScanCounts = {},
) {
  db.prepare<[string, number, string | null, number, number, number, number]>(
    `UPDATE library_scan_runs
     SET status = ?, completed_at = ?, error = ?, files_seen = ?, files_indexed = ?, files_failed = ?
     WHERE id = ?`,
  ).run(
    status,
    now(),
    error ? String(error) : null,
    Number(filesSeen) || 0,
    Number(filesIndexed) || 0,
    Number(filesFailed) || 0,
    scanId,
  );
}

const copyLibraryStars = (entityKind: string, fromKey: string, toKey: string | null) =>
  db
    .prepare<[string | null, string, string]>(
      `INSERT OR IGNORE INTO subsonic_stars (user_id, entity_kind, entity_key, created_at)
   SELECT user_id, entity_kind, ?, created_at
   FROM subsonic_stars
   WHERE entity_kind = ? AND entity_key = ?`,
    )
    .run(toKey, entityKind, fromKey).changes > 0;

function moveLibraryStars(entityKind: string, fromKey: string, toKey: string | null) {
  const copied = copyLibraryStars(entityKind, fromKey, toKey);
  const deleted =
    db
      .prepare<[string, string]>(
        "DELETE FROM subsonic_stars WHERE entity_kind = ? AND entity_key = ?",
      )
      .run(entityKind, fromKey).changes > 0;
  return copied || deleted;
}

const moveLibraryArtistStars = (fromKey: string, toKey: string | null) =>
  moveLibraryStars("artist", fromKey, toKey);

export const subsonicId = (kind: string, key: unknown) =>
  `${kind}:${encodeURIComponent(String(key)).replaceAll("%3A", ":")}`;

function moveQueuedLibrarySong(fromKey: string, toKey: string) {
  const from = subsonicId("song", fromKey);
  const to = subsonicId("song", toKey);
  for (const queue of db
    .prepare<[], Pick<SubsonicPlayQueuesRow, "user_id" | "song_ids" | "current_song">>(
      "SELECT user_id, song_ids, current_song FROM subsonic_play_queues",
    )
    .all()) {
    const ids = dbHelpers.readJSON(v.array(v.string()), queue.song_ids, "play queue");
    if (!ids || (!ids.includes(from) && queue.current_song !== from)) continue;
    db.prepare<[string, string | null, number]>(
      "UPDATE subsonic_play_queues SET song_ids = ?, current_song = ? WHERE user_id = ?",
    ).run(
      JSON.stringify(ids.map((id) => (id === from ? to : id))),
      queue.current_song === from ? to : queue.current_song,
      queue.user_id,
    );
  }
}

type ArtistIdentity = Pick<LibraryArtistsRow, "id" | "identity_key">;

function mergeLibraryArtistInto(
  fallback: ArtistIdentity | null | undefined,
  resolved: ArtistIdentity | null | undefined,
  { syncSearch = true }: { syncSearch?: boolean } = {},
) {
  if (!fallback || !resolved || fallback.id === resolved.id) return false;
  const movedAlbums = syncSearch
    ? db
        .prepare<[number], Pick<LibraryAlbumsRow, "id">>(
          "SELECT id FROM library_albums WHERE artist_id = ?",
        )
        .all(fallback.id)
    : [];
  let changed = moveLibraryArtistStars(fallback.identity_key, resolved.identity_key);
  changed =
    db
      .prepare<[number, number]>(
        "UPDATE OR IGNORE library_release_calendar SET artist_id = ? WHERE artist_id = ?",
      )
      .run(resolved.id, fallback.id).changes > 0 || changed;
  changed =
    db
      .prepare<[number, number]>("UPDATE library_albums SET artist_id = ? WHERE artist_id = ?")
      .run(resolved.id, fallback.id).changes > 0 || changed;
  const copiedManagement =
    db
      .prepare<[number, number]>(`
    INSERT OR IGNORE INTO library_management
      (entity_kind, entity_id, managed_by, monitor_mode, monitor_rules, created_at, updated_at, last_missing_search_at)
    SELECT entity_kind, ?, managed_by, monitor_mode, monitor_rules, created_at, updated_at, last_missing_search_at
    FROM library_management WHERE entity_kind = 'artist' AND entity_id = ?
  `)
      .run(resolved.id, fallback.id).changes > 0;
  const removedManagement =
    db
      .prepare<[number]>(
        "DELETE FROM library_management WHERE entity_kind = 'artist' AND entity_id = ?",
      )
      .run(fallback.id).changes > 0;
  if (copiedManagement || removedManagement) invalidateLibraryManagementCache();
  changed = copiedManagement || removedManagement || changed;
  changed =
    db.prepare<[number]>("DELETE FROM library_artists WHERE id = ?").run(fallback.id).changes > 0 ||
    changed;
  if (syncSearch) {
    removeLibrarySearchDocument("artist", fallback.id);
    for (const album of movedAlbums) {
      syncLibrarySearchAlbum(album.id);
      for (const track of db
        .prepare<[number], Pick<LibraryAlbumTracksRow, "track_id">>(
          "SELECT track_id FROM library_album_tracks WHERE album_id = ?",
        )
        .all(album.id))
        syncLibrarySearchTrack(track.track_id);
    }
  }
  return changed;
}

const albumTitles = (json: string) => {
  const titles: unknown = JSON.parse(json);
  return Array.isArray(titles)
    ? titles.filter((title): title is string => typeof title === "string")
    : [];
};

export function getUnresolvedLibraryArtists() {
  return db
    .prepare<[], Pick<LibraryArtistsRow, "id" | "name"> & { albums: string }>(
      `SELECT artist.id, artist.name, json_group_array(DISTINCT album.title) AS albums
     FROM library_artists AS artist
     JOIN library_albums AS album ON album.artist_id = artist.id
     JOIN library_media_files AS media ON media.album_id = album.id AND media.available = 1
     WHERE artist.mbid IS NULL
       AND (NOT json_valid(artist.metadata_json)
         OR json_extract(artist.metadata_json, '$.mbidSource') IS NOT 'manual')
     GROUP BY artist.id
     ORDER BY artist.id`,
    )
    .all()
    .map((artist) => ({ ...artist, albums: albumTitles(artist.albums) }));
}

export type UnresolvedLibraryArtist = ReturnType<typeof getUnresolvedLibraryArtists>[number];

export function assignLibraryArtistMbid(artistId: number, mbid: string) {
  const key = buildIdentityKey("mbid", mbid);
  if (!key) return null;
  const artist = db.transaction(() => {
    const fallback = db
      .prepare<[number], ArtistIdentity>(
        "SELECT id, identity_key FROM library_artists WHERE id = ? AND mbid IS NULL",
      )
      .get(artistId);
    if (!fallback) return null;
    const resolved = db
      .prepare<[string, string, string], ArtistIdentity>(
        `SELECT id, identity_key FROM library_artists
         WHERE identity_key = ? OR mbid = ?
         ORDER BY identity_key = ? DESC, id
         LIMIT 1`,
      )
      .get(key, mbid, key);
    if (resolved) {
      mergeLibraryArtistInto(fallback, resolved, { syncSearch: false });
      return resolved;
    }
    moveLibraryArtistStars(fallback.identity_key, key);
    db.prepare<[string, string, number, number]>(
      "UPDATE library_artists SET identity_key = ?, mbid = ?, updated_at = ? WHERE id = ?",
    ).run(key, mbid, now(), fallback.id);
    return fallback;
  })();
  if (artist) invalidateLibraryCache();
  return artist;
}

export function setLibraryArtistMbid(artistId: number, mbid: string | null) {
  const result = db.transaction(() => {
    const artist = db
      .prepare<[number], LibraryArtistsRow>("SELECT * FROM library_artists WHERE id = ?")
      .get(artistId);
    if (!artist) return { error: "not_found" };
    const metadata = readRawLibraryMetadata(artist.metadata_json);
    if (metadata.id != null) return { error: "lidarr_managed" };
    const fallbackKey = buildFallbackIdentityKey("artist", artist.name);
    const fallbackTaken =
      !mbid &&
      db
        .prepare<[number, string | null], { 1: number }>(
          "SELECT 1 FROM library_artists WHERE id != ? AND identity_key = ?",
        )
        .get(artist.id, fallbackKey);
    const key = mbid
      ? buildIdentityKey("mbid", mbid)
      : fallbackTaken
        ? `${fallbackKey}:${artist.id}`
        : fallbackKey;
    const target = mbid
      ? db
          .prepare<[number, string | null, string, string | null], LibraryArtistsRow>(
            "SELECT * FROM library_artists WHERE id != ? AND (identity_key = ? OR mbid = ?) ORDER BY identity_key = ? DESC, id LIMIT 1",
          )
          .get(artist.id, key, mbid, key)
      : null;
    if (target) {
      const targetMetadata = readRawLibraryMetadata(target.metadata_json);
      mergeLibraryArtistInto(artist, target);
      db.prepare<[string | null, number, number]>(
        "UPDATE library_artists SET metadata_json = ?, updated_at = ? WHERE id = ?",
      ).run(stringify({ ...targetMetadata, mbidSource: "manual" }), now(), target.id);
      return {
        artist: db
          .prepare<[number], LibraryArtistsRow>("SELECT * FROM library_artists WHERE id = ?")
          .get(target.id),
        mergedArtistId: artist.id,
      };
    }
    moveLibraryArtistStars(artist.identity_key, key);
    db.prepare<[string | null, string | null, string | null, number, number]>(
      `UPDATE library_artists
       SET identity_key = ?, mbid = ?, metadata_json = ?, updated_at = ?
       WHERE id = ?`,
    ).run(key, mbid || null, stringify({ ...metadata, mbidSource: "manual" }), now(), artist.id);
    return {
      artist: db
        .prepare<[number], LibraryArtistsRow>("SELECT * FROM library_artists WHERE id = ?")
        .get(artist.id),
    };
  })();
  if (result.artist) {
    syncLibrarySearchArtist(result.artist.id);
    invalidateLibraryCache();
  }
  return result;
}

export function upsertLibraryArtist({
  identityKey,
  mbid = null,
  creditedMbids = [],
  name,
  sortName = null,
  metadata = null,
  syncSearch = true,
}: {
  identityKey: string | null;
  mbid?: string | null;
  creditedMbids?: string[];
  name: string;
  sortName?: string | null;
  metadata?: Record<string, unknown> | null;
  syncSearch?: boolean;
}) {
  const timestamp = now();
  const key = normalizeText(identityKey);
  const artistName = normalizeText(name);
  const artistMbid = mbid || null;
  const artistSortName = sortName || null;
  const metadataText = stringify(metadata);
  if (!key || !artistName) throw new Error("Library artist identityKey and name are required");
  let libraryChanged = false;
  const artist = db.transaction(() => {
    const fallbackKey = buildFallbackIdentityKey("artist", artistName);
    const findFallbackArtist = () => {
      return db
        .prepare<[string | null], ArtistIdentity>(
          "SELECT id, identity_key FROM library_artists WHERE identity_key = ? AND mbid IS NULL",
        )
        .get(fallbackKey);
    };
    const findResolvedArtist = () => {
      const credited = JSON.stringify(creditedMbids);
      const exact = db
        .prepare<[string, string, string], LibraryArtistsRow>(
          `SELECT * FROM library_artists
           WHERE lower(mbid) GLOB ? AND name = ? COLLATE NOCASE
             AND mbid NOT IN (SELECT value FROM json_each(?))
           ORDER BY id
           LIMIT 2`,
        )
        .all(MBID_GLOB, artistName, credited);
      if (exact.length === 1) return exact[0];
      // ponytail: normalized duplicate repair scans artist rows; add a persisted normalized name if this becomes hot.
      const matches = db
        .prepare<[string, string], LibraryArtistsRow>(
          "SELECT * FROM library_artists WHERE lower(mbid) GLOB ? AND mbid NOT IN (SELECT value FROM json_each(?))",
        )
        .all(MBID_GLOB, credited)
        .filter((row) => buildFallbackIdentityKey("artist", row.name) === fallbackKey);
      return matches.length === 1 ? matches[0] : null;
    };
    const mergeFallbackArtist = (
      fallback: ArtistIdentity | undefined,
      resolved: ArtistIdentity,
    ) => {
      libraryChanged = mergeLibraryArtistInto(fallback, resolved, { syncSearch }) || libraryChanged;
    };
    if (mbid) {
      const resolved = db
        .prepare<[string], ArtistIdentity>(
          "SELECT id, identity_key FROM library_artists WHERE identity_key = ?",
        )
        .get(key);
      const fallback = fallbackKey === key ? null : findFallbackArtist();
      if (fallback && !resolved) {
        libraryChanged = moveLibraryArtistStars(fallback.identity_key, key) || libraryChanged;
        libraryChanged =
          db
            .prepare<[string, number, number]>(
              "UPDATE library_artists SET identity_key = ?, updated_at = ? WHERE id = ?",
            )
            .run(key, timestamp, fallback.id).changes > 0 || libraryChanged;
      } else if (fallback && resolved && fallback.id !== resolved.id) {
        mergeFallbackArtist(fallback, resolved);
      }
    } else if (key === fallbackKey) {
      const resolved = findResolvedArtist();
      if (resolved) {
        mergeFallbackArtist(findFallbackArtist(), resolved);
        if (syncSearch) syncLibrarySearchArtist(resolved.id);
        return resolved;
      }
    }
    const existing = db
      .prepare<[string], LibraryArtistsRow>("SELECT * FROM library_artists WHERE identity_key = ?")
      .get(key);
    const mergedMetadataText =
      existing && metadata
        ? stringify({ ...readRawLibraryMetadata(existing.metadata_json), ...metadata })
        : metadataText;
    if (
      existing &&
      (artistMbid == null || artistMbid === existing.mbid) &&
      artistName === existing.name &&
      (artistSortName == null || artistSortName === existing.sort_name) &&
      (mergedMetadataText == null || mergedMetadataText === existing.metadata_json)
    ) {
      if (syncSearch) syncLibrarySearchArtist(existing.id);
      return existing;
    }
    db.prepare<[string, string | null, string, string | null, string | null, number, number]>(
      `INSERT INTO library_artists (identity_key, mbid, name, sort_name, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(identity_key) DO UPDATE SET
         mbid = COALESCE(excluded.mbid, library_artists.mbid),
         name = excluded.name,
         sort_name = COALESCE(excluded.sort_name, library_artists.sort_name),
         metadata_json = COALESCE(excluded.metadata_json, library_artists.metadata_json),
         updated_at = excluded.updated_at`,
    ).run(key, artistMbid, artistName, artistSortName, mergedMetadataText, timestamp, timestamp);
    libraryChanged = true;
    const row = db
      .prepare<[string], LibraryArtistsRow>("SELECT * FROM library_artists WHERE identity_key = ?")
      .get(key)!;
    if (syncSearch) syncLibrarySearchArtist(row?.id);
    return row;
  })();
  if (libraryChanged) invalidateLibraryCache();
  return artist;
}

function clearLidarrMetadata(
  table: "library_artists" | "library_albums",
  where: string,
  parameters: string[],
) {
  const row = db
    .prepare<string[], Pick<LibraryArtistsRow | LibraryAlbumsRow, "id" | "metadata_json">>(
      `SELECT id, metadata_json FROM ${table} WHERE ${where} LIMIT 1`,
    )
    .get(...parameters);
  if (!row) return false;
  const metadata = readRawLibraryMetadata(row.metadata_json);
  for (const key of LIDARR_METADATA_KEYS) delete metadata[key];
  db.prepare<[string | null, number, number]>(
    `UPDATE ${table} SET metadata_json = ?, updated_at = ? WHERE id = ?`,
  ).run(stringify(metadata), now(), row.id);
  invalidateLibraryCache();
  return true;
}

export function clearLibraryLidarrArtist(reference: unknown) {
  const value = normalizeText(reference);
  if (!value) return false;
  return clearLidarrMetadata(
    "library_artists",
    `mbid = ? OR identity_key = ? OR (
      json_valid(metadata_json)
      AND CAST(json_extract(metadata_json, '$.foreignArtistId') AS TEXT) = ?
    )`,
    [value, value, value],
  );
}

export function clearLibraryLidarrAlbum(reference: unknown) {
  const value = normalizeText(reference);
  if (!value) return false;
  return clearLidarrMetadata(
    "library_albums",
    `mbid = ? OR release_group_mbid = ? OR identity_key = ? OR (
      json_valid(metadata_json)
      AND CAST(json_extract(metadata_json, '$.id') AS TEXT) = ?
    )`,
    [value, value, value, value],
  );
}

const albumCreditsStmt = db.prepare<[number], Pick<LibraryAlbumCreditsRow, "artist_mbid">>(
  "SELECT artist_mbid FROM library_album_credits WHERE album_id = ? ORDER BY artist_mbid",
);
const deleteAlbumCreditsStmt = db.prepare<[number]>(
  "DELETE FROM library_album_credits WHERE album_id = ?",
);
const insertAlbumCreditStmt = db.prepare<[number, string]>(
  "INSERT INTO library_album_credits (album_id, artist_mbid) VALUES (?, ?)",
);

export function setLibraryAlbumCredits(albumId: number, artistMbids: string[]) {
  const unique = [...new Set(artistMbids)].sort();
  const credits = unique.length > 1 ? unique : [];
  const stored = albumCreditsStmt.all(albumId).map((row) => row.artist_mbid);
  if (stored.join() === credits.join()) return;
  db.transaction(() => {
    deleteAlbumCreditsStmt.run(albumId);
    for (const mbid of credits) insertAlbumCreditStmt.run(albumId, mbid);
  })();
  invalidateLibraryCache();
}

export function upsertLibraryAlbum({
  identityKey,
  mbid = null,
  releaseGroupMbid = null,
  artistId,
  title,
  albumArtist = null,
  releaseDate = null,
  metadata = null,
  syncSearch = true,
}: {
  identityKey: string | null;
  mbid?: string | null;
  releaseGroupMbid?: string | null;
  artistId: number | string;
  title: string;
  albumArtist?: string | null;
  releaseDate?: string | null;
  metadata?: Record<string, unknown> | null;
  syncSearch?: boolean;
}) {
  const timestamp = now();
  const key = normalizeText(identityKey);
  const albumTitle = normalizeText(title);
  const albumMbid = mbid || null;
  const albumReleaseGroupMbid = releaseGroupMbid || null;
  const albumArtistName = albumArtist || null;
  const albumReleaseDate = releaseDate || null;
  const metadataText = stringify(metadata);
  if (!key || !Number.isSafeInteger(Number(artistId)) || !albumTitle) {
    throw new Error("Library album identityKey, artistId, and title are required");
  }
  let libraryChanged = false;
  const album = db.transaction(() => {
    const existing = db
      .prepare<[string], LibraryAlbumsRow>("SELECT * FROM library_albums WHERE identity_key = ?")
      .get(key);
    const mergedMetadataText =
      existing && metadata
        ? stringify({ ...readRawLibraryMetadata(existing.metadata_json), ...metadata })
        : metadataText;
    if (
      existing &&
      (albumMbid == null || albumMbid === existing.mbid) &&
      (albumReleaseGroupMbid == null || albumReleaseGroupMbid === existing.release_group_mbid) &&
      Number(artistId) === existing.artist_id &&
      albumTitle === existing.title &&
      (albumArtistName == null || albumArtistName === existing.album_artist) &&
      (albumReleaseDate == null || albumReleaseDate === existing.release_date) &&
      (mergedMetadataText == null || mergedMetadataText === existing.metadata_json)
    ) {
      const searchChanged = syncSearch && syncLibrarySearchAlbum(existing.id);
      if (searchChanged) {
        for (const track of db
          .prepare<[number], Pick<LibraryAlbumTracksRow, "track_id">>(
            "SELECT track_id FROM library_album_tracks WHERE album_id = ?",
          )
          .all(existing.id)) {
          syncLibrarySearchTrack(track.track_id);
        }
      }
      return existing;
    }
    db.prepare<
      [
        string,
        string | null,
        string | null,
        number,
        string,
        string | null,
        string | null,
        string | null,
        number,
        number,
      ]
    >(
      `INSERT INTO library_albums
        (identity_key, mbid, release_group_mbid, artist_id, title, album_artist, release_date, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(identity_key) DO UPDATE SET
         mbid = COALESCE(excluded.mbid, library_albums.mbid),
         release_group_mbid = COALESCE(excluded.release_group_mbid, library_albums.release_group_mbid),
         artist_id = excluded.artist_id,
         title = excluded.title,
         album_artist = COALESCE(excluded.album_artist, library_albums.album_artist),
         release_date = COALESCE(excluded.release_date, library_albums.release_date),
         metadata_json = COALESCE(excluded.metadata_json, library_albums.metadata_json),
         updated_at = excluded.updated_at`,
    ).run(
      key,
      albumMbid,
      albumReleaseGroupMbid,
      Number(artistId),
      albumTitle,
      albumArtistName,
      albumReleaseDate,
      mergedMetadataText,
      timestamp,
      timestamp,
    );
    libraryChanged = true;
    const row = db
      .prepare<[string], LibraryAlbumsRow>("SELECT * FROM library_albums WHERE identity_key = ?")
      .get(key)!;
    const searchChanged = syncSearch && syncLibrarySearchAlbum(row?.id);
    if (row?.id && searchChanged) {
      for (const track of db
        .prepare<[number], Pick<LibraryAlbumTracksRow, "track_id">>(
          "SELECT track_id FROM library_album_tracks WHERE album_id = ?",
        )
        .all(row.id)) {
        syncLibrarySearchTrack(track.track_id);
      }
    }
    return row;
  })();
  if (libraryChanged) invalidateLibraryCache();
  return album;
}

export function upsertLibraryTrack({
  identityKey,
  mbid = null,
  title,
  artistName = null,
  metadata = null,
  monitored = true,
  syncSearch = true,
}: {
  identityKey: string | null;
  mbid?: string | null;
  title: string;
  artistName?: string | null;
  metadata?: Record<string, unknown> | null;
  monitored?: boolean;
  syncSearch?: boolean;
}) {
  const timestamp = now();
  const key = normalizeText(identityKey);
  const trackTitle = normalizeText(title);
  const trackMbid = mbid || null;
  const trackArtistName = artistName || null;
  const metadataText = stringify(metadata);
  if (!key || !trackTitle) throw new Error("Library track identityKey and title are required");
  let libraryChanged = false;
  const track = db.transaction(() => {
    const existing = db
      .prepare<[string], LibraryTracksRow>("SELECT * FROM library_tracks WHERE identity_key = ?")
      .get(key);
    // "Various Artists" credits a compilation, not a performer, so it never
    // replaces a track's own artist.
    const nextArtistName =
      existing?.artist_name && isVariousArtistsCredit(trackArtistName)
        ? existing.artist_name
        : trackArtistName;
    if (
      existing &&
      (trackMbid == null || trackMbid === existing.mbid) &&
      trackTitle === existing.title &&
      (nextArtistName == null || nextArtistName === existing.artist_name) &&
      (metadataText == null || metadataText === existing.metadata_json)
    ) {
      if (syncSearch) syncLibrarySearchTrack(existing.id);
      return existing;
    }
    db.prepare<
      [string, string | null, string, string | null, string | null, number, number, number]
    >(
      `INSERT INTO library_tracks (identity_key, mbid, title, artist_name, metadata_json, monitored, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(identity_key) DO UPDATE SET
         mbid = COALESCE(excluded.mbid, library_tracks.mbid),
         title = excluded.title,
         artist_name = COALESCE(excluded.artist_name, library_tracks.artist_name),
         metadata_json = COALESCE(excluded.metadata_json, library_tracks.metadata_json),
         updated_at = excluded.updated_at`,
    ).run(
      key,
      trackMbid,
      trackTitle,
      nextArtistName,
      metadataText,
      monitored ? 1 : 0,
      timestamp,
      timestamp,
    );
    libraryChanged = true;
    const row = db
      .prepare<[string], LibraryTracksRow>("SELECT * FROM library_tracks WHERE identity_key = ?")
      .get(key)!;
    if (syncSearch) syncLibrarySearchTrack(row?.id);
    return row;
  })();
  if (libraryChanged) invalidateLibraryCache();
  return track;
}

// library_album_tracks has no updated_at and rows are deleted outright, so relation changes ride
// on the album's timestamp to stay visible in getLibraryIndexLastModified.
const touchLibraryAlbum = (albumId: number) => {
  db.prepare<[number, number]>("UPDATE library_albums SET updated_at = ? WHERE id = ?").run(
    now(),
    Number(albumId),
  );
};

// A scan passes keepPosition: a file whose tags number it differently from
// the release the album was requested with stays at the track's position.
export function linkLibraryAlbumTrack({
  albumId,
  trackId,
  discNumber = 1,
  trackNumber = 0,
  keepPosition = false,
  syncSearch = true,
}: {
  albumId: number;
  trackId: number;
  discNumber?: number;
  trackNumber?: number;
  keepPosition?: boolean;
  syncSearch?: boolean;
}) {
  const changed = db.transaction(() => {
    if (
      keepPosition &&
      db
        .prepare<[number, number], { 1: number }>(
          "SELECT 1 FROM library_album_tracks WHERE album_id = ? AND track_id = ? LIMIT 1",
        )
        .get(Number(albumId), Number(trackId))
    ) {
      if (syncSearch) syncLibrarySearchTrack(trackId);
      return false;
    }
    const result = db
      .prepare<[number, number, number, number, number]>(
        `INSERT OR IGNORE INTO library_album_tracks
        (album_id, track_id, disc_number, track_number, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        Number(albumId),
        Number(trackId),
        Number(discNumber) || 1,
        Number(trackNumber) || 0,
        now(),
      );
    if (result.changes > 0) touchLibraryAlbum(albumId);
    if (syncSearch) syncLibrarySearchTrack(trackId);
    return result.changes > 0;
  })();
  if (changed) invalidateLibraryCache();
}

// A scan stores a file's release ID in its album's mbid. A release ID used
// as a release group names that album, not a new one.
export function findLibraryAlbumByReleaseMbid(mbid: string | null | undefined) {
  const releaseMbid = normalizeText(mbid);
  if (!releaseMbid) return null;
  return (
    db
      .prepare<[string], LibraryAlbumsRow>(
        `SELECT * FROM library_albums
     WHERE mbid = ? AND release_group_mbid IS NOT NULL AND release_group_mbid != mbid
     ORDER BY id LIMIT 1`,
      )
      .get(releaseMbid) || null
  );
}

// Names with letters ASCII cannot spell, such as Japanese titles, compare as
// written, since their ASCII keys would drop those letters and match each other.
const libraryNameKey = (value: string | null | undefined) => {
  const ascii = asciiKeyPart(spellLetters(value));
  return ascii && !hasNonLatinLetters(value)
    ? ascii
    : normalizeText(value).normalize("NFKC").toLowerCase();
};

export function isSameLibraryName(
  left: string | null | undefined,
  right: string | null | undefined,
) {
  const key = libraryNameKey(left);
  return Boolean(key) && key === libraryNameKey(right);
}

// A remastered song keeps its name: "Song (Remastered 2012)" is "Song".
const songKey = (title: string | null | undefined) => libraryNameKey(withoutRemasterLabel(title));

const isSameSong = (left: string | null | undefined, right: string | null | undefined) => {
  const key = songKey(left);
  return Boolean(key) && key === songKey(right);
};

// A file without MusicBrainz album tags belongs to the artist's album with
// the same title, so an untagged copy never splits an album in two.
export function findLibraryAlbumByArtistTitle(
  artistId: number,
  title: string | null | undefined,
  trackTitle: string | null = null,
) {
  if (!normalizeText(title) || !Number.isSafeInteger(Number(artistId))) return null;
  const matches = db
    .prepare<[number], LibraryAlbumsRow>(
      "SELECT * FROM library_albums WHERE artist_id = ? ORDER BY id",
    )
    .all(Number(artistId))
    .filter((album) => isSameLibraryName(album.title, title));
  return chooseLibraryAlbum(matches, trackTitle ? [trackTitle] : []);
}

export function moveLibraryMediaFilePath(source: string, fromPath: string, toPath: string) {
  const from = normalizeText(fromPath);
  const to = normalizeText(toPath);
  const fileSource = normalizeText(source);
  if (!from || !to || from === to) return false;
  const moved = db.transaction(() => {
    const file = getLibraryMediaFileStmt.get(fileSource, from);
    if (!file) return false;
    const occupied = getLibraryMediaFileStmt.get(fileSource, to);
    if (occupied)
      db.prepare<[number]>("DELETE FROM library_media_files WHERE id = ?").run(occupied.id);
    db.prepare<[string, number, number]>(
      "UPDATE library_media_files SET path = ?, updated_at = ? WHERE id = ?",
    ).run(to, now(), file.id);
    return true;
  })();
  if (moved) invalidateLibraryCache();
  return moved;
}

// An upgrade can bring a file with new identity tags. The track keeps its
// row, favorites, and monitoring, or folds into the track that already has them.
export function rekeyLibraryTrack(trackId: number, identityKey: string | null) {
  const key = normalizeText(identityKey);
  const id = Number(trackId);
  if (!key || !Number.isSafeInteger(id)) return null;
  const result = db
    .transaction(() => {
      const track = db
        .prepare<[number], LibraryTracksRow>("SELECT * FROM library_tracks WHERE id = ?")
        .get(id);
      if (!track) return null;
      if (track.identity_key === key) return { id, changed: false };
      moveLibraryStars("song", track.identity_key, key);
      moveQueuedLibrarySong(track.identity_key, key);
      const target = db
        .prepare<[string], LibraryTracksRow>("SELECT * FROM library_tracks WHERE identity_key = ?")
        .get(key);
      if (!target) {
        db.prepare<[string, number, number]>(
          "UPDATE library_tracks SET identity_key = ?, updated_at = ? WHERE id = ?",
        ).run(key, now(), id);
        return { id, changed: true };
      }
      db.prepare<[number, number, number]>(
        `INSERT OR IGNORE INTO library_album_tracks (album_id, track_id, disc_number, track_number, created_at)
       SELECT link.album_id, ?, link.disc_number, link.track_number, link.created_at
       FROM library_album_tracks AS link
       WHERE link.track_id = ? AND NOT EXISTS (
         SELECT 1 FROM library_album_tracks AS kept
         WHERE kept.album_id = link.album_id AND kept.track_id = ?
           AND kept.disc_number = link.disc_number AND kept.track_number = link.track_number
       )`,
      ).run(target.id, id, target.id);
      db.prepare<[number, number]>(
        "UPDATE library_media_files SET track_id = ? WHERE track_id = ?",
      ).run(target.id, id);
      if (track.monitored === 1)
        db.prepare<[number]>("UPDATE library_tracks SET monitored = 1 WHERE id = ?").run(target.id);
      db.prepare<[number]>("DELETE FROM library_album_tracks WHERE track_id = ?").run(id);
      db.prepare<[number]>("DELETE FROM library_tracks WHERE id = ?").run(id);
      removeLibrarySearchDocument("track", id);
      return { id: target.id, changed: true };
    })
    .immediate();
  if (result?.changed) {
    syncLibrarySearchTrack(result.id);
    invalidateLibraryCache();
  }
  return result?.id ?? null;
}

export function rekeyLibraryAlbum(albumId: number, identityKey: string | null) {
  const key = normalizeText(identityKey);
  const id = Number(albumId);
  if (!key || !Number.isSafeInteger(id)) return null;
  const result = db
    .transaction(() => {
      const album = db
        .prepare<[number], LibraryAlbumsRow>("SELECT * FROM library_albums WHERE id = ?")
        .get(id);
      if (!album) return null;
      if (album.identity_key === key) return { id, changed: false };
      moveLibraryStars("album", album.identity_key, key);
      db.prepare<[string, string]>(
        `INSERT INTO play_album_stats (user_id, album_key, play_count, last_played_at)
       SELECT user_id, ?, play_count, last_played_at FROM play_album_stats WHERE album_key = ?
       ON CONFLICT (user_id, album_key) DO UPDATE SET
         play_count = play_album_stats.play_count + excluded.play_count,
         last_played_at = MAX(play_album_stats.last_played_at, excluded.last_played_at)`,
      ).run(key, album.identity_key);
      db.prepare<[string]>("DELETE FROM play_album_stats WHERE album_key = ?").run(
        album.identity_key,
      );
      db.prepare<[string, string]>("UPDATE play_events SET album_key = ? WHERE album_key = ?").run(
        key,
        album.identity_key,
      );
      const target = db
        .prepare<[string], LibraryAlbumsRow>("SELECT * FROM library_albums WHERE identity_key = ?")
        .get(key);
      if (!target) {
        db.prepare<[string, number, number]>(
          "UPDATE library_albums SET identity_key = ?, updated_at = ? WHERE id = ?",
        ).run(key, now(), id);
        return { id, changed: true };
      }
      db.prepare<[number, number, number]>(
        `INSERT OR IGNORE INTO library_album_tracks (album_id, track_id, disc_number, track_number, created_at)
       SELECT ?, link.track_id, link.disc_number, link.track_number, link.created_at
       FROM library_album_tracks AS link
       WHERE link.album_id = ? AND NOT EXISTS (
         SELECT 1 FROM library_album_tracks AS kept
         WHERE kept.album_id = ? AND kept.track_id = link.track_id
           AND kept.disc_number = link.disc_number AND kept.track_number = link.track_number
       )`,
      ).run(target.id, id, target.id);
      db.prepare<[number, number]>(
        "UPDATE library_media_files SET album_id = ? WHERE album_id = ?",
      ).run(target.id, id);
      db.prepare<[number, number]>(
        `INSERT OR IGNORE INTO library_management
        (entity_kind, entity_id, managed_by, monitor_mode, created_at, updated_at, last_missing_search_at)
       SELECT entity_kind, ?, managed_by, monitor_mode, created_at, updated_at, last_missing_search_at
       FROM library_management WHERE entity_kind = 'album' AND entity_id = ?`,
      ).run(target.id, id);
      db.prepare<[number]>("DELETE FROM library_album_tracks WHERE album_id = ?").run(id);
      clearLibraryManagement("album", id);
      db.prepare<[number]>("DELETE FROM library_albums WHERE id = ?").run(id);
      removeLibrarySearchDocument("album", id);
      touchLibraryAlbum(target.id);
      const trackIds = db
        .prepare<[number], number>(
          "SELECT DISTINCT track_id FROM library_album_tracks WHERE album_id = ?",
        )
        .pluck()
        .all(target.id);
      return { id: target.id, changed: true, trackIds };
    })
    .immediate();
  if (result?.changed) {
    invalidateLibraryManagementCache();
    syncLibrarySearchAlbum(result.id);
    for (const trackId of result.trackIds || []) syncLibrarySearchTrack(trackId);
    invalidateLibraryCache();
  }
  return result?.id ?? null;
}

const deleteAlbumStmt = db.prepare<[number]>("DELETE FROM library_albums WHERE id = ?");
const artistHasAlbumStmt = db.prepare<[number], { 1: number }>(
  "SELECT 1 FROM library_albums WHERE artist_id = ? LIMIT 1",
);
const artistManagedStmt = db.prepare<[number], { 1: number }>(
  "SELECT 1 FROM library_management WHERE entity_kind = 'artist' AND entity_id = ?",
);
const deleteArtistStmt = db.prepare<[number]>("DELETE FROM library_artists WHERE id = ?");

function deleteLibraryAlbumRow(albumId: number, artistId: number | null | undefined) {
  clearLibraryManagement("album", albumId);
  deleteAlbumStmt.run(albumId);
  removeLibrarySearchDocument("album", albumId);
  if (artistId != null && !artistHasAlbumStmt.get(artistId) && !artistManagedStmt.get(artistId)) {
    deleteArtistStmt.run(artistId);
    removeLibrarySearchDocument("artist", artistId);
  }
}

// Removes an album link an upgrade left behind, and the album, track, or
// artist it emptied.
export function unlinkLibraryAlbumTrackWithoutMedia(albumId: number, trackId: number) {
  const album = Number(albumId);
  const track = Number(trackId);
  const removed = db
    .transaction(() => {
      const hasMedia = db
        .prepare<[number, number], { 1: number }>(
          "SELECT 1 FROM library_media_files WHERE track_id = ? AND album_id = ? LIMIT 1",
        )
        .get(track, album);
      if (hasMedia) return false;
      const artistId = db
        .prepare<[number], Pick<LibraryAlbumsRow, "artist_id">>(
          "SELECT artist_id FROM library_albums WHERE id = ?",
        )
        .get(album)?.artist_id;
      if (
        db
          .prepare<[number, number]>(
            "DELETE FROM library_album_tracks WHERE album_id = ? AND track_id = ?",
          )
          .run(album, track).changes === 0
      ) {
        return false;
      }
      if (
        !db
          .prepare<[number], { 1: number }>(
            "SELECT 1 FROM library_album_tracks WHERE track_id = ? LIMIT 1",
          )
          .get(track) &&
        !db
          .prepare<[number], { 1: number }>(
            "SELECT 1 FROM library_media_files WHERE track_id = ? LIMIT 1",
          )
          .get(track)
      ) {
        db.prepare<[number]>("DELETE FROM library_tracks WHERE id = ?").run(track);
        removeLibrarySearchDocument("track", track);
      } else {
        syncLibrarySearchTrack(track);
      }
      if (
        !db
          .prepare<[number], { 1: number }>(
            "SELECT 1 FROM library_album_tracks WHERE album_id = ? LIMIT 1",
          )
          .get(album) &&
        !db
          .prepare<[number], { 1: number }>(
            "SELECT 1 FROM library_media_files WHERE album_id = ? AND available = 1 LIMIT 1",
          )
          .get(album)
      ) {
        db.prepare<[number]>("DELETE FROM library_media_files WHERE album_id = ?").run(album);
        deleteLibraryAlbumRow(album, artistId);
      } else {
        touchLibraryAlbum(album);
      }
      return true;
    })
    .immediate();
  if (removed) {
    invalidateLibraryManagementCache();
    invalidateLibraryCache();
  }
  return removed;
}

const isNameKey = (key: string | null | undefined) => String(key || "").startsWith("name:");

// A file whose tags gained MusicBrainz IDs is still the album and track it
// was, so those rows take the new identity with their favorites, play counts,
// and monitoring, as an upgrade's do. Returns what the file was on, for
// releaseLibraryFileRows once the scan has filed it.
export function followLibraryFileIdentity(
  media: LibraryMediaFilesRow,
  {
    artistId,
    albumKey,
    albumTitle,
    trackKey,
    title,
  }: {
    artistId: number;
    albumKey: string | null;
    albumTitle: string;
    trackKey: string | null;
    title: string;
  },
) {
  const album = media.album_id
    ? db
        .prepare<[number], LibraryAlbumsRow>("SELECT * FROM library_albums WHERE id = ?")
        .get(media.album_id)
    : null;
  const track = db
    .prepare<[number], LibraryTracksRow>("SELECT * FROM library_tracks WHERE id = ?")
    .get(media.track_id);
  const before = {
    albumId: media.album_id,
    trackId: media.track_id,
    named: isNameKey(album?.identity_key) || isNameKey(track?.identity_key),
  };
  if (
    album &&
    isNameKey(album.identity_key) &&
    album.identity_key !== albumKey &&
    album.artist_id === artistId &&
    isSameLibraryName(album.title, albumTitle)
  ) {
    rekeyLibraryAlbum(album.id, albumKey);
  }
  const shared = db
    .prepare<[number, number], { 1: number }>(
      "SELECT 1 FROM library_media_files WHERE track_id = ? AND id != ? LIMIT 1",
    )
    .get(media.track_id, media.id);
  if (
    track &&
    isNameKey(track.identity_key) &&
    track.identity_key !== trackKey &&
    !shared &&
    isSameLibraryName(track.title, title)
  ) {
    rekeyLibraryTrack(track.id, trackKey);
  }
  return before;
}

// A file the scan filed under other rows leaves no empty link behind on the
// untagged album or track it was on. Rows with MusicBrainz IDs may be
// Lidarr's or a wanted album's, so they keep theirs.
export function releaseLibraryFileRows(
  before: { named: boolean; albumId: number | null; trackId: number },
  after: { albumId: number; trackId: number },
) {
  if (!before.named || !before.albumId) return;
  if (before.albumId === after.albumId && before.trackId === after.trackId) return;
  unlinkLibraryAlbumTrackWithoutMedia(before.albumId, before.trackId);
  if (before.albumId !== after.albumId)
    unlinkLibraryAlbumTrackWithoutMedia(before.albumId, after.trackId);
}

export type LibraryAlbumTrack = LibraryTracksRow &
  Pick<LibraryAlbumTracksRow, "disc_number" | "track_number"> & { has_files: number };

type MatchableTrack = Pick<
  LibraryAlbumTrack,
  "id" | "title" | "identity_key" | "disc_number" | "track_number"
>;

const albumTracksStmt = db.prepare<[number], LibraryAlbumTrack>(
  `SELECT track.*, link.disc_number, link.track_number,
     EXISTS (
       SELECT 1 FROM library_media_files AS media
       WHERE media.track_id = track.id AND (media.album_id = link.album_id OR media.album_id IS NULL)
     ) AS has_files
   FROM library_album_tracks AS link
   JOIN library_tracks AS track ON track.id = link.track_id
   WHERE link.album_id = ?
   ORDER BY link.disc_number, link.track_number, track.id`,
);

const ALBUM_HAS_FILES = `EXISTS (
  SELECT 1 FROM library_album_tracks AS file_link
  JOIN library_media_files AS file
    ON file.track_id = file_link.track_id
    AND (file.album_id = file_link.album_id OR file.album_id IS NULL)
  WHERE file_link.album_id = album.id
)`;

// A song an album's track list names stays on the album without files.
const TRACK_IS_LISTED = `(json_valid(album.metadata_json) AND EXISTS (
  SELECT 1 FROM json_each(album.metadata_json, '$.trackList.recordings') WHERE value = track.mbid
))`;

// Aurral and Lidarr keep the albums they were asked for, with or without
// files: a requested album still downloading, or one unmonitored so artist
// monitoring leaves it out.
export const ALBUM_IS_OWNED = `(
  CASE WHEN json_valid(album.metadata_json)
    THEN json_extract(album.metadata_json, '$.librarySource') IS NOT NULL
      OR COALESCE(json_extract(album.metadata_json, '$.trackListComplete'), 0) = 1
    ELSE 0 END
  OR EXISTS (
    SELECT 1 FROM library_management AS owner
    WHERE owner.entity_kind = 'album' AND owner.entity_id = album.id
      AND (owner.managed_by != 'aurral' OR owner.monitor_mode IS NOT NULL)
  )
)`;

// A file without a recording ID is the album's song at its place, even
// spelled another way, or with its title when either has no place; the
// tagged one when an untagged copy sits beside it.
function matchLibraryAlbumTrack<T extends MatchableTrack>(
  tracks: T[],
  { title, discNumber, trackNumber }: { title: string; discNumber: number; trackNumber: number },
) {
  const same = [
    ...new Map(
      tracks
        .filter((track) =>
          track.track_number > 0 && trackNumber > 0
            ? track.track_number === trackNumber &&
              (track.disc_number || 1) === (discNumber || 1) &&
              (isSameSong(track.title, title) || isSameSongAtPlace(track.title, title))
            : isSameSong(track.title, title),
        )
        .map((track) => [track.id, track]),
    ).values(),
  ];
  if (same.length === 1) return same[0];
  const tagged = same.filter((track) => !isNameKey(track.identity_key));
  return tagged.length === 1 ? tagged[0] : null;
}

export function findLibraryAlbumTrack(
  albumKey: string | null,
  { title, discNumber, trackNumber }: { title: string; discNumber: number; trackNumber: number },
) {
  const album = db
    .prepare<[string], Pick<LibraryAlbumsRow, "id">>(
      "SELECT id FROM library_albums WHERE identity_key = ?",
    )
    .get(normalizeText(albumKey));
  if (!album) return null;
  return matchLibraryAlbumTrack(albumTracksStmt.all(album.id), { title, discNumber, trackNumber });
}

// Of an artist's albums with one title, an untagged album or file belongs to
// the only one, else the only one holding its tracks, else the only one of
// those with files.
function chooseLibraryAlbum(albums: LibraryAlbumsRow[], titles: string[]) {
  if (albums.length <= 1) return albums[0] || null;
  const holding = titles.length
    ? albums.filter((album) => {
        const tracks = albumTracksStmt.all(album.id);
        return titles.every((title) =>
          tracks.some((track) => isSameLibraryName(track.title, title)),
        );
      })
    : [];
  const pool = holding.length ? holding : albums;
  if (pool.length === 1) return pool[0];
  const withFiles = pool.filter((album) =>
    albumTracksStmt.all(album.id).some((track) => track.has_files),
  );
  return withFiles.length === 1 ? withFiles[0] : null;
}

// A file names the album it was filed under. One naming an album its track
// is not on shows nowhere, so it takes the track's album, or none when the
// track is on several.
function repairLibraryFileAlbums() {
  return db
    .prepare<[]>(
      `UPDATE library_media_files SET album_id = (
       SELECT CASE WHEN COUNT(DISTINCT link.album_id) = 1 THEN MIN(link.album_id) END
       FROM library_album_tracks AS link WHERE link.track_id = library_media_files.track_id
     )
     WHERE album_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM library_album_tracks AS link
       WHERE link.track_id = library_media_files.track_id AND link.album_id = library_media_files.album_id
     )`,
    )
    .run().changes;
}

const unlinkAlbumTrackStmt = db.prepare<[number, number]>(
  "DELETE FROM library_album_tracks WHERE album_id = ? AND track_id = ?",
);
const trackLinkedStmt = db.prepare<[number], { 1: number }>(
  "SELECT 1 FROM library_album_tracks WHERE track_id = ? LIMIT 1",
);
const trackHasFileStmt = db.prepare<[number], { 1: number }>(
  "SELECT 1 FROM library_media_files WHERE track_id = ? LIMIT 1",
);
const deleteTrackStmt = db.prepare<[number]>("DELETE FROM library_tracks WHERE id = ?");

const moveAlbumFilesStmt = db.prepare<[number, number, number, number]>(
  "UPDATE library_media_files SET track_id = ?, updated_at = ? WHERE track_id = ? AND album_id = ?",
);

// A track becomes the matching track for one album. A track other albums
// still list stays itself there, and only this album's files move.
function becomeAlbumTrack(
  albumId: number,
  track: Pick<LibraryTracksRow, "id">,
  match: Pick<LibraryTracksRow, "id" | "identity_key">,
) {
  unlinkAlbumTrackStmt.run(albumId, track.id);
  if (!trackLinkedStmt.get(track.id)) {
    rekeyLibraryTrack(track.id, match.identity_key);
    return;
  }
  moveAlbumFilesStmt.run(match.id, now(), track.id, albumId);
  syncLibrarySearchTrack(track.id);
}

// A track takes its twin's identity only when nothing plays it under its
// own: a tagged recording with files on another album stays that recording.
function foldLibraryAlbum(
  album: LibraryAlbumsRow,
  tracks: LibraryAlbumTrack[],
  target: LibraryAlbumsRow,
) {
  const targetTracks = albumTracksStmt.all(target.id);
  const dropped = [];
  for (const track of tracks) {
    const match = matchLibraryAlbumTrack(targetTracks, {
      title: track.title,
      discNumber: track.disc_number,
      trackNumber: track.track_number,
    });
    if (match?.id === track.id) continue;
    if (match && (isNameKey(track.identity_key) || !trackHasFileStmt.get(track.id))) {
      becomeAlbumTrack(album.id, track, match);
    } else if (!track.has_files) {
      dropped.push(track.id);
    }
  }
  db.prepare<[number, number]>(
    `DELETE FROM library_album_tracks
     WHERE album_id = ? AND track_id IN (SELECT track_id FROM library_album_tracks WHERE album_id = ?)`,
  ).run(album.id, target.id);
  rekeyLibraryAlbum(album.id, target.identity_key);
  for (const trackId of dropped) unlinkFilelessAlbumTrack(target.id, trackId);
}

function unlinkFilelessAlbumTrack(albumId: number, trackId: number) {
  unlinkAlbumTrackStmt.run(albumId, trackId);
  if (!trackLinkedStmt.get(trackId) && !trackHasFileStmt.get(trackId)) {
    deleteTrackStmt.run(trackId);
    removeLibrarySearchDocument("track", trackId);
  } else {
    syncLibrarySearchTrack(trackId);
  }
}

function removeEmptyLibraryAlbum(album: LibraryAlbumsRow, tracks: LibraryAlbumTrack[]) {
  for (const track of tracks) unlinkFilelessAlbumTrack(album.id, track.id);
  deleteLibraryAlbumRow(album.id, album.artist_id);
}

// An album nobody asked for lists its release's tracks and the songs it has
// files for.
function dropUnfiledAlbumTracks() {
  const links = db
    .prepare<[], { albumId: number; trackId: number }>(
      `SELECT link.album_id AS albumId, link.track_id AS trackId
     FROM library_album_tracks AS link
     JOIN library_albums AS album ON album.id = link.album_id
     JOIN library_tracks AS track ON track.id = link.track_id
     WHERE NOT ${ALBUM_IS_OWNED}
       AND NOT EXISTS (
         SELECT 1 FROM library_media_files AS media
         WHERE media.track_id = link.track_id AND (media.album_id = link.album_id OR media.album_id IS NULL)
       )
       AND NOT ${TRACK_IS_LISTED}`,
    )
    .all();
  for (const { albumId, trackId } of links) unlinkFilelessAlbumTrack(albumId, trackId);
  for (const albumId of new Set(links.map((link) => link.albumId))) touchLibraryAlbum(albumId);
  return links.length;
}

// Albums with a MusicBrainz release group whose track list Aurral has not
// stored, or stored for other files or before they were retagged, with their
// artist and the songs of their files. A requested album already has the
// track list it was requested with.
export function getLibraryAlbumsToList() {
  const albums = db
    .prepare<
      [],
      Pick<LibraryAlbumsRow, "id" | "mbid"> & {
        releaseGroupMbid: string;
        artistMbid: string | null;
        listedFor: string | null;
      }
    >(
      `SELECT album.id, album.mbid, album.release_group_mbid AS releaseGroupMbid, artist.mbid AS artistMbid,
       CASE WHEN json_valid(album.metadata_json) THEN json_extract(album.metadata_json, '$.trackList.for') END AS listedFor
     FROM library_albums AS album
     LEFT JOIN library_artists AS artist ON artist.id = album.artist_id
     WHERE album.release_group_mbid IS NOT NULL
       AND NOT (json_valid(album.metadata_json)
         AND COALESCE(json_extract(album.metadata_json, '$.trackListComplete'), 0) = 1)
     ORDER BY album.id`,
    )
    .iterate();
  const albumFiles = db.prepare<
    [number],
    Pick<LibraryTracksRow, "mbid" | "title"> &
      Pick<LibraryMediaFilesRow, "path"> & { mtimeMs: number | null }
  >(
    `SELECT DISTINCT track.mbid, track.title, media.path, media.mtime_ms AS mtimeMs
     FROM library_album_tracks AS link
     JOIN library_tracks AS track ON track.id = link.track_id
     JOIN library_media_files AS media ON media.track_id = track.id
       AND (media.album_id = link.album_id OR media.album_id IS NULL)
     WHERE link.album_id = ?
     ORDER BY media.path`,
  );
  const pending = [];
  for (const { listedFor, ...album } of albums) {
    const songs = albumFiles.all(album.id);
    const basis = createHash("sha1")
      .update(JSON.stringify([album.mbid, songs.map((file) => [file.path, file.mtimeMs])]))
      .digest("hex");
    if (listedFor !== basis) {
      pending.push({ ...album, basis, files: songs.map(({ mbid, title }) => ({ mbid, title })) });
    }
  }
  return pending;
}

export type LibraryAlbumToList = ReturnType<typeof getLibraryAlbumsToList>[number];

// A lookup that found nothing waits until the album's artist, title, or songs
// change, or a full scan asks again.
export function getUntaggedLibraryAlbums({ retry = false }: { retry?: boolean } = {}) {
  const albums = db
    .prepare<
      [],
      Pick<LibraryAlbumsRow, "id" | "title"> & {
        releaseDate: string | null;
        artistName: string;
        artistMbid: string;
        lookedUpFor: string | null;
      }
    >(
      `SELECT album.id, album.title, album.release_date AS releaseDate,
       artist.name AS artistName, artist.mbid AS artistMbid,
       CASE WHEN json_valid(album.metadata_json) THEN json_extract(album.metadata_json, '$.releaseGroupLookup') END AS lookedUpFor
     FROM library_albums AS album
     JOIN library_artists AS artist ON artist.id = album.artist_id
     WHERE album.mbid IS NULL AND album.release_group_mbid IS NULL AND artist.mbid IS NOT NULL
     ORDER BY album.id`,
    )
    .all();
  const albumSongs = db.prepare<[number], Pick<LibraryTracksRow, "mbid" | "title">>(
    `SELECT DISTINCT track.mbid, track.title
     FROM library_album_tracks AS link
     JOIN library_tracks AS track ON track.id = link.track_id
     JOIN library_media_files AS media ON media.track_id = track.id
       AND media.album_id = link.album_id AND media.available = 1
     WHERE link.album_id = ?
     ORDER BY track.title, track.mbid`,
  );
  return albums.flatMap(({ lookedUpFor, ...album }) => {
    const files = albumSongs.all(album.id);
    const basis = createHash("sha1")
      .update(JSON.stringify([album.artistMbid, album.title, files]))
      .digest("hex");
    return files.length && (retry || lookedUpFor !== basis) ? [{ ...album, files, basis }] : [];
  });
}

export type UntaggedLibraryAlbum = ReturnType<typeof getUntaggedLibraryAlbums>[number];

export function noteLibraryAlbumLookup(albumId: number, basis: string) {
  db.prepare<[string, number]>(
    `UPDATE library_albums
     SET metadata_json = json_set(
       CASE WHEN NOT json_valid(metadata_json) THEN '{}' WHEN json_type(metadata_json) = 'object' THEN metadata_json ELSE '{}' END,
       '$.releaseGroupLookup', ?)
     WHERE id = ?`,
  ).run(basis, albumId);
}

// The album becomes the release group's, as if its files were tagged, and
// joins the Library's album of that release group when there is one.
export function assignLibraryAlbumReleaseGroup(albumId: number, releaseGroupMbid: string) {
  const key = buildIdentityKey("release-group", releaseGroupMbid);
  if (!key) return null;
  const id = db.transaction(() => {
    const kept = rekeyLibraryAlbum(albumId, key);
    if (kept != null) {
      db.prepare<[string, number]>(
        "UPDATE library_albums SET release_group_mbid = ? WHERE id = ? AND release_group_mbid IS NULL",
      ).run(releaseGroupMbid, kept);
    }
    return kept;
  })();
  if (id != null) invalidateLibraryCache();
  return id;
}

type ReleaseTrack = Partial<
  Pick<
    NormalizedTrack,
    | "id"
    | "recordingId"
    | "oldRecordingIds"
    | "title"
    | "artistId"
    | "mediumNumber"
    | "trackPosition"
    | "trackNumber"
  >
>;

type AlbumRelease = Partial<Pick<NormalizedRelease, "id" | "tracks">>;

type ReleaseGroup = Partial<Pick<NormalizedAlbum, "artistId" | "artists" | "releases">>;

type LibraryAlbumFile = Pick<LibraryTracksRow, "mbid" | "title">;

// A release's track stands for its recording and the ones MusicBrainz merged
// into it.
const releaseRecordings = (track: ReleaseTrack) =>
  [track?.recordingId || track?.id, ...(track?.oldRecordingIds || [])]
    .map(normalizeText)
    .filter(Boolean);

// A release group is an album's when it holds one of the album's files: by
// recording or title when it is the album artist's, and by recording and
// title when it is another artist's. A wrong guess tags files with a group
// that holds none of them, or with another artist's group and recordings of
// its other songs. An album without files lists the group it was asked for.
export function isLibraryAlbumReleaseGroup(
  { artistMbid = null, files = [] }: { artistMbid?: string | null; files?: LibraryAlbumFile[] },
  group: ReleaseGroup,
) {
  if (!files.length) return true;
  const own =
    !artistMbid ||
    [group?.artistId, ...(group?.artists || []).map((artist) => artist.id)].includes(artistMbid);
  const tracks = (group?.releases || []).flatMap((release) => release.tracks || []);
  const holds = (file: LibraryAlbumFile, track: ReleaseTrack) => {
    const recorded = Boolean(file.mbid) && releaseRecordings(track).includes(file.mbid!);
    if (own ? recorded : !recorded) return recorded;
    return isSameSong(track.title, file.title) || isSameSongAtPlace(track.title, file.title);
  };
  return files.some((file) => tracks.some((track) => holds(file, track)));
}

// An album lists the release its files come from: the one holding most of
// their recordings, then most of their songs by title, then the release they
// are tagged with, then the standard one, then the shortest.
export function chooseLibraryAlbumRelease(
  { mbid = null, files = [] }: { mbid?: string | null; files?: LibraryAlbumFile[] },
  releases: AlbumRelease[] = [],
  standard: AlbumRelease | null = null,
) {
  const fileSongs = files.map((file) => songKey(file.title)).filter(Boolean);
  let best: { release: AlbumRelease; rank: number[] } | null = null;
  for (const release of releases) {
    if (!release?.tracks?.length) continue;
    const recordings = new Set(release.tracks.flatMap(releaseRecordings));
    const songs = new Set(release.tracks.map((track) => songKey(track.title)));
    const rank = [
      files.filter((file) => file.mbid && recordings.has(file.mbid)).length,
      fileSongs.filter((song) => songs.has(song)).length,
      Number(release.id === mbid),
      Number(Boolean(standard?.id) && release.id === standard!.id),
      -release.tracks.length,
    ];
    const differs = best ? rank.findIndex((value, index) => value !== best!.rank[index]) : -1;
    if (!best || (differs >= 0 && rank[differs] > best.rank[differs])) best = { release, rank };
  }
  return best?.release || standard;
}

// An album lists every place on its release. Each track it lists stands for
// one place, a file before a song listed earlier without one: the recording,
// or one MusicBrainz merged into it, at the same place, then elsewhere, then a
// tagged file by title and position, then the only tagged file left with the
// title of a song the release lists once. The rest are added as missing, and
// an untagged copy then folds into its track. Missing tracks download only
// once someone asks for them.
export function storeLibraryAlbumTrackList(
  albumId: number,
  {
    release,
    basis = null,
    artistNameFor = () => null,
  }: {
    release: AlbumRelease | null;
    basis?: string | null;
    artistNameFor?: (track: ReleaseTrack) => string | null;
  },
) {
  const tracks = (Array.isArray(release?.tracks) ? release.tracks : [])
    .map((track) => ({
      mbid: normalizeText(track?.recordingId || track?.id),
      mbids: releaseRecordings(track),
      title: normalizeText(track?.title),
      discNumber: Number(track?.mediumNumber) || 1,
      trackNumber: Number(track?.trackPosition || track?.trackNumber) || 0,
      artistName: artistNameFor(track),
    }))
    .filter((track) => track.mbid && track.title);
  const stored = db.transaction(() => {
    const album = db
      .prepare<[number], LibraryAlbumsRow>("SELECT * FROM library_albums WHERE id = ?")
      .get(albumId);
    if (!album) return false;
    const unused = albumTracksStmt.all(album.id);
    const take = (entry: LibraryAlbumTrack | null | undefined) =>
      entry && unused.splice(unused.indexOf(entry), 1)[0];
    const places: (LibraryAlbumTrack | null | undefined)[] = tracks.map(() => null);
    type PlannedTrack = (typeof tracks)[number];
    const fill = (find: (track: PlannedTrack) => LibraryAlbumTrack | null | undefined) => {
      for (const [index, track] of tracks.entries()) places[index] ||= take(find(track));
    };
    const atPlace = (track: PlannedTrack) => (entry: LibraryAlbumTrack) =>
      entry.disc_number === track.discNumber && entry.track_number === track.trackNumber;
    const recorded = (track: { mbids: readonly (string | null)[] }) => (entry: LibraryAlbumTrack) =>
      track.mbids.includes(entry.mbid);
    const files = () => unused.filter((entry) => entry.has_files);
    const songs = Map.groupBy(tracks, (track) => songKey(track.title));
    fill((track) => files().find((entry) => recorded(track)(entry) && atPlace(track)(entry)));
    fill((track) => files().find(recorded(track)));
    fill((track) =>
      matchLibraryAlbumTrack(
        files().filter((entry) => entry.mbid),
        track,
      ),
    );
    fill((track) => {
      const named = files().filter(
        (entry) => entry.mbid && songKey(entry.title) === songKey(track.title),
      );
      return songs.get(songKey(track.title))!.length === 1 && named.length === 1 ? named[0] : null;
    });
    fill((track) => unused.find(recorded(track)));
    const recordings = [];
    for (const [index, track] of tracks.entries()) {
      const have = places[index];
      if (have) {
        recordings.push(have.mbid || track.mbid);
        continue;
      }
      const key = buildIdentityKey("recording", track.mbid);
      const row =
        db
          .prepare<[string | null], LibraryTracksRow>(
            "SELECT * FROM library_tracks WHERE identity_key = ?",
          )
          .get(key) ||
        upsertLibraryTrack({
          identityKey: key,
          mbid: track.mbid,
          title: track.title,
          artistName: track.artistName || album.album_artist,
        });
      linkLibraryAlbumTrack({
        albumId: album.id,
        trackId: row.id,
        discNumber: track.discNumber,
        trackNumber: track.trackNumber,
      });
      recordings.push(track.mbid);
    }
    db.prepare<[string, number, number]>(
      `UPDATE library_albums
       SET metadata_json = json_set(
           CASE WHEN NOT json_valid(metadata_json) THEN '{}' WHEN json_type(metadata_json) = 'object' THEN metadata_json ELSE '{}' END,
           '$.trackList', json(?)),
         updated_at = ?
       WHERE id = ?`,
    ).run(
      JSON.stringify({ release: release?.id || null, for: basis, recordings }),
      now(),
      album.id,
    );
    return true;
  })();
  if (stored) invalidateLibraryCache();
  return stored;
}

type LibraryTrackCopy = Pick<LibraryAlbumTracksRow, "album_id" | "disc_number" | "track_number"> &
  Pick<LibraryTracksRow, "id" | "title" | "identity_key"> & { has_files: number; listed: number };

// An untagged copy of a track its album already lists with MusicBrainz IDs
// is that track: the one at its place, else, for copies numbered another way,
// as one disc for a release of several, the only one with its title that has
// no file, when no other copy left has that title. A copy tagged with a
// recording the album's release does not list, as a song downloaded twice
// carries, is the song the release lists at its place.
function foldLibraryTrackCopies() {
  const links = db
    .prepare<[], LibraryTrackCopy>(
      `SELECT link.album_id, link.disc_number, link.track_number, track.id, track.title, track.identity_key,
       EXISTS (
         SELECT 1 FROM library_media_files AS media
         WHERE media.track_id = track.id AND (media.album_id = link.album_id OR media.album_id IS NULL)
       ) AS has_files,
       ${TRACK_IS_LISTED} AS listed
     FROM library_album_tracks AS link
     JOIN library_albums AS album ON album.id = link.album_id
     JOIN library_tracks AS track ON track.id = link.track_id
     WHERE link.album_id IN (
       SELECT named.album_id FROM library_album_tracks AS named
       JOIN library_tracks AS untagged ON untagged.id = named.track_id AND untagged.identity_key LIKE 'name:%'
       INTERSECT
       SELECT known.album_id FROM library_album_tracks AS known
       JOIN library_tracks AS tagged ON tagged.id = known.track_id AND tagged.identity_key NOT LIKE 'name:%'
     ) OR link.album_id IN (
       SELECT copy.album_id FROM library_album_tracks AS copy
       JOIN library_albums AS album ON album.id = copy.album_id
         AND CASE WHEN json_valid(album.metadata_json) THEN json_extract(album.metadata_json, '$.trackList.release') END IS NOT NULL
       JOIN library_tracks AS track ON track.id = copy.track_id AND track.identity_key NOT LIKE 'name:%'
       WHERE NOT ${TRACK_IS_LISTED} AND EXISTS (
         SELECT 1 FROM library_media_files AS media
         WHERE media.track_id = track.id AND (media.album_id = copy.album_id OR media.album_id IS NULL)
       )
     )
     ORDER BY link.album_id`,
    )
    .all();
  const place = (track: LibraryTrackCopy) => ({
    title: track.title,
    discNumber: track.disc_number,
    trackNumber: track.track_number,
  });
  let changed = 0;
  for (const [albumId, tracks] of Map.groupBy(links, (link) => link.album_id)) {
    const tagged = tracks.filter((track) => !isNameKey(track.identity_key));
    const listed = tagged.filter((track) => track.listed);
    const copies = tagged
      .filter((track) => !track.listed && track.has_files)
      .map((track) => [track, matchLibraryAlbumTrack(listed, place(track))] as const)
      .filter(([, match]) => match);
    const copied = new Set(copies.map(([track]) => track.id));
    const targets = tagged.filter((track) => !copied.has(track.id));
    const folds = tracks
      .filter((track) => isNameKey(track.identity_key))
      .map((track) => [track, matchLibraryAlbumTrack(targets, place(track))] as const);
    const filled = new Set(folds.map(([, match]) => match?.id));
    const left = folds.filter(([, match]) => !match).map(([track]) => track);
    for (const track of left) {
      const named = (entry: LibraryTrackCopy) => songKey(entry.title) === songKey(track.title);
      const songs = new Set(targets.filter(named).map((entry) => entry.id));
      const match =
        songs.size === 1 &&
        left.filter(named).length === 1 &&
        targets.find((entry) => songs.has(entry.id) && !entry.has_files && !filled.has(entry.id));
      if (match) folds.push([track, match]);
    }
    for (const [track, match] of [...copies, ...folds]) {
      if (!match) continue;
      becomeAlbumTrack(albumId, track, match);
      changed += 1;
    }
  }
  return changed;
}

// An artist's albums with one title are one album, and the Library holds no
// album nobody can play or asked for. After a scan, an untagged album folds
// into the album with its title, taking its files, favorites, and plays, as
// does an album whose files all moved to another. One with no files and
// nowhere to go is removed; its favorites and plays come back with it.
const albumExistsStmt = db.prepare<[number], { 1: number }>(
  "SELECT 1 FROM library_albums WHERE id = ?",
);
const artistAlbumsStmt = db.prepare<[number, number], LibraryAlbumsRow>(
  "SELECT * FROM library_albums WHERE artist_id = ? AND id != ? ORDER BY id",
);

const markLibraryTidiedStmt = db.prepare<[number, number]>(
  "INSERT INTO library_scan_runs (source, status, started_at, completed_at) VALUES ('library-tidy', 'complete', ?, ?)",
);

// Removed rows take their timestamps with them, so a tidy that changed
// anything stamps a time after the Library's last one, or Subsonic clients
// asking whether the index changed keep what was removed.
export function reconcileLibraryAlbums() {
  const indexedAt = getLibraryIndexLastModified() ?? 0;
  if (db.transaction(reconcileAlbums).immediate() === 0) return;
  const tidiedAt = Math.max(now(), indexedAt + 1);
  markLibraryTidiedStmt.run(tidiedAt, tidiedAt);
  invalidateLibraryManagementCache();
  invalidateLibraryCache();
}

function reconcileAlbums() {
  let changed = repairLibraryFileAlbums();
  const albums = db
    .prepare<[], LibraryAlbumsRow & { owned: number; has_files: number }>(
      `SELECT album.*, ${ALBUM_IS_OWNED} AS owned, ${ALBUM_HAS_FILES} AS has_files
     FROM library_albums AS album
     WHERE album.identity_key LIKE 'name:%' OR (NOT ${ALBUM_HAS_FILES} AND NOT ${ALBUM_IS_OWNED})
     ORDER BY album.id`,
    )
    .all();
  for (const album of albums) {
    if (!album.has_files && album.owned) continue;
    const siblings = artistAlbumsStmt
      .all(album.artist_id, album.id)
      .filter((sibling) => isSameLibraryName(sibling.title, album.title));
    if (album.has_files && siblings.length === 0) continue;
    if (!albumExistsStmt.get(album.id)) continue;
    const tracks = albumTracksStmt.all(album.id);
    const hasFiles = tracks.some((track) => track.has_files);
    const titles = (hasFiles ? tracks.filter((track) => track.has_files) : tracks).map(
      (track) => track.title,
    );
    const target = chooseLibraryAlbum(siblings, titles);
    if (!target && hasFiles) continue;
    try {
      db.transaction(() =>
        target ? foldLibraryAlbum(album, tracks, target) : removeEmptyLibraryAlbum(album, tracks),
      )();
      changed += 1;
    } catch (error) {
      logger.warn("library", "Could not tidy a Library album", {
        albumId: album.id,
        reason: safeLogDiagnostic(error),
      });
    }
  }
  return changed + foldLibraryTrackCopies() + dropUnfiledAlbumTracks();
}

// Downloads once took an album's release ID for its release group, and the
// scan filed them under a second album keyed by that release ID. Each such
// album folds into the album the release belongs to.
export function mergeReleaseKeyedLibraryAlbums() {
  const pairs = db
    .prepare<[], { duplicateId: number; duplicateKey: string; albumId: number; albumKey: string }>(
      `SELECT duplicate.id AS duplicateId, duplicate.identity_key AS duplicateKey,
       album.id AS albumId, album.identity_key AS albumKey
     FROM library_albums AS album
     JOIN library_albums AS duplicate ON duplicate.identity_key = 'release-group:' || album.mbid
     WHERE album.mbid IS NOT NULL AND album.release_group_mbid IS NOT NULL
       AND album.mbid != album.release_group_mbid AND duplicate.id != album.id`,
    )
    .all();
  if (pairs.length === 0) return 0;
  db.transaction(() => {
    for (const pair of pairs) {
      db.prepare<[number, number, number]>(
        `INSERT OR IGNORE INTO library_album_tracks (album_id, track_id, disc_number, track_number, created_at)
         SELECT ?, link.track_id, link.disc_number, link.track_number, link.created_at
         FROM library_album_tracks AS link
         WHERE link.album_id = ? AND NOT EXISTS (
           SELECT 1 FROM library_album_tracks AS kept WHERE kept.album_id = ? AND kept.track_id = link.track_id
         )`,
      ).run(pair.albumId, pair.duplicateId, pair.albumId);
      db.prepare<[number, number]>(
        "UPDATE library_media_files SET album_id = ? WHERE album_id = ?",
      ).run(pair.albumId, pair.duplicateId);
      db.prepare<[string, string]>(
        `INSERT OR IGNORE INTO subsonic_stars (user_id, entity_kind, entity_key, created_at)
         SELECT user_id, entity_kind, ?, created_at FROM subsonic_stars
         WHERE entity_kind = 'album' AND entity_key = ?`,
      ).run(pair.albumKey, pair.duplicateKey);
      db.prepare<[string]>(
        "DELETE FROM subsonic_stars WHERE entity_kind = 'album' AND entity_key = ?",
      ).run(pair.duplicateKey);
      db.prepare<[number]>("DELETE FROM library_album_tracks WHERE album_id = ?").run(
        pair.duplicateId,
      );
      clearLibraryManagement("album", pair.duplicateId);
      db.prepare<[number]>("DELETE FROM library_albums WHERE id = ?").run(pair.duplicateId);
      removeLibrarySearchDocument("album", pair.duplicateId);
      touchLibraryAlbum(pair.albumId);
    }
  })();
  for (const pair of pairs) syncLibrarySearchAlbum(pair.albumId);
  invalidateLibraryCache();
  return pairs.length;
}

const isAsciiText = (column: string) => `length(CAST(${column} AS BLOB)) = length(${column})`;

// Whether a stored key is the one scans wrote before key parts kept letters
// ASCII cannot spell, for names whose key now keeps them. Such keys are ASCII.
type KeyBuilder = (part: KeyPart) => string | null;

const isLegacyFallbackKey = (key: string, build: KeyBuilder) => {
  const legacy = build(asciiKeyPart);
  return legacy === key && legacy !== build(normalizeKeyPart);
};

const legacyAlbumKeyBuilders = ({
  album_title: title,
  album_artist: albumArtist,
  artist_mbid: artistMbid,
}: {
  album_title: string;
  album_artist: string | null;
  artist_mbid: string | null;
}) =>
  [
    albumArtist &&
      ((part: KeyPart) =>
        joinFallbackKey(part, ["album", joinFallbackKey(part, ["artist", albumArtist]), title])),
    artistMbid &&
      ((part: KeyPart) =>
        joinFallbackKey(part, ["album", buildIdentityKey("mbid", artistMbid), title])),
  ].filter(Boolean) as KeyBuilder[];

const keyedByForeignIds = (table: string, prefixes: string[]) =>
  db
    .prepare<[], number>(
      `SELECT id FROM ${table} WHERE ${prefixes
        .map(
          (prefix) =>
            `(identity_key LIKE '${prefix}:%' AND substr(identity_key, ${prefix.length + 2}) NOT GLOB '${MBID_GLOB}')`,
        )
        .join(" OR ")}`,
    )
    .pluck()
    .all();

type LegacyAlbumRow = Pick<LibraryAlbumsRow, "id" | "identity_key"> & {
  album_title: string;
  album_artist: string | null;
  artist_mbid: string | null;
};

type LegacyTrackRow = Pick<LibraryTracksRow, "id" | "identity_key" | "title"> &
  Pick<LibraryAlbumTracksRow, "disc_number" | "track_number"> & {
    album_key: string;
    album_title: string;
    album_artist: string | null;
    artist_mbid: string | null;
  };

// Scans once gave every name written only in letters ASCII cannot spell the
// same key, so such artists, albums, and tracks share rows, and took any value
// in a MusicBrainz ID tag as an ID, capitals or another service's ID. These
// are the files on rows still keyed that way, which a scan reads again.
export function findLegacyKeyedLibraryFiles(source: string) {
  const artistIds = db
    .prepare<[], Pick<LibraryArtistsRow, "id" | "identity_key" | "name">>(
      `SELECT id, identity_key, name FROM library_artists
     WHERE identity_key LIKE 'name:%' AND ${isAsciiText("identity_key")} AND NOT ${isAsciiText("name")}`,
    )
    .all()
    .filter(
      (artist) =>
        hasNonLatinLetters(artist.name) &&
        isLegacyFallbackKey(artist.identity_key, (part) =>
          joinFallbackKey(part, ["artist", artist.name]),
        ),
    )
    .map((artist) => artist.id);
  const albumIds = db
    .prepare<[], LegacyAlbumRow>(
      `SELECT album.id, album.identity_key, album.title AS album_title, album.album_artist,
       artist.mbid AS artist_mbid
     FROM library_albums AS album
     JOIN library_artists AS artist ON artist.id = album.artist_id
     WHERE album.identity_key LIKE 'name:%' AND ${isAsciiText("album.identity_key")}
       AND NOT (${isAsciiText("album.title")} AND ${isAsciiText("COALESCE(album.album_artist, '')")})`,
    )
    .all()
    .filter(
      (album) =>
        [album.album_title, album.album_artist].some(hasNonLatinLetters) &&
        legacyAlbumKeyBuilders(album).some((build) =>
          isLegacyFallbackKey(album.identity_key, build),
        ),
    )
    .map((album) => album.id);
  const trackIds = db
    .prepare<[], LegacyTrackRow>(
      `SELECT track.id, track.identity_key, track.title, link.disc_number, link.track_number,
       album.identity_key AS album_key, album.title AS album_title, album.album_artist,
       artist.mbid AS artist_mbid
     FROM library_tracks AS track
     JOIN library_album_tracks AS link ON link.track_id = track.id
     JOIN library_albums AS album ON album.id = link.album_id
     JOIN library_artists AS artist ON artist.id = album.artist_id
     WHERE track.identity_key LIKE 'name:%' AND ${isAsciiText("track.identity_key")}
       AND NOT (${isAsciiText("track.title")} AND ${isAsciiText("album.title")}
         AND ${isAsciiText("COALESCE(album.album_artist, '')")})`,
    )
    .all()
    .filter(
      (row) =>
        [row.title, row.album_title, row.album_artist].some(hasNonLatinLetters) &&
        [() => row.album_key, ...legacyAlbumKeyBuilders(row)].some((albumKey) =>
          isLegacyFallbackKey(row.identity_key, (part) =>
            joinFallbackKey(part, [
              "track",
              albumKey(part),
              row.disc_number,
              row.track_number,
              row.title,
            ]),
          ),
        ),
    )
    .map((row) => row.id);
  artistIds.push(...keyedByForeignIds("library_artists", ["mbid"]));
  albumIds.push(...keyedByForeignIds("library_albums", ["release-group", "album"]));
  trackIds.push(...keyedByForeignIds("library_tracks", ["recording"]));
  if (!artistIds.length && !albumIds.length && !trackIds.length) {
    return { paths: new Set<string>(), albumIds: new Set<number>() };
  }
  const paths = db
    .prepare<[string, string, string, string], string>(
      `SELECT path FROM library_media_files
     WHERE source = ? AND (
       track_id IN (SELECT value FROM json_each(?))
       OR album_id IN (SELECT value FROM json_each(?))
       OR album_id IN (
         SELECT id FROM library_albums WHERE artist_id IN (SELECT value FROM json_each(?))
       )
     )`,
    )
    .pluck()
    .all(
      normalizeText(source),
      JSON.stringify(trackIds),
      JSON.stringify(albumIds),
      JSON.stringify(artistIds),
    );
  return { paths: new Set(paths), albumIds: new Set(albumIds) };
}

const CARRIED_ARTIST_METADATA_KEYS = [
  "monitored",
  "monitor",
  "monitorOption",
  "monitorNewItems",
  "mbidSource",
];

// Plays move to the album whose title they name as soon as it has split off.
// The shared row's last split also takes what no title claims.
function moveLegacyAlbumPlays(
  album: LibraryAlbumsRow,
  targets: LibraryAlbumsRow[],
  { final }: { final: boolean },
) {
  const counts = new Map<
    string,
    { userId: number; target: LibraryAlbumsRow; plays: number; playedAt: number }
  >();
  const count = (userId: number, target: LibraryAlbumsRow, plays: number, playedAt: number) => {
    const key = `${userId}:${target.id}`;
    const entry = counts.get(key) || { userId, target, plays: 0, playedAt: 0 };
    entry.plays += plays;
    entry.playedAt = Math.max(entry.playedAt, Number(playedAt) || 0);
    counts.set(key, entry);
  };
  const movedByUser = new Map<number, number>();
  for (const event of db
    .prepare<[string], Pick<PlayEventsRow, "id" | "user_id" | "artist" | "album" | "played_at">>(
      "SELECT id, user_id, artist, album, played_at FROM play_events WHERE album_key = ?",
    )
    .all(album.identity_key)) {
    const target =
      targets.find(
        (entry) =>
          isSameLibraryName(entry.title, event.album) &&
          isSameLibraryName(entry.album_artist, event.artist),
      ) ||
      targets.find((entry) => isSameLibraryName(entry.title, event.album)) ||
      (final ? targets[0] : null);
    if (!target) continue;
    db.prepare<[string, number]>("UPDATE play_events SET album_key = ? WHERE id = ?").run(
      target.identity_key,
      event.id,
    );
    count(event.user_id, target, 1, event.played_at);
    movedByUser.set(event.user_id, (movedByUser.get(event.user_id) || 0) + 1);
  }
  const takePlays = db.prepare<[number, number, string]>(
    "UPDATE play_album_stats SET play_count = MAX(play_count - ?, 0) WHERE user_id = ? AND album_key = ?",
  );
  for (const [userId, moved] of movedByUser) takePlays.run(moved, userId, album.identity_key);
  if (final) {
    for (const stats of db
      .prepare<[string], Pick<PlayAlbumStatsRow, "user_id" | "play_count" | "last_played_at">>(
        "SELECT user_id, play_count, last_played_at FROM play_album_stats WHERE album_key = ? AND play_count > 0",
      )
      .all(album.identity_key)) {
      count(stats.user_id, targets[0], stats.play_count, stats.last_played_at);
    }
  }
  const addPlays = db.prepare<[number, string, number, number]>(
    `INSERT INTO play_album_stats (user_id, album_key, play_count, last_played_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (user_id, album_key) DO UPDATE SET
       play_count = play_album_stats.play_count + excluded.play_count,
       last_played_at = MAX(play_album_stats.last_played_at, excluded.last_played_at)`,
  );
  for (const entry of counts.values()) {
    addPlays.run(entry.userId, entry.target.identity_key, entry.plays, entry.playedAt);
  }
  if (final)
    db.prepare<[string]>("DELETE FROM play_album_stats WHERE album_key = ?").run(
      album.identity_key,
    );
}

type LegacyKeyedMove = {
  fromTrackId: number;
  toTrackId: number;
  fromAlbumId: number | null;
  toAlbumId: number;
  fromArtistId?: number | null;
  toArtistId: number;
};

type LibraryRowByTable = {
  library_tracks: LibraryTracksRow;
  library_albums: LibraryAlbumsRow;
  library_artists: LibraryArtistsRow;
};

// A scan files what shared a legacy key under rows of its own. Each of those
// rows gets the shared row's favorites, monitoring, and the plays naming it,
// since a split can take more than one scan. Once no file is left on the
// shared row, the rest of its plays and its queue places move, and it goes.
export function splitLegacyKeyedLibraryRows(moves: LegacyKeyedMove[]) {
  const targetsOf = (
    from: "fromTrackId" | "fromAlbumId" | "fromArtistId",
    to: "toTrackId" | "toAlbumId" | "toArtistId",
  ) => {
    const targets = new Map();
    for (const move of moves) {
      if (move[from] == null || move[to] == null || move[from] === move[to]) continue;
      if (!targets.has(move[from])) targets.set(move[from], new Set());
      targets.get(move[from]).add(move[to]);
    }
    return targets;
  };
  const rows = <T extends keyof LibraryRowByTable>(
    table: T,
    fromId: number,
    toIds: Set<number>,
  ) => {
    const read = db.prepare<[number], LibraryRowByTable[T]>(`SELECT * FROM ${table} WHERE id = ?`);
    return {
      row: read.get(fromId),
      targets: [...toIds].map((id) => read.get(id)).filter(Boolean) as LibraryRowByTable[T][],
    };
  };
  const removed: { track: number[]; album: number[]; artist: number[] } = {
    track: [],
    album: [],
    artist: [],
  };
  db.transaction(() => {
    for (const move of moves) {
      if (move.fromAlbumId == null || move.fromAlbumId === move.toAlbumId) continue;
      db.prepare<[number, number, number, number]>(
        `DELETE FROM library_album_tracks WHERE album_id = ? AND track_id = ? AND NOT EXISTS (
           SELECT 1 FROM library_media_files WHERE album_id = ? AND track_id = ?
         )`,
      ).run(move.fromAlbumId, move.toTrackId, move.fromAlbumId, move.toTrackId);
    }
    for (const [fromId, toIds] of targetsOf("fromTrackId", "toTrackId")) {
      const { row: track, targets } = rows("library_tracks", fromId, toIds);
      if (!track || !targets.length) continue;
      for (const target of targets)
        copyLibraryStars("song", track.identity_key, target.identity_key);
      if (track.monitored === 1) {
        for (const target of targets) {
          db.prepare<[number]>("UPDATE library_tracks SET monitored = 1 WHERE id = ?").run(
            target.id,
          );
        }
      }
      if (
        db
          .prepare<[number], { 1: number }>(
            "SELECT 1 FROM library_media_files WHERE track_id = ? LIMIT 1",
          )
          .get(track.id)
      )
        continue;
      moveQueuedLibrarySong(track.identity_key, targets[0].identity_key);
      db.prepare<[string]>(
        "DELETE FROM subsonic_stars WHERE entity_kind = 'song' AND entity_key = ?",
      ).run(track.identity_key);
      db.prepare<[number]>("DELETE FROM library_tracks WHERE id = ?").run(track.id);
      removed.track.push(track.id);
    }
    for (const [fromId, toIds] of targetsOf("fromAlbumId", "toAlbumId")) {
      const { row: album, targets } = rows("library_albums", fromId, toIds);
      if (!album || !targets.length) continue;
      for (const target of targets)
        copyLibraryStars("album", album.identity_key, target.identity_key);
      const final = !db
        .prepare<[number, number], { 1: number }>(
          `SELECT 1 FROM library_media_files WHERE album_id = ?
         UNION ALL SELECT 1 FROM library_album_tracks WHERE album_id = ? LIMIT 1`,
        )
        .get(album.id, album.id);
      moveLegacyAlbumPlays(album, targets, { final });
      const monitored = readRawLibraryMetadata(album.metadata_json).monitored === true;
      for (const target of targets) {
        db.prepare<[number, number]>(
          `INSERT INTO library_management
            (entity_kind, entity_id, managed_by, monitor_mode, created_at, updated_at, last_missing_search_at)
           SELECT 'album', ?, managed_by, monitor_mode, created_at, updated_at, last_missing_search_at
           FROM library_management WHERE entity_kind = 'album' AND entity_id = ?
           ON CONFLICT (entity_kind, entity_id) DO UPDATE SET
             monitor_mode = COALESCE(library_management.monitor_mode, excluded.monitor_mode)
           WHERE library_management.managed_by = excluded.managed_by`,
        ).run(target.id, album.id);
        if (monitored) {
          db.prepare<[number, number]>(
            `UPDATE library_albums
             SET metadata_json = json_set(
               CASE WHEN json_valid(metadata_json) THEN metadata_json ELSE '{}' END,
               '$.monitored', json('true'))
             WHERE id = ? AND NOT EXISTS (
               SELECT 1 FROM library_management
               WHERE entity_kind = 'album' AND entity_id = ? AND managed_by = 'lidarr'
             )`,
          ).run(target.id, target.id);
        }
      }
      if (!final) continue;
      db.prepare<[string]>(
        "DELETE FROM subsonic_stars WHERE entity_kind = 'album' AND entity_key = ?",
      ).run(album.identity_key);
      clearLibraryManagement("album", album.id);
      db.prepare<[number]>("DELETE FROM library_albums WHERE id = ?").run(album.id);
      removed.album.push(album.id);
    }
    for (const [fromId, toIds] of targetsOf("fromArtistId", "toArtistId")) {
      const { row: artist, targets } = rows("library_artists", fromId, toIds);
      if (!artist || !targets.length) continue;
      for (const target of targets)
        copyLibraryStars("artist", artist.identity_key, target.identity_key);
      const metadata = readRawLibraryMetadata(artist.metadata_json);
      for (const target of targets) {
        const targetMetadata = readRawLibraryMetadata(target.metadata_json);
        const carried = CARRIED_ARTIST_METADATA_KEYS.filter(
          (key) => metadata[key] !== undefined && targetMetadata[key] === undefined,
        );
        if (carried.length) {
          db.prepare<[string | null, number]>(
            "UPDATE library_artists SET metadata_json = ? WHERE id = ?",
          ).run(
            stringify({
              ...targetMetadata,
              ...Object.fromEntries(carried.map((key) => [key, metadata[key]])),
            }),
            target.id,
          );
        }
        db.prepare<[number, number]>(
          `INSERT OR IGNORE INTO library_management
            (entity_kind, entity_id, managed_by, monitor_mode, monitor_rules, created_at, updated_at, last_missing_search_at)
           SELECT entity_kind, ?, managed_by, monitor_mode, monitor_rules, created_at, updated_at, last_missing_search_at
           FROM library_management WHERE entity_kind = 'artist' AND entity_id = ?`,
        ).run(target.id, artist.id);
      }
      if (
        db
          .prepare<[number], { 1: number }>(
            "SELECT 1 FROM library_albums WHERE artist_id = ? LIMIT 1",
          )
          .get(artist.id)
      )
        continue;
      db.prepare<[string]>(
        "DELETE FROM subsonic_stars WHERE entity_kind = 'artist' AND entity_key = ?",
      ).run(artist.identity_key);
      clearLibraryManagement("artist", artist.id);
      db.prepare<[number]>("DELETE FROM library_artists WHERE id = ?").run(artist.id);
      removed.artist.push(artist.id);
    }
  }).immediate();
  for (const [kind, ids] of Object.entries(removed)) {
    for (const id of ids) removeLibrarySearchDocument(kind, id);
  }
  invalidateLibraryManagementCache();
  invalidateLibraryCache();
}

export function removeLibraryTrackIfNoAvailableMedia(trackId: number | string) {
  const normalizedTrackId = Number(trackId);
  if (!Number.isSafeInteger(normalizedTrackId)) return false;
  const removed = db.transaction(() => {
    const mediaFiles = db
      .prepare<[number], Pick<LibraryMediaFilesRow, "album_id" | "available">>(
        "SELECT album_id, available FROM library_media_files WHERE track_id = ?",
      )
      .all(normalizedTrackId);
    if (!mediaFiles.length || mediaFiles.some((file) => file.available === 1)) return false;

    const albumIds = new Set([
      ...db
        .prepare<[number], Pick<LibraryAlbumTracksRow, "album_id">>(
          "SELECT album_id FROM library_album_tracks WHERE track_id = ?",
        )
        .all(normalizedTrackId)
        .map((row) => row.album_id),
      ...mediaFiles.map((file) => file.album_id).filter((albumId) => albumId != null),
    ]);
    const artistIds = new Set(
      db
        .prepare<number[], Pick<LibraryAlbumsRow, "artist_id">>(
          `SELECT artist_id
         FROM library_albums
         WHERE id IN (${[...albumIds].map(() => "?").join(",") || "NULL"})`,
        )
        .all(...albumIds)
        .map((row) => row.artist_id),
    );

    removeLibrarySearchDocument("track", normalizedTrackId);
    db.prepare<[number]>("DELETE FROM library_media_files WHERE track_id = ?").run(
      normalizedTrackId,
    );
    db.prepare<[number]>("DELETE FROM library_album_tracks WHERE track_id = ?").run(
      normalizedTrackId,
    );
    db.prepare<[number]>("DELETE FROM library_tracks WHERE id = ?").run(normalizedTrackId);

    for (const albumId of albumIds) {
      const result = db
        .prepare<[number, number]>(
          `DELETE FROM library_albums
         WHERE id = ?
           AND NOT EXISTS (SELECT 1 FROM library_album_tracks WHERE album_id = ?)`,
        )
        .run(albumId, albumId);
      if (result.changes > 0) removeLibrarySearchDocument("album", albumId);
      else touchLibraryAlbum(albumId);
    }
    for (const artistId of artistIds) {
      const result = db
        .prepare<[number, number]>(
          `DELETE FROM library_artists
         WHERE id = ?
           AND NOT EXISTS (SELECT 1 FROM library_albums WHERE artist_id = ?)`,
        )
        .run(artistId, artistId);
      if (result.changes > 0) removeLibrarySearchDocument("artist", artistId);
    }
    return true;
  })();
  if (removed) invalidateLibraryCache();
  return removed;
}

export function removeLibraryArtistIfEmpty(artistId: number | string) {
  const normalizedArtistId = Number(artistId);
  if (!Number.isSafeInteger(normalizedArtistId)) return false;
  const removed =
    db
      .prepare<[number, number]>(
        `DELETE FROM library_artists
     WHERE id = ?
       AND NOT EXISTS (SELECT 1 FROM library_albums WHERE artist_id = ?)`,
      )
      .run(normalizedArtistId, normalizedArtistId).changes > 0;
  if (removed) {
    removeLibrarySearchDocument("artist", normalizedArtistId);
    invalidateLibraryCache();
  }
  return removed;
}

export function removeLibraryAlbumTracksWithoutAvailableMedia(albumId: number) {
  const normalizedAlbumId = Number(albumId);
  if (!Number.isSafeInteger(normalizedAlbumId)) return { albumRemoved: false };
  const result = db
    .transaction(() => {
      const trackIds = db
        .prepare<[number], { id: number }>(
          `SELECT link.track_id AS id
       FROM library_album_tracks link
       WHERE link.album_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM library_media_files file
           WHERE file.track_id = link.track_id AND file.available = 1
         )`,
        )
        .all(normalizedAlbumId)
        .map((row) => row.id);

      for (const trackId of trackIds) {
        db.prepare<[number, number]>(
          "DELETE FROM library_album_tracks WHERE album_id = ? AND track_id = ?",
        ).run(normalizedAlbumId, trackId);
        const linkedElsewhere = db
          .prepare<[number], { 1: number }>(
            "SELECT 1 FROM library_album_tracks WHERE track_id = ? LIMIT 1",
          )
          .get(trackId);
        if (linkedElsewhere) {
          db.prepare<[number, number]>(
            "DELETE FROM library_media_files WHERE track_id = ? AND album_id = ?",
          ).run(trackId, normalizedAlbumId);
          continue;
        }
        removeLibrarySearchDocument("track", trackId);
        db.prepare<[number]>("DELETE FROM library_media_files WHERE track_id = ?").run(trackId);
        db.prepare<[number]>("DELETE FROM library_tracks WHERE id = ?").run(trackId);
      }

      const albumRemoved =
        db
          .prepare<[number, number]>(
            `DELETE FROM library_albums
       WHERE id = ?
         AND NOT EXISTS (SELECT 1 FROM library_album_tracks WHERE album_id = ?)`,
          )
          .run(normalizedAlbumId, normalizedAlbumId).changes > 0;
      if (albumRemoved) {
        db.prepare<[number]>(
          "DELETE FROM library_media_files WHERE album_id = ? AND available = 0",
        ).run(normalizedAlbumId);
        removeLibrarySearchDocument("album", normalizedAlbumId);
      } else {
        touchLibraryAlbum(normalizedAlbumId);
      }
      return { albumRemoved, changed: albumRemoved || trackIds.length > 0 };
    })
    .immediate();
  if (result.changed) invalidateLibraryCache();
  return { albumRemoved: result.albumRemoved };
}

export function upsertLibraryMediaFile({
  trackId,
  albumId = null,
  source,
  path,
  format = null,
  size = 0,
  mtimeMs = null,
  durationMs = null,
  quality = null,
  artistTag = null,
  available = true,
  scanId,
}: {
  trackId: number;
  albumId?: number | null;
  source: string;
  path: string;
  format?: string | null;
  size?: number;
  mtimeMs?: number | null;
  durationMs?: number | null;
  quality?: unknown;
  artistTag?: string | null;
  available?: boolean;
  scanId?: number;
}) {
  const filePath = normalizeText(path);
  const fileSource = normalizeText(source);
  if (!Number.isSafeInteger(Number(trackId)) || !fileSource || !filePath) {
    throw new Error("Library media file trackId, source, and path are required");
  }
  const normalizedAlbumId =
    Number.isSafeInteger(Number(albumId)) && Number(albumId) > 0 ? Number(albumId) : null;
  const normalizedFormat = format || null;
  const normalizedSize = Number(size) || 0;
  const normalizedMtimeMs = Number.isFinite(Number(mtimeMs)) ? Number(mtimeMs) : null;
  const normalizedDurationMs = Number.isFinite(Number(durationMs)) ? Number(durationMs) : null;
  const qualityText = stringify(quality);
  const normalizedArtistTag = normalizeText(artistTag) || null;
  const normalizedAvailable = available === true ? 1 : 0;
  const existing = getLibraryMediaFileStmt.get(fileSource, filePath);
  if (
    existing &&
    Number(trackId) === existing.track_id &&
    (normalizedAlbumId == null || normalizedAlbumId === existing.album_id) &&
    normalizedFormat === existing.format &&
    normalizedSize === existing.size &&
    normalizedMtimeMs === existing.mtime_ms &&
    normalizedDurationMs === existing.duration_ms &&
    (qualityText == null || qualityText === existing.quality_json) &&
    normalizedArtistTag === existing.artist_tag &&
    normalizedAvailable === existing.available
  ) {
    return existing;
  }
  const timestamp = now();
  upsertLibraryMediaFileStmt.run(
    Number(trackId),
    normalizedAlbumId,
    fileSource,
    filePath,
    normalizedFormat,
    normalizedSize,
    normalizedMtimeMs,
    normalizedDurationMs,
    qualityText,
    normalizedArtistTag,
    normalizedAvailable,
    Number(scanId),
    timestamp,
    timestamp,
  );
  invalidateLibraryCache();
  return getLibraryMediaFileStmt.get(fileSource, filePath);
}

export function getAvailableLibraryMediaPaths(source: string, scopes: string[] | null = null) {
  const mediaSource = normalizeText(source);
  const paths = new Set<string>();
  if (!Array.isArray(scopes)) {
    for (const row of db
      .prepare<[string], Pick<LibraryMediaFilesRow, "path">>(
        "SELECT path FROM library_media_files WHERE source = ? AND available = 1",
      )
      .iterate(mediaSource))
      paths.add(row.path);
    return paths;
  }
  const readScope = db.prepare<
    [string, string, string, string, string],
    Pick<LibraryMediaFilesRow, "path">
  >(
    `SELECT path FROM library_media_files WHERE source = ? AND available = 1 AND path = ?
     UNION ALL
     SELECT path FROM library_media_files
     WHERE source = ? AND available = 1 AND path >= ? AND path < ?`,
  );
  for (const scope of new Set(scopes.map((scope) => path.resolve(scope)))) {
    const prefix = scope.endsWith(path.sep) ? scope : `${scope}${path.sep}`;
    const upperBound = `${prefix.slice(0, -1)}${String.fromCharCode(path.sep.charCodeAt(0) + 1)}`;
    for (const row of readScope.iterate(mediaSource, scope, mediaSource, prefix, upperBound)) {
      paths.add(row.path);
    }
  }
  return paths;
}

export function getLibraryMediaPaths(source: string) {
  return new Set(
    db
      .prepare<[string], Pick<LibraryMediaFilesRow, "path">>(
        "SELECT path FROM library_media_files WHERE source = ?",
      )
      .all(normalizeText(source))
      .map((row) => row.path),
  );
}

export function markLibraryMediaFilesUnavailable(source: string, paths: string[]) {
  const mediaSource = normalizeText(source);
  const missingPaths = [...new Set(paths)].map(normalizeText).filter(Boolean);
  if (!mediaSource || missingPaths.length === 0) return [];
  const update = db.prepare<[number, string, string]>(
    `UPDATE library_media_files
     SET available = 0, updated_at = ?
     WHERE source = ? AND path = ? AND available = 1`,
  );
  const changed = db.transaction(() =>
    missingPaths.filter((filePath) => update.run(now(), mediaSource, filePath).changes > 0),
  )();
  if (changed.length > 0) invalidateLibraryCache();
  return changed;
}

// A file a scan cannot find is gone. Touching its song tells clients it changed.
export function removeMissingLibraryMediaFiles(source: string, paths: string[]) {
  const mediaSource = normalizeText(source);
  const missingPaths = [...new Set(paths)].map(normalizeText).filter(Boolean);
  if (!mediaSource || missingPaths.length === 0) return [];
  const remove = db.prepare<[string, string], Pick<LibraryMediaFilesRow, "track_id">>(
    "DELETE FROM library_media_files WHERE source = ? AND path = ? RETURNING track_id",
  );
  const touchTrack = db.prepare<[number, number]>(
    "UPDATE library_tracks SET updated_at = ? WHERE id = ?",
  );
  const removed = db.transaction(() =>
    missingPaths.filter((filePath) => {
      const rows = remove.all(mediaSource, filePath);
      for (const row of rows) touchTrack.run(now(), row.track_id);
      return rows.length > 0;
    }),
  )();
  if (removed.length > 0) invalidateLibraryCache();
  return removed;
}

export function removeLibraryMediaFiles(source: string, paths: string[]) {
  const mediaSource = normalizeText(source);
  const removedPaths = [...new Set(paths)].map(normalizeText).filter(Boolean);
  let removed = 0;
  for (const filePath of removedPaths) {
    const file = getLibraryMediaFileStmt.get(mediaSource, filePath);
    if (!file) continue;
    const otherFiles = db
      .prepare<[number, number], { count: number }>(
        "SELECT COUNT(*) AS count FROM library_media_files WHERE track_id = ? AND id != ?",
      )
      .get(file.track_id, file.id)!.count;
    if (otherFiles === 0) {
      db.prepare<[number]>("UPDATE library_media_files SET available = 0 WHERE id = ?").run(
        file.id,
      );
      removeLibraryTrackIfNoAvailableMedia(file.track_id);
    } else {
      db.prepare<[number]>("DELETE FROM library_media_files WHERE id = ?").run(file.id);
    }
    removed += 1;
  }
  if (removed > 0) invalidateLibraryCache();
  return removed;
}

export async function withLibraryScan<T extends LibraryScanCounts>(
  source: string,
  rootPath: string | null,
  run: (scanId: number) => Promise<T>,
) {
  const parentScan = libraryScanContext.getStore();
  const scan = { changed: false };
  return libraryScanContext.run(scan, async () => {
    libraryScanDepth += 1;
    let scanId: number | undefined;
    try {
      scanId = beginLibraryScan({ source, rootPath });
      const result = await run(scanId);
      finishLibraryScan(scanId, { ...result, status: "complete" });
      return { scanId, ...result, changed: scan.changed, status: "complete" };
    } catch (error) {
      const failure = asAppError(error);
      if (scanId) finishLibraryScan(scanId, { status: "failed", error: failure?.message });
      throw error;
    } finally {
      if (scan.changed && parentScan) parentScan.changed = true;
      libraryScanDepth -= 1;
      if (libraryScanDepth === 0 && libraryCacheInvalidationPending) {
        libraryCacheInvalidationPending = false;
        invalidateLibraryQueryCache();
      }
    }
  });
}

export function getLibraryMediaFile({ source, path }: { source: string; path: string }) {
  return getLibraryMediaFileStmt.get(normalizeText(source), normalizeText(path));
}

const AURRAL_REQUESTED_ALBUM = `
  json_valid(album.metadata_json) AND (
    json_extract(album.metadata_json, '$.trackListComplete') = 1
    OR json_extract(album.metadata_json, '$.monitored') = 1
  )
`;

// Lidarr owns an album with files in its root folders unless Aurral was
// asked for that album. This also returns albums that older scans claimed
// for Aurral because one of their tracks was an Aurral download.
export function assignLidarrAlbumOwners() {
  const timestamp = now();
  const changed = db
    .prepare<[number, number]>(
      `INSERT INTO library_management (entity_kind, entity_id, managed_by, monitor_mode, created_at, updated_at)
     SELECT 'album', album.id, 'lidarr', NULL, ?, ?
     FROM library_albums AS album
     WHERE EXISTS (
       SELECT 1 FROM library_media_files AS media
       WHERE media.album_id = album.id AND media.source = 'lidarr' AND media.available = 1
     )
     ON CONFLICT (entity_kind, entity_id) DO UPDATE SET
       managed_by = 'lidarr',
       monitor_mode = NULL,
       updated_at = excluded.updated_at
     WHERE library_management.managed_by = 'aurral'
       AND library_management.monitor_mode IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM library_albums AS album
         WHERE album.id = library_management.entity_id AND ${AURRAL_REQUESTED_ALBUM}
       )`,
    )
    .run(timestamp, timestamp).changes;
  if (changed > 0) {
    notifyLibraryManagementChanged();
    invalidateLibraryCache();
  }
  return changed;
}

const LIDARR_METADATA_PATHS = [...LIDARR_METADATA_KEYS, "monitorOption"]
  .map((key) => `'$.${key}'`)
  .join(", ");

// Turning Lidarr off removes everything its root folders added. Aurral's own
// files, the tracks Aurral asked for, and the songs an album's track list
// names stay. What Lidarr managed and still has Aurral files becomes
// Aurral's, unmonitored.
export function hasLidarrLibraryData() {
  return (
    db
      .prepare<[], { present: number }>(
        `SELECT EXISTS (SELECT 1 FROM library_media_files WHERE source = 'lidarr')
       OR EXISTS (SELECT 1 FROM library_management WHERE managed_by = 'lidarr')
       OR EXISTS (
         SELECT 1 FROM library_artists
         WHERE json_valid(metadata_json) AND json_extract(metadata_json, '$.librarySource') = 'lidarr'
       )
       OR EXISTS (
         SELECT 1 FROM library_albums
         WHERE json_valid(metadata_json) AND json_extract(metadata_json, '$.librarySource') = 'lidarr'
       ) AS present`,
      )
      .get()!.present === 1
  );
}

export function removeLidarrLibrary() {
  if (!hasLidarrLibraryData()) return false;
  const timestamp = now();
  db.transaction(() => {
    const trackIds = db
      .prepare<[], number>(
        "SELECT DISTINCT track_id FROM library_media_files WHERE source = 'lidarr'",
      )
      .pluck()
      .all();
    db.prepare<[]>("DELETE FROM library_media_files WHERE source = 'lidarr'").run();
    const hasMedia = db.prepare<[number], { 1: number }>(
      "SELECT 1 FROM library_media_files WHERE track_id = ? LIMIT 1",
    );
    const unlinkOutsideAurral = db.prepare<[number]>(
      `DELETE FROM library_album_tracks
       WHERE track_id = ? AND album_id NOT IN (
         SELECT entity_id FROM library_management
         WHERE entity_kind = 'album' AND managed_by = 'aurral'
       ) AND NOT EXISTS (
         SELECT 1 FROM library_media_files AS media
         WHERE media.track_id = library_album_tracks.track_id
           AND (media.album_id = library_album_tracks.album_id OR media.album_id IS NULL)
       ) AND NOT EXISTS (
         SELECT 1 FROM library_albums AS album, library_tracks AS track
         WHERE album.id = library_album_tracks.album_id AND track.id = library_album_tracks.track_id
           AND ${TRACK_IS_LISTED}
       )`,
    );
    const isLinked = db.prepare<[number], { 1: number }>(
      "SELECT 1 FROM library_album_tracks WHERE track_id = ? LIMIT 1",
    );
    const deleteTrack = db.prepare<[number]>("DELETE FROM library_tracks WHERE id = ?");
    for (const trackId of trackIds) {
      unlinkOutsideAurral.run(trackId);
      if (!hasMedia.get(trackId) && !isLinked.get(trackId)) deleteTrack.run(trackId);
    }
    db.prepare<[]>(
      `DELETE FROM library_albums
       WHERE NOT EXISTS (SELECT 1 FROM library_album_tracks WHERE album_id = library_albums.id)
         AND id NOT IN (
           SELECT entity_id FROM library_management
           WHERE entity_kind = 'album' AND managed_by = 'aurral'
         )`,
    ).run();
    db.prepare<[]>(
      `DELETE FROM library_artists
       WHERE NOT EXISTS (SELECT 1 FROM library_albums WHERE artist_id = library_artists.id)
         AND id NOT IN (
           SELECT entity_id FROM library_management
           WHERE entity_kind = 'artist' AND managed_by = 'aurral'
         )`,
    ).run();
    db.prepare<[]>(
      `DELETE FROM library_management
       WHERE (entity_kind = 'album' AND entity_id NOT IN (SELECT id FROM library_albums))
          OR (entity_kind = 'artist' AND entity_id NOT IN (SELECT id FROM library_artists))`,
    ).run();
    db.prepare<[number]>(
      `UPDATE library_management
       SET managed_by = 'aurral',
         monitor_mode = CASE entity_kind WHEN 'artist' THEN 'none' ELSE NULL END,
         updated_at = ?
       WHERE managed_by = 'lidarr'`,
    ).run(timestamp);
    for (const table of ["library_artists", "library_albums"]) {
      db.prepare<[number]>(
        `UPDATE ${table}
         SET metadata_json = json_remove(metadata_json, ${LIDARR_METADATA_PATHS}), updated_at = ?
         WHERE json_valid(metadata_json) AND json_extract(metadata_json, '$.librarySource') = 'lidarr'`,
      ).run(timestamp);
    }
    finishLibraryScan(beginLibraryScan({ source: "lidarr-removal" }));
  }).immediate();
  notifyLibraryManagementChanged();
  invalidateLibraryCache();
  return true;
}

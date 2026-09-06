import { db } from "../config/db-sqlite.js";
import { populateLibrarySearchDocuments } from "../config/library-search-index.js";

const indexAvailable = Boolean(
  db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get("library_search_fts"),
);

const normalize = (value) => String(value || "").trim().toLocaleLowerCase();

export function getLibrarySearchMatch(value) {
  const query = normalize(value);
  if (!indexAvailable || query.length < 3) return null;
  const trigrams = new Set();
  for (let index = 0; index <= query.length - 3; index += 1) {
    const trigram = query.slice(index, index + 3);
    if (!/\s/.test(trigram)) trigrams.add(`"${trigram.replaceAll('"', '""')}"`);
    if (trigrams.size >= 32) break;
  }
  return trigrams.size ? [...trigrams].join(" AND ") : null;
}

let upsertDocument;

function upsertSearchDocument(...values) {
  if (!indexAvailable) return false;
  upsertDocument ??= db.prepare(
    `INSERT INTO library_search_documents (entity_kind, entity_id, title, artist_name, album_name)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(entity_kind, entity_id) DO UPDATE SET
       title = excluded.title,
       artist_name = excluded.artist_name,
       album_name = excluded.album_name
     WHERE title IS NOT excluded.title
        OR artist_name IS NOT excluded.artist_name
        OR album_name IS NOT excluded.album_name`,
  );
  return upsertDocument.run(...values).changes > 0;
}

// Syncs the artist document only; returns whether it changed. Album and track
// documents carry the artist name too, so a change cascades (see
// syncLibrarySearchArtist, or the deferred batches in libraryMediaStore).
export function syncLibrarySearchArtistDocument(artistId) {
  if (!indexAvailable) return false;
  const artist = db.prepare(
    "SELECT id, name FROM library_artists WHERE id = ?",
  ).get(Number(artistId));
  if (!artist) return false;
  return upsertSearchDocument("artist", artist.id, artist.name, "", "");
}

export function libraryArtistAlbumIds(artistId) {
  return db.prepare("SELECT id FROM library_albums WHERE artist_id = ?")
    .all(Number(artistId)).map((row) => row.id);
}

export function libraryAlbumTrackIds(albumId) {
  return db.prepare("SELECT track_id FROM library_album_tracks WHERE album_id = ?")
    .all(Number(albumId)).map((row) => row.track_id);
}

export function syncLibrarySearchArtist(artistId) {
  if (!syncLibrarySearchArtistDocument(artistId)) return false;
  for (const albumId of libraryArtistAlbumIds(artistId)) {
    syncLibrarySearchAlbum(albumId);
    for (const trackId of libraryAlbumTrackIds(albumId)) syncLibrarySearchTrack(trackId);
  }
  return true;
}

export function syncLibrarySearchAlbum(albumId) {
  if (!indexAvailable) return false;
  const album = db.prepare(
    `SELECT album.id, album.title, album.album_artist, artist.name AS artist_name
     FROM library_albums AS album
     JOIN library_artists AS artist ON artist.id = album.artist_id
     WHERE album.id = ?`,
  ).get(Number(albumId));
  if (!album) return false;
  return upsertSearchDocument(
    "album",
    album.id,
    album.title,
    `${album.artist_name || ""} ${album.album_artist || ""}`.trim(),
    "",
  );
}

export function syncLibrarySearchTrack(trackId) {
  if (!indexAvailable) return false;
  const track = db.prepare(
    `SELECT
       track.id,
       track.title,
       trim(coalesce(track.artist_name, '') || ' ' || coalesce(group_concat(DISTINCT artist.name), '')) AS artist_name,
       trim(coalesce(group_concat(DISTINCT album.title), '') || ' ' || coalesce(group_concat(DISTINCT album.album_artist), '')) AS album_name
     FROM library_tracks AS track
     LEFT JOIN library_album_tracks AS album_track ON album_track.track_id = track.id
     LEFT JOIN library_albums AS album ON album.id = album_track.album_id
     LEFT JOIN library_artists AS artist ON artist.id = album.artist_id
     WHERE track.id = ?
     GROUP BY track.id`,
  ).get(Number(trackId));
  if (!track) return false;
  return upsertSearchDocument(
    "track",
    track.id,
    track.title,
    track.artist_name || "",
    track.album_name || "",
  );
}

export function removeLibrarySearchDocument(entityKind, entityId) {
  if (!indexAvailable) return false;
  return db.prepare(
    "DELETE FROM library_search_documents WHERE entity_kind = ? AND entity_id = ?",
  ).run(String(entityKind || ""), Number(entityId)).changes > 0;
}

// Repair pass for scans that ended abnormally: drops documents whose entity is
// gone and returns the ids of entities that have no document or whose document
// no longer matches the entity text (a rename committed by a scan that died
// before its deferred search sync ran), so the caller can sync them in batches
// instead of rebuilding the whole index. The expected text mirrors the sync
// functions above exactly, so a consistent index reports no gaps.
const EXPECTED_DOCUMENT_SQL = {
  artist: `SELECT entity.id,
      coalesce(entity.name, '') AS title,
      '' AS artist_name,
      '' AS album_name
    FROM library_artists AS entity`,
  album: `SELECT entity.id,
      coalesce(entity.title, '') AS title,
      trim(coalesce(artist.name, '') || ' ' || coalesce(entity.album_artist, '')) AS artist_name,
      '' AS album_name
    FROM library_albums AS entity
    JOIN library_artists AS artist ON artist.id = entity.artist_id`,
  track: `SELECT entity.id,
      coalesce(entity.title, '') AS title,
      trim(coalesce(entity.artist_name, '') || ' ' || coalesce(group_concat(DISTINCT artist.name), '')) AS artist_name,
      trim(coalesce(group_concat(DISTINCT album.title), '') || ' ' || coalesce(group_concat(DISTINCT album.album_artist), '')) AS album_name
    FROM library_tracks AS entity
    LEFT JOIN library_album_tracks AS album_track ON album_track.track_id = entity.id
    LEFT JOIN library_albums AS album ON album.id = album_track.album_id
    LEFT JOIN library_artists AS artist ON artist.id = album.artist_id
    GROUP BY entity.id`,
};

export function findLibrarySearchDocumentGaps() {
  const gaps = { artist: [], album: [], track: [] };
  if (!indexAvailable) return gaps;
  const tables = { artist: "library_artists", album: "library_albums", track: "library_tracks" };
  // The comparison is the slow part on a large library (seconds for tracks)
  // and it only reads, so it runs as a plain read that never holds the write
  // lock; the orphan delete is a short write of its own.
  for (const [kind, table] of Object.entries(tables)) {
    db.prepare(
      `DELETE FROM library_search_documents
       WHERE entity_kind = ?
         AND NOT EXISTS (SELECT 1 FROM ${table} AS entity WHERE entity.id = entity_id)`,
    ).run(kind);
    gaps[kind] = db.prepare(
      `SELECT expected.id
       FROM (${EXPECTED_DOCUMENT_SQL[kind]}) AS expected
       LEFT JOIN library_search_documents AS document
         ON document.entity_kind = ? AND document.entity_id = expected.id
       WHERE document.id IS NULL
          OR document.title IS NOT expected.title
          OR document.artist_name IS NOT expected.artist_name
          OR document.album_name IS NOT expected.album_name`,
    ).all(kind).map((row) => row.id);
  }
  return gaps;
}

export function rebuildLibrarySearchIndex() {
  if (!indexAvailable) return false;
  db.transaction(() => {
    db.prepare("DELETE FROM library_search_documents").run();
    populateLibrarySearchDocuments(db);
    db.prepare("INSERT INTO library_search_fts(library_search_fts) VALUES ('rebuild')").run();
  })();
  return true;
}

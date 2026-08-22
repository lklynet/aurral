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

export function syncLibrarySearchArtist(artistId) {
  if (!indexAvailable) return false;
  const artist = db.prepare(
    "SELECT id, name FROM library_artists WHERE id = ?",
  ).get(Number(artistId));
  if (!artist) return false;
  const changed = upsertSearchDocument("artist", artist.id, artist.name, "", "");
  if (!changed) return false;
  for (const album of db.prepare(
    "SELECT id FROM library_albums WHERE artist_id = ?",
  ).all(artist.id)) {
    syncLibrarySearchAlbum(album.id);
    for (const track of db.prepare(
      "SELECT track_id FROM library_album_tracks WHERE album_id = ?",
    ).all(album.id)) {
      syncLibrarySearchTrack(track.track_id);
    }
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

export function rebuildLibrarySearchIndex() {
  if (!indexAvailable) return false;
  db.transaction(() => {
    db.prepare("DELETE FROM library_search_documents").run();
    populateLibrarySearchDocuments(db);
    db.prepare("INSERT INTO library_search_fts(library_search_fts) VALUES ('rebuild')").run();
  })();
  return true;
}

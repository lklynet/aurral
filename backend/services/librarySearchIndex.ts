import type { Statement } from "better-sqlite3";
import { db } from "../config/db-sqlite.ts";
import { populateLibrarySearchDocuments } from "../config/library-search-index.ts";
import { parseSearchQuery, searchDocument, searchKey } from "./searchText.ts";
import type {
  LibraryAlbumsRow,
  LibraryAlbumTracksRow,
  LibraryArtistsRow,
  LibraryTracksRow,
} from "../db/rows.ts";

const indexAvailable = Boolean(
  db
    .prepare<[string], { name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    )
    .get("library_search_fts"),
);

export function parseLibrarySearch(value: unknown) {
  const query = parseSearchQuery(value);
  if (!query) return null;
  const trigrams = new Set<string>();
  for (const term of query.terms) {
    for (let index = 0; index <= term.length - 3 && trigrams.size < 32; index += 1) {
      trigrams.add(`"${term.slice(index, index + 3).replaceAll('"', '""')}"`);
    }
  }
  return {
    ...query,
    indexed: indexAvailable,
    match: indexAvailable && trigrams.size ? [...trigrams].join(" AND ") : null,
  };
}

export type LibrarySearch = NonNullable<ReturnType<typeof parseLibrarySearch>>;

type SearchDocumentRow = [string, number, string, string, string, string, string];
let upsertDocument: Statement<SearchDocumentRow> | undefined;

function upsertSearchDocument(
  kind: string,
  id: number,
  title: string,
  artistName: string,
  albumName: string,
  ...documentFields: unknown[]
) {
  if (!indexAvailable) return false;
  upsertDocument ??= db.prepare<SearchDocumentRow>(
    `INSERT INTO library_search_documents
       (entity_kind, entity_id, title, artist_name, album_name, title_key, search_text)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(entity_kind, entity_id) DO UPDATE SET
       title = excluded.title,
       artist_name = excluded.artist_name,
       album_name = excluded.album_name,
       title_key = excluded.title_key,
       search_text = excluded.search_text
     WHERE title IS NOT excluded.title
        OR artist_name IS NOT excluded.artist_name
        OR album_name IS NOT excluded.album_name
        OR search_text IS NOT excluded.search_text`,
  );
  return (
    upsertDocument.run(
      kind,
      id,
      title,
      artistName,
      albumName,
      searchKey(title),
      searchDocument(title, ...documentFields),
    ).changes > 0
  );
}

export function syncLibrarySearchArtist(artistId: unknown) {
  if (!indexAvailable) return false;
  const artist = db
    .prepare<[number], Pick<LibraryArtistsRow, "id" | "name">>(
      "SELECT id, name FROM library_artists WHERE id = ?",
    )
    .get(Number(artistId));
  if (!artist) return false;
  const changed = upsertSearchDocument("artist", artist.id, artist.name, "", "");
  if (!changed) return false;
  for (const album of db
    .prepare<[number], Pick<LibraryAlbumsRow, "id">>(
      "SELECT id FROM library_albums WHERE artist_id = ?",
    )
    .all(artist.id)) {
    syncLibrarySearchAlbum(album.id);
    for (const track of db
      .prepare<[number], Pick<LibraryAlbumTracksRow, "track_id">>(
        "SELECT track_id FROM library_album_tracks WHERE album_id = ?",
      )
      .all(album.id)) {
      syncLibrarySearchTrack(track.track_id);
    }
  }
  return true;
}

export function syncLibrarySearchAlbum(albumId: unknown) {
  if (!indexAvailable) return false;
  const album = db
    .prepare<
      [number],
      Pick<LibraryAlbumsRow, "id" | "title" | "album_artist"> & { artist_name: string }
    >(
      `SELECT album.id, album.title, album.album_artist, artist.name AS artist_name
     FROM library_albums AS album
     JOIN library_artists AS artist ON artist.id = album.artist_id
     WHERE album.id = ?`,
    )
    .get(Number(albumId));
  if (!album) return false;
  return upsertSearchDocument(
    "album",
    album.id,
    album.title,
    `${album.artist_name || ""} ${album.album_artist || ""}`.trim(),
    "",
    album.artist_name,
    album.album_artist,
  );
}

export function syncLibrarySearchTrack(trackId: unknown) {
  if (!indexAvailable) return false;
  const track = db
    .prepare<
      [number],
      Pick<LibraryTracksRow, "id" | "title"> & {
        artist_name: string;
        album_name: string;
        document_fields: string | null;
      }
    >(
      `SELECT
       track.id,
       track.title,
       trim(coalesce(track.artist_name, '') || ' ' || coalesce(group_concat(DISTINCT artist.name), '')) AS artist_name,
       trim(coalesce(group_concat(DISTINCT album.title), '') || ' ' || coalesce(group_concat(DISTINCT album.album_artist), '')) AS album_name,
       coalesce(track.artist_name, '') || char(31) ||
         coalesce(group_concat(DISTINCT artist.name || char(31)), '') ||
         coalesce(group_concat(DISTINCT album.title || char(31)), '') ||
         coalesce(group_concat(DISTINCT album.album_artist || char(31)), '') AS document_fields
     FROM library_tracks AS track
     LEFT JOIN library_album_tracks AS album_track ON album_track.track_id = track.id
     LEFT JOIN library_albums AS album ON album.id = album_track.album_id
     LEFT JOIN library_artists AS artist ON artist.id = album.artist_id
     WHERE track.id = ?
     GROUP BY track.id`,
    )
    .get(Number(trackId));
  if (!track) return false;
  return upsertSearchDocument(
    "track",
    track.id,
    track.title,
    track.artist_name || "",
    track.album_name || "",
    track.document_fields,
  );
}

export function removeLibrarySearchDocument(entityKind: unknown, entityId: unknown) {
  if (!indexAvailable) return false;
  return (
    db
      .prepare<[string, number]>(
        "DELETE FROM library_search_documents WHERE entity_kind = ? AND entity_id = ?",
      )
      .run(String(entityKind || ""), Number(entityId)).changes > 0
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

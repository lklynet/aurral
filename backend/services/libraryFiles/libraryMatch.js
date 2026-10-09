import { db } from "../../config/db-sqlite.js";
import {
  buildFallbackIdentityKey,
  findLibraryAlbumByArtistTitle,
  findLibraryAlbumByReleaseMbid,
  isSameLibraryName,
} from "../libraryMediaStore.js";

function findArtist(record) {
  if (record.artistMbid) {
    const byMbid = db.prepare("SELECT * FROM library_artists WHERE mbid = ? ORDER BY id LIMIT 1").get(record.artistMbid);
    if (byMbid) return byMbid;
  }
  const byKey = db.prepare("SELECT * FROM library_artists WHERE identity_key = ?")
    .get(buildFallbackIdentityKey("artist", record.artistName));
  if (byKey && isSameLibraryName(byKey.name, record.artistName)) return byKey;
  const named = db.prepare("SELECT * FROM library_artists WHERE name = ? COLLATE NOCASE ORDER BY id LIMIT 2")
    .all(record.artistName);
  return named.length === 1 ? named[0] : null;
}

function findAlbum(record, artist) {
  if (record.releaseGroupMbid) {
    const byReleaseGroup = db.prepare(
      "SELECT * FROM library_albums WHERE release_group_mbid = ? OR identity_key = ? ORDER BY id LIMIT 1",
    ).get(record.releaseGroupMbid, `release-group:${record.releaseGroupMbid}`)
      || findLibraryAlbumByReleaseMbid(record.releaseGroupMbid);
    if (byReleaseGroup) return byReleaseGroup;
  }
  if (record.albumMbid) {
    const byRelease = findLibraryAlbumByReleaseMbid(record.albumMbid)
      || db.prepare("SELECT * FROM library_albums WHERE mbid = ? OR identity_key = ? ORDER BY id LIMIT 1")
        .get(record.albumMbid, `album:${record.albumMbid}`);
    if (byRelease) return byRelease;
  }
  if (record.releaseGroupMbid || record.albumMbid || !artist) return null;
  return findLibraryAlbumByArtistTitle(artist.id, record.albumName);
}

function findTrack(record, album) {
  const tracks = db.prepare(
    `SELECT track.*, link.disc_number, link.track_number
     FROM library_album_tracks AS link
     JOIN library_tracks AS track ON track.id = link.track_id
     WHERE link.album_id = ?`,
  ).all(album.id);
  const byIdentity = tracks.find((track) =>
    (record.trackMbid && track.mbid === record.trackMbid) || track.identity_key === record.trackKey);
  if (byIdentity) return byIdentity;
  const named = tracks.filter((track) =>
    isSameLibraryName(track.title, record.title)
    && (!record.trackNumber || !track.track_number || track.track_number === record.trackNumber)
    && (!record.discNumber || !track.disc_number || track.disc_number === record.discNumber));
  return named.length === 1 ? named[0] : null;
}

// Where a tagged file belongs in the Library: the artist and album Aurral
// already has, matched by MusicBrainz IDs first and names second.
export function matchLibraryRecord(record) {
  const artistByRecord = findArtist(record);
  const album = findAlbum(record, artistByRecord);
  const artist = album
    ? db.prepare("SELECT * FROM library_artists WHERE id = ?").get(album.artist_id)
    : artistByRecord;
  const track = album ? findTrack(record, album) : null;
  const files = track
    ? db.prepare(
      `SELECT path FROM library_media_files
       WHERE track_id = ? AND source = 'aurral' AND available = 1
       ORDER BY id`,
    ).all(track.id).map((file) => file.path)
    : [];
  return {
    artistName: artist?.name || record.artistName,
    artistMbid: artist?.mbid || record.artistMbid || null,
    albumName: album?.title || record.albumName,
    album: album || null,
    track: track || null,
    files,
  };
}

// The Library's own track for the file at this path, when its artist, album,
// title, disc, and track number agree with the record. Different names can
// share one folder name, so the path alone does not prove it is the same track.
export function findLibraryTrackAtPath(filePath, record) {
  const track = db.prepare(
    `SELECT track.title, track.mbid, link.disc_number, link.track_number,
       album.title AS album_title, artist.name AS artist_name
     FROM library_media_files AS media
     JOIN library_tracks AS track ON track.id = media.track_id
     LEFT JOIN library_album_tracks AS link ON link.track_id = media.track_id AND link.album_id = media.album_id
     LEFT JOIN library_albums AS album ON album.id = media.album_id
     LEFT JOIN library_artists AS artist ON artist.id = album.artist_id
     WHERE media.source = 'aurral' AND media.path = ? AND media.available = 1
     LIMIT 1`,
  ).get(filePath);
  const same = track
    && isSameLibraryName(track.artist_name, record.artistName)
    && isSameLibraryName(track.album_title, record.albumName)
    && isSameLibraryName(track.title, record.title)
    && (track.track_number || 0) === (record.trackNumber || 0)
    && (track.disc_number || 1) === (record.discNumber || 1)
    && !(track.mbid && record.trackMbid && track.mbid !== record.trackMbid);
  return same ? track : null;
}

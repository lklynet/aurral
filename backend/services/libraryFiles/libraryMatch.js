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

import { db } from "../../config/db-sqlite.js";

const getArtistOverrideStmt = db.prepare("SELECT * FROM artist_overrides WHERE mbid = ?");
const upsertArtistOverrideStmt = db.prepare(
  "INSERT OR REPLACE INTO artist_overrides (mbid, musicbrainz_id, deezer_artist_id, updated_at) VALUES (?, ?, ?, ?)",
);
const deleteArtistOverrideStmt = db.prepare("DELETE FROM artist_overrides WHERE mbid = ?");

export default function register(dbOps) {
  dbOps.getArtistOverride = function (mbid) {
    if (!mbid) return null;
    const row = getArtistOverrideStmt.get(mbid);
    if (!row) return null;
    return {
      mbid: row.mbid,
      musicbrainzId: row.musicbrainz_id || null,
      deezerArtistId: row.deezer_artist_id || null,
      updatedAt: row.updated_at || null,
    };
  };

  dbOps.setArtistOverride = function (mbid, { musicbrainzId = null, deezerArtistId = null } = {}) {
    if (!mbid) return null;
    const now = Date.now();
    upsertArtistOverrideStmt.run(mbid, musicbrainzId || null, deezerArtistId || null, now);
    return {
      mbid,
      musicbrainzId: musicbrainzId || null,
      deezerArtistId: deezerArtistId || null,
      updatedAt: now,
    };
  };

  dbOps.deleteArtistOverride = function (mbid) {
    if (!mbid) return null;
    return deleteArtistOverrideStmt.run(mbid);
  };
}

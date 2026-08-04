import { db } from "../../config/db-sqlite.js";

const getLidarrArtistIdMapStmt = db.prepare(
  "SELECT lidarr_foreign_artist_id FROM lidarr_artist_id_map WHERE musicbrainz_id = ?",
);
const getLidarrArtistMbidStmt = db.prepare(
  "SELECT musicbrainz_id FROM lidarr_artist_id_map WHERE lidarr_foreign_artist_id = ?",
);
const setLidarrArtistIdMapStmt = db.prepare(
  "INSERT OR REPLACE INTO lidarr_artist_id_map (musicbrainz_id, lidarr_foreign_artist_id, updated_at) VALUES (?, ?, ?)",
);
const deleteLidarrArtistIdMapStmt = db.prepare(
  "DELETE FROM lidarr_artist_id_map WHERE musicbrainz_id = ?",
);

export default function register(dbOps) {
  dbOps.getLidarrArtistIdMap = function (musicbrainzId) {
    if (!musicbrainzId) return null;
    return getLidarrArtistIdMapStmt.get(musicbrainzId)?.lidarr_foreign_artist_id || null;
  };

  dbOps.getLidarrArtistMbid = function (lidarrForeignArtistId) {
    if (!lidarrForeignArtistId) return null;
    return getLidarrArtistMbidStmt.get(lidarrForeignArtistId)?.musicbrainz_id || null;
  };

  dbOps.setLidarrArtistIdMap = function (musicbrainzId, lidarrForeignArtistId) {
    if (!musicbrainzId || !lidarrForeignArtistId) return null;
    const updatedAt = Date.now();
    setLidarrArtistIdMapStmt.run(musicbrainzId, lidarrForeignArtistId, updatedAt);
    return { musicbrainzId, lidarrForeignArtistId, updatedAt };
  };

  dbOps.deleteLidarrArtistIdMap = function (musicbrainzId) {
    if (!musicbrainzId) return null;
    return deleteLidarrArtistIdMapStmt.run(musicbrainzId);
  };
}

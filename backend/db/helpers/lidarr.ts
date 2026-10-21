import type Database from "better-sqlite3";
import { db } from "../../config/db-sqlite.ts";
import type { LidarrArtistIdMapRow } from "../rows.ts";

interface CodedError extends Error {
  code?: string;
}

export interface LidarrArtistIdMapping {
  musicbrainzId: string;
  lidarrForeignArtistId: string;
  updatedAt: number;
}

export interface LidarrArtistIdMapOps {
  getLidarrArtistIdMap: (musicbrainzId: string) => string | null;
  getLidarrArtistMbid: (lidarrForeignArtistId: string) => string | null;
  setLidarrArtistIdMap: (
    musicbrainzId: string,
    lidarrForeignArtistId: string,
  ) => LidarrArtistIdMapping | null;
  deleteLidarrArtistIdMap: (musicbrainzId: string) => Database.RunResult | null;
}

const getLidarrArtistIdMapStmt = db.prepare<
  [string],
  Pick<LidarrArtistIdMapRow, "lidarr_foreign_artist_id">
>("SELECT lidarr_foreign_artist_id FROM lidarr_artist_id_map WHERE musicbrainz_id = ?");
const getLidarrArtistMbidStmt = db.prepare<[string], Pick<LidarrArtistIdMapRow, "musicbrainz_id">>(
  "SELECT musicbrainz_id FROM lidarr_artist_id_map WHERE lidarr_foreign_artist_id = ?",
);
const setLidarrArtistIdMapStmt = db.prepare<[string, string, number]>(
  `INSERT INTO lidarr_artist_id_map (musicbrainz_id, lidarr_foreign_artist_id, updated_at)
   VALUES (?, ?, ?)
   ON CONFLICT(musicbrainz_id) DO UPDATE SET
     lidarr_foreign_artist_id = excluded.lidarr_foreign_artist_id,
     updated_at = excluded.updated_at`,
);
const deleteLidarrArtistIdMapStmt = db.prepare<[string]>(
  "DELETE FROM lidarr_artist_id_map WHERE musicbrainz_id = ?",
);

export default function register(dbOps: LidarrArtistIdMapOps) {
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
    const existingMbid = getLidarrArtistMbidStmt.get(lidarrForeignArtistId)?.musicbrainz_id;
    if (existingMbid && existingMbid !== musicbrainzId) {
      const error: CodedError = new Error(
        `Lidarr artist ID "${lidarrForeignArtistId}" is already mapped to another MusicBrainz artist`,
      );
      error.code = "LIDARR_ARTIST_ID_CONFLICT";
      throw error;
    }
    const updatedAt = Date.now();
    try {
      setLidarrArtistIdMapStmt.run(musicbrainzId, lidarrForeignArtistId, updatedAt);
    } catch (error) {
      if (String(error?.message || "").includes("lidarr_artist_id_map.lidarr_foreign_artist_id")) {
        error.code = "LIDARR_ARTIST_ID_CONFLICT";
      }
      throw error;
    }
    return { musicbrainzId, lidarrForeignArtistId, updatedAt };
  };

  dbOps.deleteLidarrArtistIdMap = function (musicbrainzId) {
    if (!musicbrainzId) return null;
    return deleteLidarrArtistIdMapStmt.run(musicbrainzId);
  };
}

import type Database from "better-sqlite3";
import { db } from "../../config/db-sqlite.ts";
import type { ArtistOverridesRow } from "../rows.ts";

export interface ArtistOverride {
  mbid: string;
  musicbrainzId: string | null;
  deezerArtistId: string | null;
  updatedAt: number | null;
}

export interface ArtistOverrideOps {
  getArtistOverride: (mbid: string) => ArtistOverride | null;
  setArtistOverride: (
    mbid: string,
    overrides?: { musicbrainzId?: string | null; deezerArtistId?: string | null },
  ) => {
    mbid: string;
    musicbrainzId: string | null;
    deezerArtistId: string | null;
    updatedAt: number;
  } | null;
  deleteArtistOverride: (mbid: string) => Database.RunResult | null;
}

const getArtistOverrideStmt = db.prepare<[string], ArtistOverridesRow>(
  "SELECT * FROM artist_overrides WHERE mbid = ?",
);
const upsertArtistOverrideStmt = db.prepare<[string, string | null, string | null, number]>(
  "INSERT OR REPLACE INTO artist_overrides (mbid, musicbrainz_id, deezer_artist_id, updated_at) VALUES (?, ?, ?, ?)",
);
const deleteArtistOverrideStmt = db.prepare<[string]>(
  "DELETE FROM artist_overrides WHERE mbid = ?",
);

export default function register(dbOps: ArtistOverrideOps) {
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

import { db } from "../../config/db-sqlite.js";

const getImageStmt = db.prepare("SELECT * FROM images_cache WHERE mbid = ?");
const getImageJsonStmt = db.prepare("SELECT images_json FROM images_cache WHERE mbid = ?");
const upsertImageStmt = db.prepare(
  "INSERT OR REPLACE INTO images_cache (mbid, image_url, images_json, cache_age, created_at) VALUES (?, ?, ?, ?, ?)"
);
const countImagesStmt = db.prepare("SELECT COUNT(*) as count FROM images_cache");
const deleteImageStmt = db.prepare("DELETE FROM images_cache WHERE mbid = ?");
const clearImagesStmt = db.prepare("DELETE FROM images_cache");
const cleanOldImagesStmt = db.prepare(
  "DELETE FROM images_cache WHERE cache_age < ?"
);

const NOT_FOUND_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const getImagesStmtsByCount = new Map();

const parseImages = (value) => {
  if (!value) return null;
  try {
    const images = JSON.parse(value);
    return Array.isArray(images) ? images : null;
  } catch {
    return null;
  }
};

const serializeImages = (images) => (Array.isArray(images) ? JSON.stringify(images) : null);

const getDeezerMbidCacheStmt = db.prepare(
  "SELECT mbid FROM deezer_mbid_cache WHERE cache_key = ?"
);
const setDeezerMbidCacheStmt = db.prepare(
  "INSERT OR REPLACE INTO deezer_mbid_cache (cache_key, mbid) VALUES (?, ?)"
);
const getMusicbrainzArtistMbidCacheStmt = db.prepare(
  "SELECT mbid, updated_at FROM musicbrainz_artist_mbid_cache WHERE artist_name_key = ?"
);
const setMusicbrainzArtistMbidCacheStmt = db.prepare(
  "INSERT OR REPLACE INTO musicbrainz_artist_mbid_cache (artist_name_key, mbid, updated_at) VALUES (?, ?, ?)"
);
const cleanOldMusicbrainzArtistMbidCacheStmt = db.prepare(
  "DELETE FROM musicbrainz_artist_mbid_cache WHERE updated_at < ?"
);

export default function register(dbOps) {
  dbOps.getImage = function (mbid) {
    const row = getImageStmt.get(mbid);
    if (!row) return null;
    if (
      row.image_url === "NOT_FOUND" &&
      Date.now() - row.cache_age > NOT_FOUND_TTL_MS
    ) {
      deleteImageStmt.run(mbid);
      return null;
    }
    return {
      mbid: row.mbid,
      imageUrl: row.image_url,
      images: parseImages(row.images_json),
      cacheAge: row.cache_age,
    };
  };

  dbOps.getImages = function (mbids) {
    if (!mbids || !mbids.length) return {};
    let stmt = getImagesStmtsByCount.get(mbids.length);
    if (!stmt) {
      const placeholders = mbids.map(() => "?").join(",");
      stmt = db.prepare(
        `SELECT mbid, image_url, images_json, cache_age FROM images_cache WHERE mbid IN (${placeholders})`
      );
      getImagesStmtsByCount.set(mbids.length, stmt);
    }
    const rows = stmt.all(...mbids);
    const now = Date.now();
    const result = {};
    for (const row of rows) {
      if (
        row.image_url === "NOT_FOUND" &&
        now - row.cache_age > NOT_FOUND_TTL_MS
      ) {
        deleteImageStmt.run(row.mbid);
        continue;
      }
      result[row.mbid] = {
        imageUrl: row.image_url,
        images: parseImages(row.images_json),
        cacheAge: row.cache_age,
      };
    }
    return result;
  };

  dbOps.setImage = function (mbid, imageUrl, images) {
    const imagesJson =
      imageUrl === "NOT_FOUND"
        ? null
        : images === undefined
          ? getImageJsonStmt.get(mbid)?.images_json || null
          : serializeImages(images);
    upsertImageStmt.run(mbid, imageUrl, imagesJson, Date.now(), new Date().toISOString());
  };

  dbOps.countImages = function () {
    const row = countImagesStmt.get();
    return Number(row?.count || 0);
  };

  dbOps.deleteImage = function (mbid) {
    return deleteImageStmt.run(mbid);
  };

  dbOps.clearImages = function () {
    return clearImagesStmt.run();
  };

  dbOps.cleanOldImageCache = function (maxAgeDays = 30) {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    return cleanOldImagesStmt.run(cutoff);
  };

  dbOps.getDeezerMbidCache = function (cacheKey) {
    const row = getDeezerMbidCacheStmt.get(cacheKey);
    return row?.mbid ?? null;
  };

  dbOps.setDeezerMbidCache = function (cacheKey, mbid) {
    setDeezerMbidCacheStmt.run(cacheKey, mbid);
  };

  dbOps.getMusicbrainzArtistMbidCache = function (artistNameKey) {
    if (!artistNameKey) return null;
    const row = getMusicbrainzArtistMbidCacheStmt.get(artistNameKey);
    if (!row) return null;
    return {
      mbid: row.mbid || null,
      updatedAt: Number(row.updated_at || 0),
    };
  };

  dbOps.setMusicbrainzArtistMbidCache = function (artistNameKey, mbid) {
    if (!artistNameKey) return null;
    const updatedAt = Date.now();
    setMusicbrainzArtistMbidCacheStmt.run(artistNameKey, mbid || null, updatedAt);
    return {
      artistNameKey,
      mbid: mbid || null,
      updatedAt,
    };
  };

  dbOps.cleanOldMusicbrainzArtistMbidCache = function (maxAgeDays = 90) {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    return cleanOldMusicbrainzArtistMbidCacheStmt.run(cutoff);
  };
}

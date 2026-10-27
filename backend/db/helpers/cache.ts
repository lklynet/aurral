import type Database from "better-sqlite3";
import { gunzip, gzip } from "node:zlib";
import { promisify } from "node:util";
import { db } from "../../config/db-sqlite.ts";
import type {
  DeezerMbidCacheRow,
  ImagesCacheRow,
  MetadataResponseCacheRow,
  MusicbrainzArtistMbidCacheRow,
} from "../rows.ts";

export interface CachedArtistImage {
  image: string | null;
  front: boolean;
  types: string[];
}

export interface CachedImage {
  mbid: string;
  imageUrl: string | null;
  images: CachedArtistImage[] | null;
  cacheAge: number | null;
}

interface MetadataResponseEntry {
  value: unknown;
  freshUntil: number;
  staleUntil: number;
}

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export interface CacheOps {
  getImage: (mbid: string) => CachedImage | null;
  getImages: (mbids: string[]) => Record<string, Omit<CachedImage, "mbid">>;
  setImage: (mbid: string, imageUrl: string | null, images?: CachedArtistImage[] | null) => void;
  countImages: () => number;
  deleteImage: (mbid: string) => Database.RunResult;
  clearImages: () => Database.RunResult;
  cleanOldImageCache: (maxAgeDays?: number) => Database.RunResult;
  getDeezerMbidCache: (cacheKey: string) => string | null;
  setDeezerMbidCache: (cacheKey: string, mbid: string) => void;
  getMusicbrainzArtistMbidCache: (
    artistNameKey: string,
  ) => { mbid: string | null; updatedAt: number } | null;
  setMusicbrainzArtistMbidCache: (
    artistNameKey: string,
    mbid?: string | null,
  ) => { artistNameKey: string; mbid: string | null; updatedAt: number } | null;
  cleanOldMusicbrainzArtistMbidCache: (maxAgeDays?: number) => Database.RunResult;
  getMetadataResponseAsync: (cacheKey: string) => Promise<MetadataResponseEntry | null>;
  setMetadataResponseAsync: (cacheKey: string, entry: MetadataResponseEntry) => Promise<void>;
  deleteMetadataResponse: (cacheKey: string) => Database.RunResult;
  clearMetadataResponses: () => Database.RunResult;
  cleanMetadataResponses: (maxEntries: number) => number;
}

type CachedImageRow = Omit<ImagesCacheRow, "mbid"> & { mbid: string };
type ImageSummaryRow = Pick<CachedImageRow, "mbid" | "image_url" | "images_json" | "cache_age">;

const getImageStmt = db.prepare<[string], CachedImageRow>(
  "SELECT * FROM images_cache WHERE mbid = ?",
);
const getImageJsonStmt = db.prepare<[string], Pick<ImagesCacheRow, "images_json">>(
  "SELECT images_json FROM images_cache WHERE mbid = ?",
);
const upsertImageStmt = db.prepare<[string, string | null, string | null, number, string]>(
  "INSERT OR REPLACE INTO images_cache (mbid, image_url, images_json, cache_age, created_at) VALUES (?, ?, ?, ?, ?)",
);
const countImagesStmt = db.prepare<[], { count: number }>(
  "SELECT COUNT(*) as count FROM images_cache",
);
const deleteImageStmt = db.prepare<[string]>("DELETE FROM images_cache WHERE mbid = ?");
const clearImagesStmt = db.prepare<[]>("DELETE FROM images_cache");
const cleanOldImagesStmt = db.prepare<[number]>("DELETE FROM images_cache WHERE cache_age < ?");

const NOT_FOUND_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const getImagesStmtsByCount = new Map<number, Database.Statement<string[], ImageSummaryRow>>();

const parseImages = (value: string | null): CachedArtistImage[] | null => {
  if (!value) return null;
  try {
    const images = JSON.parse(value);
    return Array.isArray(images) ? images : null;
  } catch {
    return null;
  }
};

const serializeImages = (images: CachedArtistImage[] | null) =>
  Array.isArray(images) ? JSON.stringify(images) : null;

const getDeezerMbidCacheStmt = db.prepare<[string], Pick<DeezerMbidCacheRow, "mbid">>(
  "SELECT mbid FROM deezer_mbid_cache WHERE cache_key = ?",
);
const setDeezerMbidCacheStmt = db.prepare<[string, string]>(
  "INSERT OR REPLACE INTO deezer_mbid_cache (cache_key, mbid) VALUES (?, ?)",
);
const getMusicbrainzArtistMbidCacheStmt = db.prepare<
  [string],
  Pick<MusicbrainzArtistMbidCacheRow, "mbid" | "updated_at">
>("SELECT mbid, updated_at FROM musicbrainz_artist_mbid_cache WHERE artist_name_key = ?");
const setMusicbrainzArtistMbidCacheStmt = db.prepare<[string, string | null, number]>(
  "INSERT OR REPLACE INTO musicbrainz_artist_mbid_cache (artist_name_key, mbid, updated_at) VALUES (?, ?, ?)",
);
const cleanOldMusicbrainzArtistMbidCacheStmt = db.prepare<[number]>(
  "DELETE FROM musicbrainz_artist_mbid_cache WHERE updated_at < ?",
);

const getMetadataResponseStmt = db.prepare<
  [string],
  Pick<MetadataResponseCacheRow, "response" | "fresh_until" | "stale_until">
>("SELECT response, fresh_until, stale_until FROM metadata_response_cache WHERE cache_key = ?");
const setMetadataResponseStmt = db.prepare<[string, Buffer, number, number]>(
  "INSERT OR REPLACE INTO metadata_response_cache (cache_key, response, fresh_until, stale_until) VALUES (?, ?, ?, ?)",
);
const deleteMetadataResponseStmt = db.prepare<[string]>(
  "DELETE FROM metadata_response_cache WHERE cache_key = ?",
);
const clearMetadataResponsesStmt = db.prepare<[]>("DELETE FROM metadata_response_cache");
const cleanExpiredMetadataResponsesStmt = db.prepare<[number]>(
  "DELETE FROM metadata_response_cache WHERE stale_until < ?",
);
const trimMetadataResponsesStmt = db.prepare<[number]>(
  `DELETE FROM metadata_response_cache WHERE cache_key IN (
    SELECT cache_key FROM metadata_response_cache ORDER BY stale_until DESC LIMIT -1 OFFSET ?
  )`,
);

export default function register(dbOps: CacheOps) {
  dbOps.getImage = function (mbid) {
    const row = getImageStmt.get(mbid);
    if (!row) return null;
    if (row.image_url === "NOT_FOUND" && Date.now() - (row.cache_age ?? 0) > NOT_FOUND_TTL_MS) {
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
      stmt = db.prepare<string[], ImageSummaryRow>(
        `SELECT mbid, image_url, images_json, cache_age FROM images_cache WHERE mbid IN (${placeholders})`,
      );
      getImagesStmtsByCount.set(mbids.length, stmt);
    }
    const rows = stmt.all(...mbids);
    const now = Date.now();
    const result: Record<string, Omit<CachedImage, "mbid">> = {};
    for (const row of rows) {
      if (row.image_url === "NOT_FOUND" && now - (row.cache_age ?? 0) > NOT_FOUND_TTL_MS) {
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

  dbOps.getMetadataResponseAsync = async function (cacheKey) {
    const row = getMetadataResponseStmt.get(cacheKey);
    if (!row) return null;
    if (row.stale_until < Date.now()) {
      deleteMetadataResponseStmt.run(cacheKey);
      return null;
    }
    try {
      return {
        value: JSON.parse((await gunzipAsync(row.response)).toString("utf8")),
        freshUntil: row.fresh_until,
        staleUntil: row.stale_until,
      };
    } catch {
      deleteMetadataResponseStmt.run(cacheKey);
      return null;
    }
  };

  dbOps.setMetadataResponseAsync = async function (cacheKey, { value, freshUntil, staleUntil }) {
    const compressed = await gzipAsync(JSON.stringify(value));
    setMetadataResponseStmt.run(cacheKey, compressed, freshUntil, staleUntil);
  };

  dbOps.deleteMetadataResponse = function (cacheKey) {
    return deleteMetadataResponseStmt.run(cacheKey);
  };

  dbOps.clearMetadataResponses = function () {
    return clearMetadataResponsesStmt.run();
  };

  dbOps.cleanMetadataResponses = function (maxEntries) {
    const expired = cleanExpiredMetadataResponsesStmt.run(Date.now()).changes;
    const trimmed = trimMetadataResponsesStmt.run(maxEntries).changes;
    return expired + trimmed;
  };
}

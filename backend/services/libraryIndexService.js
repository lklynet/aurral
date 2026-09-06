import path from "node:path";
import { db } from "../config/db-sqlite.js";
import { resolvePlaylistRoot } from "./playlistPaths.js";
import { scanMusicRoot } from "./libraryFileScanner.js";
import {
  beginLibraryScan,
  failInterruptedLibraryScans,
  finishLibraryScan,
  repairLibrarySearchDocuments,
  upsertLibraryArtist,
} from "./libraryMediaStore.js";
import { indexLidarrLibrary } from "./libraryLidarrIndexer.js";
import { logger } from "./logger.js";
import { dbOps } from "../db/helpers/index.js";

// Set when interrupted runs were closed on the main thread, so the next scan
// worker knows a document repair is owed even though the runs are closed.
const SEARCH_REPAIR_PENDING_KEY = "librarySearchRepairPending";
import { musicbrainzGetArtistNameByMbid } from "./apiClients/index.js";

function getAurralJobMetadataByPath() {
  const rows = db
    .prepare(
      `SELECT final_path, artist_name, album_name, track_name,
        artist_mbid, album_mbid, track_mbid, release_year, track_number
       FROM playlist_download_jobs
       WHERE status = 'done' AND final_path IS NOT NULL
       ORDER BY completed_at DESC, created_at DESC`,
    )
    .all();
  const byPath = new Map();
  for (const row of rows) {
    const filePath = String(row.final_path || "").trim();
    if (!filePath || byPath.has(path.resolve(filePath))) continue;
    byPath.set(path.resolve(filePath), {
      artistName: row.artist_name,
      albumName: row.album_name,
      trackName: row.track_name,
      artistMbid: row.artist_mbid,
      albumMbid: row.album_mbid,
      trackMbid: row.track_mbid,
      releaseYear: row.release_year,
      trackNumber: row.track_number,
    });
  }
  return byPath;
}

async function canonicalizeAurralArtistNames(jobMetadataByPath) {
  const candidates = new Map();
  for (const metadata of jobMetadataByPath.values()) {
    const artistMbid = String(metadata?.artistMbid || "").trim();
    const artistName = String(metadata?.artistName || "").trim();
    if (!artistMbid || !/[;,×!]/.test(artistName) || candidates.has(artistMbid)) continue;
    candidates.set(artistMbid, artistName);
  }

  for (const artistMbid of candidates.keys()) {
    const existing = db.prepare("SELECT id FROM library_artists WHERE mbid = ?").get(artistMbid);
    if (!existing) continue;
    const artistName = await musicbrainzGetArtistNameByMbid(artistMbid).catch(() => null);
    if (!artistName) continue;
    upsertLibraryArtist({
      identityKey: `mbid:${artistMbid}`,
      mbid: artistMbid,
      name: artistName,
    });
  }
}

// `artistIds` scopes the run to a Lidarr re-index of those artists and skips
// the Aurral root scan, which Lidarr changes cannot affect, unless
// `includeLocal` asks for both (the file watcher saw changes under both roots).
// A run left "running" by a killed worker committed rows whose deferred search
// sync never happened; close it and repair the documents it left stale. The
// repair compares whole tables, so it runs in the scan worker only; the main
// thread closes the runs at startup and leaves a marker for the next scan.
export async function repairInterruptedLibraryScans() {
  const closed = failInterruptedLibraryScans();
  const pending = closed > 0 || dbOps.getJSONSetting(SEARCH_REPAIR_PENDING_KEY) === true;
  if (pending) {
    await repairLibrarySearchDocuments();
    dbOps.setJSONSetting(SEARCH_REPAIR_PENDING_KEY, false);
  }
  return closed;
}

export function closeInterruptedLibraryScans() {
  const closed = failInterruptedLibraryScans();
  if (closed > 0) dbOps.setJSONSetting(SEARCH_REPAIR_PENDING_KEY, true);
  return closed;
}

// withLibraryScan records failures that happen inside the indexed phase; a
// failure while the indexer is still pulling the Lidarr lists (the common
// case for a timeout) has no run row yet, so one is written here.
function recordFailedLidarrScan(source, rootPath, error) {
  try {
    const scanId = beginLibraryScan({ source, rootPath });
    finishLibraryScan(scanId, { status: "failed", error: error?.message || String(error) });
  } catch (storeError) {
    logger.warn("library", "Could not record failed Lidarr scan", {
      error: storeError?.message || String(storeError),
    });
  }
}

export async function scanConfiguredLibrary({
  musicRoot = resolvePlaylistRoot(),
  lidarrClient,
  includeLidarr = true,
  artistIds = null,
  force = false,
  includeLocal = false,
} = {}) {
  const scoped = Array.isArray(artistIds) && artistIds.length > 0;
  const scanLocal = !scoped || includeLocal === true;
  const jobMetadataByPath = scanLocal ? getAurralJobMetadataByPath() : new Map();
  // Each scan syncs the search documents of the rows it changed when it ends
  // (see withLibraryScan), and the cache invalidation it triggers schedules
  // the background genre snapshot refresh. A scan that fails part-way gets a
  // gap repair instead of a full rebuild.
  let local = { skipped: true, changed: false, filesSeen: 0, filesIndexed: 0, filesFailed: 0 };
  let lidarr = { skipped: true, filesSeen: 0, filesIndexed: 0, filesFailed: 0 };
  let scanFailed = false;
  await repairInterruptedLibraryScans();
  try {
    if (scanLocal) {
      local = await scanMusicRoot({
        rootPath: musicRoot,
        source: "aurral",
        metadataEnricher: (_metadata, filePath) => jobMetadataByPath.get(path.resolve(filePath)),
        syncSearch: false,
      });
      await canonicalizeAurralArtistNames(jobMetadataByPath);
    }
    if (includeLidarr) {
      try {
        lidarr = await indexLidarrLibrary({
          client: lidarrClient,
          syncSearch: false,
          artistIds: scoped ? artistIds : null,
          force: force === true,
        });
      } catch (error) {
        // The Lidarr phase used to fail quietly here: the job completed, no
        // run row recorded the error, and the next watcher flush repeated the
        // same full pull against a Lidarr that had just timed out. The failure
        // now fails the scan job (so the queue backs off and the retry cap
        // applies), and a failed run row keeps the error visible in the UI
        // when the indexer aborted before it opened one.
        scanFailed = true;
        const scope = scoped ? `artist:${artistIds.join(",")}` : "full";
        logger.error("library", "Lidarr library scan failed", {
          scope,
          error: error?.message || String(error),
        });
        recordFailedLidarrScan(scoped ? "lidarr-artist" : "lidarr", scope, error);
        throw new Error(`Lidarr library scan failed: ${error?.message || error}`, { cause: error });
      }
    }
  } catch (error) {
    scanFailed = true;
    throw error;
  } finally {
    if (scanFailed) await repairLibrarySearchDocuments();
  }
  // A completed scan is the point where table shapes change the most, so
  // refresh the planner statistics here (cheap: only stale tables are analysed).
  db.pragma("optimize");
  return { local, lidarr };
}

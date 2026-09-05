import path from "node:path";
import { db } from "../config/db-sqlite.js";
import { resolvePlaylistRoot } from "./playlistPaths.js";
import { scanMusicRoot } from "./libraryFileScanner.js";
import { repairLibrarySearchDocuments, upsertLibraryArtist } from "./libraryMediaStore.js";
import { indexLidarrLibrary } from "./libraryLidarrIndexer.js";
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
// the Aurral root scan, which Lidarr changes cannot affect.
export async function scanConfiguredLibrary({
  musicRoot = resolvePlaylistRoot(),
  lidarrClient,
  includeLidarr = true,
  artistIds = null,
  force = false,
} = {}) {
  const scoped = Array.isArray(artistIds) && artistIds.length > 0;
  const jobMetadataByPath = scoped ? new Map() : getAurralJobMetadataByPath();
  // Each scan syncs the search documents of the rows it changed when it ends
  // (see withLibraryScan), and the cache invalidation it triggers schedules
  // the background genre snapshot refresh. A scan that fails part-way gets a
  // gap repair instead of a full rebuild.
  let local = { skipped: true, changed: false, filesSeen: 0, filesIndexed: 0, filesFailed: 0 };
  let lidarr = { skipped: true, filesSeen: 0, filesIndexed: 0, filesFailed: 0 };
  let scanFailed = false;
  try {
    if (!scoped) {
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
        scanFailed = true;
        lidarr = {
          skipped: false,
          error: error.message,
          filesSeen: 0,
          filesIndexed: 0,
          filesFailed: 0,
        };
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

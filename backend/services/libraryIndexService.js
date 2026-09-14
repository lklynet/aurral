import path from "node:path";
import { db } from "../config/db-sqlite.js";
import { dbOps } from "../db/helpers/index.js";
import { resolvePlaylistRoot } from "./playlistPaths.js";
import { scanMusicRoot, scanMusicRoots } from "./libraryFileScanner.js";
import { upsertLibraryArtist } from "./libraryMediaStore.js";
import { rebuildLibrarySearchIndex } from "./librarySearchIndex.js";
import { rebuildCanonicalGenreStats } from "./libraryQueryService.js";
import { musicbrainzGetArtistNameByMbid } from "./apiClients/index.js";
import { logger } from "./logger.js";
import { getPathMappings, resolveLocalPath } from "./pathMappings.js";

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

function configuredLidarrRoots(lidarrClient, override) {
  if (Array.isArray(override)) return override;
  const fromClient = lidarrClient?.getConfiguredRootFolderPaths?.();
  if (Array.isArray(fromClient) && fromClient.length > 0) return fromClient;
  const settings = dbOps.getSettings();
  const lidarr = settings.integrations?.lidarr || {};
  return [
    ...(Array.isArray(lidarr.rootFolderPaths) ? lidarr.rootFolderPaths : []),
    lidarr.rootFolderPath,
  ].filter(Boolean);
}

function isLidarrScanEnabled(lidarrClient) {
  if (typeof lidarrClient?.isEnabled === "function") return lidarrClient.isEnabled();
  return dbOps.getSettings().integrations?.lidarr?.enabled !== false;
}

export async function scanConfiguredLibrary({
  musicRoot = resolvePlaylistRoot(),
  lidarrClient,
  includeLidarr = true,
  lidarrRoots = null,
} = {}) {
  const jobMetadataByPath = getAurralJobMetadataByPath();
  let local;
  let lidarr = { skipped: true, filesSeen: 0, filesIndexed: 0, filesFailed: 0 };
  let scanFailed = false;
  try {
    local = await scanMusicRoot({
      rootPath: musicRoot,
      source: "aurral",
      metadataEnricher: (_metadata, filePath) => jobMetadataByPath.get(path.resolve(filePath)),
      syncSearch: false,
    });
    await canonicalizeAurralArtistNames(jobMetadataByPath);
    const configuredRoots = configuredLidarrRoots(lidarrClient, lidarrRoots)
      .map((root) => resolveLocalPath(root, getPathMappings("lidarr")));
    if (includeLidarr && isLidarrScanEnabled(lidarrClient) && configuredRoots.length > 0) {
      try {
        lidarr = await scanMusicRoots({
          rootPaths: configuredRoots,
          source: "lidarr",
          syncSearch: false,
        });
      } catch (error) {
        scanFailed = true;
        logger.error("library", "Lidarr root scan failed", {
          message: error?.message || String(error),
        });
        lidarr = {
          skipped: false,
          error: error?.message || String(error),
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
    if (scanFailed || local?.changed || lidarr?.changed) {
      rebuildLibrarySearchIndex();
      rebuildCanonicalGenreStats();
    }
  }
  return { local, lidarr };
}

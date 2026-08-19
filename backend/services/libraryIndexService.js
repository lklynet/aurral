import path from "node:path";
import { db } from "../config/db-sqlite.js";
import { resolvePlaylistRoot } from "./playlistPaths.js";
import { scanMusicRoot } from "./libraryFileScanner.js";
import { indexLidarrLibrary } from "./libraryLidarrIndexer.js";

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

export async function scanConfiguredLibrary({ musicRoot = resolvePlaylistRoot(), lidarrClient } = {}) {
  const jobMetadataByPath = getAurralJobMetadataByPath();
  const local = await scanMusicRoot({
    rootPath: musicRoot,
    source: "aurral",
    metadataEnricher: (_metadata, filePath) => jobMetadataByPath.get(path.resolve(filePath)),
  });
  let lidarr = { skipped: true, filesSeen: 0, filesIndexed: 0, filesFailed: 0 };
  try {
    lidarr = await indexLidarrLibrary({ client: lidarrClient });
  } catch (error) {
    lidarr = {
      skipped: false,
      error: error.message,
      filesSeen: 0,
      filesIndexed: 0,
      filesFailed: 0,
    };
  }
  return { local, lidarr };
}

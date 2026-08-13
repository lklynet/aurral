import { resolvePlaylistRoot } from "./playlistPaths.js";
import { scanMusicRoot } from "./libraryFileScanner.js";
import { indexLidarrLibrary } from "./libraryLidarrIndexer.js";

export async function scanConfiguredLibrary({ musicRoot = resolvePlaylistRoot(), lidarrClient } = {}) {
  const local = await scanMusicRoot({ rootPath: musicRoot, source: "aurral" });
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

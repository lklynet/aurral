import fs from "node:fs/promises";
import path from "node:path";
import {
  flowPlaylistConfig,
  orderJobsBySharedPlaylistTracks,
} from "../weeklyFlow/weeklyFlowPlaylistConfig.js";
import { downloadTracker } from "../weeklyFlow/weeklyFlowDownloadTracker.js";
import {
  remapLegacyPath,
  resolvePlaylistRoot,
} from "../playlistPaths.js";

async function isFile(filePath) {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

export async function collectPlaybackPlaylistTracks(entityId, options = {}) {
  const weeklyFlowRoot = path.resolve(options.weeklyFlowRoot || resolvePlaylistRoot());
  const jobs = downloadTracker
    .getByPlaylistType(entityId)
    .filter((job) => job?.status === "done" && typeof job?.finalPath === "string");
  const orderedJobs = orderJobsBySharedPlaylistTracks(
    jobs,
    flowPlaylistConfig.getSharedPlaylist(entityId)?.tracks,
  );
  const tracks = [];
  for (const job of orderedJobs) {
    const localPath = path.resolve(remapLegacyPath(job.finalPath, weeklyFlowRoot));
    if (!(await isFile(localPath))) continue;
    tracks.push({
      path: localPath,
      title: String(job.trackName || "").trim() || "Unknown Track",
      artist: String(job.artistName || "").trim() || "Unknown Artist",
      ...(job.albumName ? { album: job.albumName } : {}),
      ...(job.durationMs != null ? { durationMs: job.durationMs } : {}),
      ...(job.trackMbid ? { mbid: job.trackMbid } : {}),
    });
  }
  return tracks;
}

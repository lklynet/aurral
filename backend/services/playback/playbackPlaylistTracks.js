import fs from "node:fs/promises";
import path from "node:path";
import {
  flowPlaylistConfig,
  orderJobsBySharedPlaylistTracks,
} from "../playlists/flowPlaylistConfig.js";
import { downloadTracker } from "../downloadJobs/downloadTracker.js";
import {
  resolveExistingTrackPath,
  resolveDownloadRoot,
} from "../downloadPaths.js";

async function isFile(filePath) {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

export async function collectPlaybackPlaylistTracks(entityId, options = {}) {
  const downloadRoot = path.resolve(options.downloadRoot || resolveDownloadRoot());
  const playlist = flowPlaylistConfig.getSharedPlaylist(entityId);
  const referencedJobs = (playlist?.tracks || [])
    .map((track) => (track?.canonicalJobId ? downloadTracker.getJob(track.canonicalJobId) : null))
    .filter(Boolean);
  const jobs = [
    ...referencedJobs,
    ...downloadTracker.getByPlaylistType(entityId),
  ]
    .filter((job, index, values) =>
      values.findIndex((candidate) => candidate.id === job.id) === index,
    )
    .filter((job) => job?.status === "done" && typeof job?.finalPath === "string");
  const orderedJobs = orderJobsBySharedPlaylistTracks(
    jobs,
    playlist?.tracks,
  );
  const tracks = [];
  for (const job of orderedJobs) {
    const resolved = await resolveExistingTrackPath(job.finalPath, downloadRoot);
    if (!resolved || !(await isFile(resolved.path))) continue;
    tracks.push({
      path: resolved.path,
      title: String(job.trackName || "").trim() || "Unknown Track",
      artist: String(job.artistName || "").trim() || "Unknown Artist",
      ...(job.albumName ? { album: job.albumName } : {}),
      ...(job.durationMs != null ? { durationMs: job.durationMs } : {}),
      ...(job.trackMbid ? { mbid: job.trackMbid } : {}),
    });
  }
  return tracks;
}

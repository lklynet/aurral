import fs from "node:fs/promises";
import { playlistJobEntries } from "./playlistJobs.ts";
import path from "node:path";
import { flowPlaylistConfig } from "./flowPlaylistConfig.ts";

async function isFile(filePath: string) {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

export async function collectPlaylistFileTracks(entityId: string) {
  const playlist = flowPlaylistConfig.getStaticPlaylist(entityId) ?? { id: entityId };
  const tracks = [];
  for (const { job } of playlistJobEntries(playlist)) {
    if (job.status !== "done") continue;
    if (!(await isFile(job.finalPath))) continue;
    tracks.push({
      path: path.resolve(job.finalPath),
      title: String(job.trackName || "").trim() || "Unknown Track",
      artist: String(job.artistName || "").trim() || "Unknown Artist",
      ...(job.albumName && { album: job.albumName }),
      ...(job.durationMs != null && { durationMs: job.durationMs }),
      ...(job.trackMbid && { mbid: job.trackMbid }),
    });
  }
  return tracks;
}

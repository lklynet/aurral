import fs from "node:fs/promises";
import { playlistJobEntries } from "./playlistJobs.ts";
import path from "node:path";
import { flowPlaylistConfig } from "./flowPlaylistConfig.ts";
import { resolveExistingTrackPath, resolveDownloadRoot } from "../downloadPaths.ts";

async function isFile(filePath: string) {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

export async function collectPlaylistFileTracks(
  entityId: string,
  options: { downloadRoot?: string | null } = {},
) {
  const downloadRoot = path.resolve(options.downloadRoot || resolveDownloadRoot());
  const playlist = flowPlaylistConfig.getStaticPlaylist(entityId) ?? { id: entityId };
  const tracks = [];
  for (const { job } of playlistJobEntries(playlist)) {
    if (job.status !== "done" || typeof job.finalPath !== "string") continue;
    const resolved = await resolveExistingTrackPath(job.finalPath, downloadRoot);
    if (!resolved || !(await isFile(resolved.path))) continue;
    tracks.push({
      path: resolved.path,
      title: String(job.trackName || "").trim() || "Unknown Track",
      artist: String(job.artistName || "").trim() || "Unknown Artist",
      ...(job.albumName && { album: job.albumName }),
      ...(job.durationMs != null && { durationMs: job.durationMs }),
      ...(job.trackMbid && { mbid: job.trackMbid }),
    });
  }
  return tracks;
}

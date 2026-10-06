import { flowPlaylistConfig } from "../playlists/flowPlaylistConfig.js";
import { getStaticPlaylistJobs } from "../playlists/staticPlaylistJobs.js";
import { downloadTracker } from "../downloadJobs/downloadTracker.js";
import { resolveExistingTrackPath } from "../downloadPaths.js";

export async function collectPlaybackPlaylistTracks(entityId) {
  const playlist = flowPlaylistConfig.getStaticPlaylist(entityId);
  const jobs = (playlist ? getStaticPlaylistJobs(playlist) : downloadTracker.getByOwner(entityId))
    .filter((job) => job?.status === "done" && typeof job?.finalPath === "string");
  const tracks = [];
  for (const job of jobs) {
    const trackPath = await resolveExistingTrackPath(job.finalPath);
    if (!trackPath) continue;
    tracks.push({
      path: trackPath,
      title: String(job.trackName || "").trim() || "Unknown Track",
      artist: String(job.artistName || "").trim() || "Unknown Artist",
      ...(job.albumName ? { album: job.albumName } : {}),
      ...(job.durationMs != null ? { durationMs: job.durationMs } : {}),
      ...(job.trackMbid ? { mbid: job.trackMbid } : {}),
    });
  }
  return tracks;
}

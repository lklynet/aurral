import {
  flowPlaylistConfig,
  orderJobsByPlaylistTracks,
} from "../playlists/flowPlaylistConfig.js";
import { downloadTracker } from "../downloadJobs/downloadTracker.js";
import { resolveExistingTrackPath } from "../downloadPaths.js";

export async function collectPlaybackPlaylistTracks(entityId) {
  const playlist = flowPlaylistConfig.getStaticPlaylist(entityId);
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
  const orderedJobs = orderJobsByPlaylistTracks(
    jobs,
    playlist?.tracks,
  );
  const tracks = [];
  for (const job of orderedJobs) {
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

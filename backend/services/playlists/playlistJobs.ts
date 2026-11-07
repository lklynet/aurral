import { downloadTracker } from "../downloadJobs/downloadTracker.ts";
import { flowPlaylistConfig } from "./flowPlaylistConfig.ts";
import { orderJobsByPlaylistTracks, type PlaylistTrackInput } from "./playlistTracks.ts";

export function staticPlaylistJobs(playlist: { tracks?: PlaylistTrackInput[] } | null | undefined) {
  const ids = new Set((playlist?.tracks ?? []).map((track) => String(track?.canonicalJobId || "")));
  return [...ids].map((id) => downloadTracker.getJob(id)).filter((job) => job !== null);
}

export function playlistJobEntries(
  playlist: { id: string; tracks?: PlaylistTrackInput[] } | null | undefined,
) {
  if (!playlist) return [];
  if (flowPlaylistConfig.getFlow(playlist.id)) {
    return orderJobsByPlaylistTracks(downloadTracker.getByPlaylistType(playlist.id), null).map(
      (job) => ({ job, trackIndex: -1 }),
    );
  }
  return (playlist.tracks ?? []).flatMap((track, trackIndex) => {
    const job = downloadTracker.getJob(String(track?.canonicalJobId || ""));
    return job ? [{ job, trackIndex }] : [];
  });
}

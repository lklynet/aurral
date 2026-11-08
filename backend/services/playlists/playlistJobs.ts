import { downloadTracker } from "../downloadJobs/downloadTracker.ts";
import { flowPlaylistConfig } from "./flowPlaylistConfig.ts";
import { orderJobsByPlaylistTracks, type PlaylistTrackInput } from "./playlistTracks.ts";

export function staticPlaylistJobs(playlist: { tracks?: PlaylistTrackInput[] } | null | undefined) {
  const ids = [
    ...new Set((playlist?.tracks ?? []).map((track) => String(track?.canonicalJobId || ""))),
  ];
  const jobs = downloadTracker.getJobs(ids);
  return ids.flatMap((id) => jobs.get(id) ?? []);
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
  const tracks = playlist.tracks ?? [];
  const jobs = downloadTracker.getJobs(tracks.map((track) => String(track?.canonicalJobId || "")));
  return tracks.flatMap((track, trackIndex) => {
    const job = jobs.get(String(track?.canonicalJobId || ""));
    return job ? [{ job, trackIndex }] : [];
  });
}

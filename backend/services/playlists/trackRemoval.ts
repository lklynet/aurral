import { withPlaylistMutationLock } from "../downloadJobs/mutationGuards.ts";
import { dbOps } from "../../db/helpers/index.ts";
import { downloadTracker, type DownloadJob } from "../downloadJobs/downloadTracker.ts";
import {
  flowPlaylistConfig,
  invalidateFlowPlaylistConfigCache,
  type StaticPlaylist,
} from "./flowPlaylistConfig.ts";
import { playlistManager } from "./playlistManager.ts";
import type { StaticPlaylistSelection } from "./bulkOperationStore.ts";

function playlistsWithMissingDownloads() {
  dbOps.invalidateSettingsCache();
  invalidateFlowPlaylistConfigCache();
  const jobIds = new Set(downloadTracker.getAll().map((job) => job.id));
  return flowPlaylistConfig
    .getStaticPlaylists()
    .map((playlist) => ({
      playlist,
      tracks: playlist.tracks.filter(
        (track) => !track.canonicalJobId || jobIds.has(track.canonicalJobId),
      ),
    }))
    .filter(({ playlist, tracks }) => tracks.length < playlist.tracks.length);
}

export async function removePlaylistTracksWithoutDownloads() {
  const playlistIds = playlistsWithMissingDownloads().map(({ playlist }) => playlist.id);
  if (!playlistIds.length) return [];
  const repairedIds = await withPlaylistMutationLock(playlistIds, () =>
    playlistsWithMissingDownloads()
      .filter(
        ({ playlist, tracks }) =>
          playlistIds.includes(playlist.id) &&
          flowPlaylistConfig.updateStaticPlaylist(playlist.id, { tracks }),
      )
      .map(({ playlist }) => playlist.id),
  );
  playlistManager.requestPlaylistSync(repairedIds);
  return repairedIds;
}

export function captureStaticPlaylistSelection(
  playlist: StaticPlaylist,
  jobId: string,
): StaticPlaylistSelection | null {
  const job = downloadTracker.getJob(jobId);
  const track = playlist.tracks.find((entry) => entry.canonicalJobId === jobId);
  if (!job || !track) return null;
  return {
    jobId,
    membershipId: track?.membershipId || null,
  };
}

export function isStaticPlaylistSelectionCurrent(
  selection: StaticPlaylistSelection,
  playlist: StaticPlaylist,
  job: DownloadJob | null | undefined,
) {
  return Boolean(
    job &&
    playlist.tracks.some(
      (track) =>
        track.canonicalJobId === job.id &&
        (!selection.membershipId || track.membershipId === selection.membershipId),
    ),
  );
}

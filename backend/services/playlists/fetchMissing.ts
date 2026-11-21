import { db } from "../../config/db-sqlite.ts";
import { userOps } from "../../db/helpers/index.ts";
import { hasPermission } from "../auth.ts";
import { recordTrackJobQueued } from "../aurralHistoryService.ts";
import { getLibraryTrackOwnershipBatch } from "../libraryQueryService.ts";
import { downloadTracker, type DownloadJob } from "../downloadJobs/downloadTracker.ts";
import { isAnyDownloadSourceConfigured } from "../downloadSourceService.ts";
import {
  flowPlaylistConfig,
  invalidateFlowPlaylistConfigCache,
  type StaticPlaylist,
} from "./flowPlaylistConfig.ts";
import { staticPlaylistJobs } from "./playlistJobs.ts";
import { tracksShareMembership } from "./playlistTracks.ts";

const cancelled = db.prepare<[string], { id: string }>(`
  SELECT job_id AS id FROM download_job_cancellations WHERE job_id IN (SELECT value FROM json_each(?))
`);

export function fetchMissingJobIds(
  playlist: StaticPlaylist,
  jobs: DownloadJob[] = staticPlaylistJobs(playlist),
  owned?: boolean[],
) {
  const members = new Map(playlist.tracks.map((track) => [track.canonicalJobId, track]));
  const candidates = jobs.filter((job, index) => {
    const member = members.get(job.id);
    return (
      !owned?.[index] &&
      job.playlistType === "library" &&
      (job.status === "saved" || job.status === "failed") &&
      !job.finalPath &&
      !job.heldForReview &&
      !job.upgradeForJobId &&
      member &&
      tracksShareMembership(member, job) &&
      !(member.trackMbid && job.trackMbid && member.trackMbid !== job.trackMbid)
    );
  });
  if (!candidates.length) return new Set<string>();
  const libraryOwned = owned ? [] : getLibraryTrackOwnershipBatch(candidates);
  const ids = candidates.filter((_, index) => !libraryOwned[index]).map((job) => job.id);
  const eligible = new Set(ids);
  if (ids.length) {
    for (const row of cancelled.all(JSON.stringify(ids))) eligible.delete(row.id);
  }
  return eligible;
}

export function fetchMissingPlaylistTracks(
  playlistId: string,
  selected: string[],
  requesterId: number,
) {
  if (requesterId !== -1 && (!Number.isSafeInteger(requesterId) || requesterId <= 0))
    return { queued: 0 };
  invalidateFlowPlaylistConfigCache();
  const playlist = flowPlaylistConfig.getStaticPlaylist(playlistId);
  if (!playlist || !isAnyDownloadSourceConfigured()) return { queued: 0 };
  if (requesterId > 0) {
    const user = userOps.getUserById(requesterId);
    if (
      !user ||
      user.status !== "active" ||
      !hasPermission(user, "accessPlaylists") ||
      !flowPlaylistConfig.canUserAccessStaticPlaylist(user, playlist)
    )
      return { queued: 0 };
  }
  const accepted = new Set(selected);
  const current = staticPlaylistJobs(playlist).filter((job) => accepted.has(job.id));
  let queued = 0;
  for (const id of fetchMissingJobIds(playlist, current)) {
    const job = downloadTracker.getJob(id);
    if (!job) continue;
    if (
      !downloadTracker.setPending(id, null, {
        asRetryCycle: job.status === "failed",
        cause: { kind: "playlist", playlistId },
      })
    )
      continue;
    recordTrackJobQueued(downloadTracker.getJob(id));
    queued++;
  }
  return { queued };
}

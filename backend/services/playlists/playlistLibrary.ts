import fs from "node:fs/promises";
import { db } from "../../config/db-sqlite.ts";
import { asAppError } from "../../../lib/errors.ts";
import { recordTrackJobQueued } from "../aurralHistoryService.ts";
import { cancelTrackDownload, cancelTrackDownloads } from "../aurralAlbumJobs.ts";
import { downloadTracker, type DownloadJob } from "../downloadJobs/downloadTracker.ts";
import { downloadWorker } from "../downloadJobs/downloadWorker.ts";
import { jobDownloadedItsFile, reuseTrackForPlaylist } from "../downloadJobs/fileReuse.ts";
import { removeLibraryMediaFiles } from "../libraryMediaStore.ts";
import { logger } from "../logger.ts";
import { flowPlaylistConfig } from "./flowPlaylistConfig.ts";
import {
  buildCoreTrackIdentity,
  tracksShareMembership,
  type PlaylistTrack,
} from "./playlistTracks.ts";

const LIBRARY = "library";

const STATUS_RANK: Partial<Record<DownloadJob["status"], number>> = {
  downloading: 0,
  pending: 1,
  blocked: 2,
  done: 3,
  saved: 4,
  failed: 5,
};

const starredFileStmt = db.prepare<[string], { 1: number }>(`
  SELECT 1 FROM library_media_files AS media
  JOIN library_tracks AS track ON track.id = media.track_id
  JOIN subsonic_stars AS star ON star.entity_kind = 'song' AND star.entity_key = track.identity_key
  WHERE media.path = ?
  LIMIT 1
`);

const songPathsStmt = db.prepare<[string], { path: string }>(`
  SELECT media.path FROM library_media_files AS media
  JOIN library_tracks AS track ON track.id = media.track_id
  WHERE track.identity_key = ?
`);

const isLibraryJob = (job: DownloadJob | null): job is DownloadJob =>
  job?.playlistType === LIBRARY && !job.upgradeForJobId;

function libraryJobIndex() {
  const index = new Map<string, DownloadJob[]>();
  for (const job of downloadTracker.getAll()) {
    if (!isLibraryJob(job) || STATUS_RANK[job.status] === undefined) continue;
    const key = buildCoreTrackIdentity(job);
    if (key) index.set(key, [...(index.get(key) ?? []), job]);
  }
  return index;
}

const bestLibraryJob = (index: Map<string, DownloadJob[]>, track: PlaylistTrack) =>
  (index.get(buildCoreTrackIdentity(track)) ?? [])
    .filter(
      (job) =>
        tracksShareMembership(job, track) &&
        !(job.trackMbid && track.trackMbid && job.trackMbid !== track.trackMbid),
    )
    .sort((a, b) => (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9))[0] ?? null;

function keepFor(job: DownloadJob, startedByPlaylist: string | null) {
  if (job.startedByPlaylist && job.startedByPlaylist !== startedByPlaylist)
    downloadTracker.setStartedByPlaylist(job.id, null);
}

const requeue = (job: DownloadJob) =>
  (job.status === "saved" && downloadTracker.setPending(job.id)) ||
  (job.status === "failed" &&
    downloadTracker.setPending(job.id, "Requested again", { asRetryCycle: true }));

async function createLibraryJob(
  track: PlaylistTrack,
  { startedByPlaylist, download }: { startedByPlaylist: string | null; download: boolean },
) {
  const jobId = downloadTracker.addJob(track, LIBRARY, { saved: true });
  if (!jobId) return null;
  try {
    const reuse = await reuseTrackForPlaylist(track, LIBRARY, {
      downloadRoot: downloadWorker.downloadRoot,
      existingJobId: jobId,
      targetPlaylistType: LIBRARY,
      skipHistory: true,
    });
    if (reuse.reused) return { jobId, outcome: "reused" as const };
  } catch (error) {
    logger.warn("playlists", "Track reuse failed; queueing a download", {
      artist: track.artistName,
      track: track.trackName,
      error: asAppError(error)?.message,
    });
  }
  if (startedByPlaylist) downloadTracker.setStartedByPlaylist(jobId, startedByPlaylist);
  if (!download) return { jobId, outcome: "saved" as const };
  downloadTracker.setPending(jobId, null);
  recordTrackJobQueued(downloadTracker.getJob(jobId));
  return { jobId, outcome: "queued" as const };
}

export function keepInLibrary(track: Parameters<typeof buildCoreTrackIdentity>[0]) {
  for (const job of libraryJobIndex().get(buildCoreTrackIdentity(track)) ?? []) {
    if (job.startedByPlaylist && tracksShareMembership(job, track))
      downloadTracker.setStartedByPlaylist(job.id, null);
  }
}

export function keepSongsInLibrary(songKeys: string[]) {
  const paths = new Set(songKeys.flatMap((key) => songPathsStmt.all(key).map((row) => row.path)));
  if (!paths.size) return;
  for (const job of downloadTracker.getAll()) {
    if (job.startedByPlaylist && job.finalPath && paths.has(job.finalPath))
      downloadTracker.setStartedByPlaylist(job.id, null);
  }
}

export async function linkTracksToLibrary(
  tracks: PlaylistTrack[],
  { startedByPlaylist, download = true }: { startedByPlaylist: string | null; download?: boolean },
) {
  const index = libraryJobIndex();
  const linked: PlaylistTrack[] = [];
  const queuedJobIds: string[] = [];
  const reusedJobIds: string[] = [];
  const createdJobIds: string[] = [];
  for (const track of tracks) {
    const referenced = downloadTracker.getJob(track.canonicalJobId);
    const existing =
      isLibraryJob(referenced) && tracksShareMembership(referenced, track)
        ? referenced
        : bestLibraryJob(index, track);
    if (existing) {
      keepFor(existing, startedByPlaylist);
      if (download && existing !== referenced && requeue(existing)) {
        queuedJobIds.push(existing.id);
        recordTrackJobQueued(downloadTracker.getJob(existing.id));
      }
      reusedJobIds.push(existing.id);
      linked.push({ ...track, canonicalJobId: existing.id });
      continue;
    }
    const created = await createLibraryJob(track, { startedByPlaylist, download });
    if (!created) {
      linked.push(track);
      continue;
    }
    createdJobIds.push(created.jobId);
    if (created.outcome === "queued") queuedJobIds.push(created.jobId);
    if (created.outcome === "reused") reusedJobIds.push(created.jobId);
    const job = downloadTracker.getJob(created.jobId);
    if (job) {
      const key = buildCoreTrackIdentity(job);
      index.set(key, [...(index.get(key) ?? []), job]);
    }
    linked.push({ ...track, canonicalJobId: created.jobId });
  }
  return { tracks: linked, queuedJobIds, reusedJobIds, createdJobIds };
}

function wantedElsewhere(job: DownloadJob, playlistId: string) {
  if (job.startedByPlaylist !== playlistId) return true;
  return (
    flowPlaylistConfig.getStaticPlaylistIdsUsingJobs([job.id]).length > 0 ||
    Boolean(job.finalPath && starredFileStmt.get(job.finalPath))
  );
}

async function dropTrackFile(job: DownloadJob) {
  const finalPath = job.finalPath;
  if (!finalPath || !jobDownloadedItsFile(job)) return;
  const sharedFile = downloadTracker
    .getAll()
    .some(
      (other) => other.id !== job.id && other.status === "done" && other.finalPath === finalPath,
    );
  if (sharedFile) return;
  const upgrades = downloadTracker.getAll().filter((entry) => entry.upgradeForJobId === job.id);
  if (upgrades.length) {
    const cancelled = await cancelTrackDownloads(upgrades.map((entry) => entry.id));
    if (cancelled.cleanupFailed) throw new Error("Could not stop its quality upgrade");
  }
  await fs.rm(finalPath, { force: true });
  for (const entry of upgrades) downloadTracker.removeJob(entry.id);
  downloadTracker.removeJob(job.id);
  removeLibraryMediaFiles("aurral", [finalPath]);
}

export async function discardLibraryJobs(jobIds: string[]) {
  for (const jobId of jobIds) {
    const job = downloadTracker.getJob(jobId);
    if (!isLibraryJob(job) || flowPlaylistConfig.getStaticPlaylistIdsUsingJobs([jobId]).length)
      continue;
    if (!["done", "saved"].includes(job.status)) {
      const cancelled = await cancelTrackDownload(job.id);
      if ("cleanupFailed" in cancelled && cancelled.cleanupFailed) continue;
      if (downloadTracker.getJob(job.id)?.status === "done") continue;
    }
    downloadTracker.removeJob(job.id);
  }
}

export async function releaseLibraryJobs(
  playlistId: string,
  jobIds: Iterable<string | null | undefined>,
  { dropFiles = false } = {},
) {
  let released = 0;
  for (const jobId of new Set(jobIds)) {
    const job = downloadTracker.getJob(jobId);
    if (!isLibraryJob(job) || wantedElsewhere(job, playlistId)) continue;
    try {
      if (job.status === "done") {
        if (!dropFiles) continue;
        await dropTrackFile(job);
      } else {
        const cancelled = await cancelTrackDownload(job.id);
        if ("cleanupFailed" in cancelled && cancelled.cleanupFailed) continue;
        if (downloadTracker.getJob(job.id)?.status === "done") continue;
        downloadTracker.removeJob(job.id);
      }
      released += 1;
    } catch (error) {
      logger.warn("playlists", "Kept a Library track a playlist no longer uses", {
        playlistId,
        jobId: job.id,
        reason: asAppError(error)?.message,
      });
    }
  }
  return released;
}

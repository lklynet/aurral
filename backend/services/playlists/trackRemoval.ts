import { withPlaylistMutation, withPlaylistMutationLock } from "../downloadJobs/mutationGuards.ts";
import * as v from "valibot";
import { db, dbHelpers } from "../../config/db-sqlite.ts";
import { dbOps } from "../../db/helpers/index.ts";
import { listHonkerJobs } from "../honkerDb.ts";
import { asAppError } from "../../../lib/errors.ts";
import type { SettingsRow } from "../../db/rows.ts";
import { downloadTracker, type DownloadJob } from "../downloadJobs/downloadTracker.ts";
import {
  flowPlaylistConfig,
  invalidateFlowPlaylistConfigCache,
  tracksShareMembership,
  type StaticPlaylist,
} from "./flowPlaylistConfig.ts";
import { cancelDownloadWorkForJobs } from "../downloadJobs/downloadCancellationService.ts";
import {
  isDownloadJobCancelled,
  restoreDownloadJobCancellations,
} from "../downloadJobs/downloadCancellation.ts";
import {
  transferDownloadOwnershipInTransaction,
  replaceAlbumDownloadLeaderInTransaction,
} from "../downloadJobs/downloadOwnership.ts";
import {
  prepareRetainedPlaylistFile,
  commitRetainedPlaylistRelocationInTransaction,
  type PreparedRetainedPlaylistFile,
} from "./mediaRelocation.ts";
import { jobDownloadedItsFile, removePlaylistFileIfUnshared } from "../downloadJobs/fileReuse.ts";
import { downloadWorker } from "../downloadJobs/downloadWorker.ts";
import { playlistManager } from "./playlistManager.ts";
import type { StaticPlaylistSelection } from "./bulkOperationStore.ts";

export interface StaticPlaylistRemovalOutcome {
  jobId: string;
  status: "removed" | "failed" | "alreadyAbsent";
  message?: string;
}

type RemovalPlan = {
  selection: StaticPlaylistSelection;
  target: StaticPlaylist | undefined;
  peer: DownloadJob | null;
  upgrades: DownloadJob[];
  relocation: PreparedRetainedPlaylistFile | null | undefined;
} & ({ owned: true; job: DownloadJob } | { owned: false; job: DownloadJob | null });

const payloadIds = (value: unknown) =>
  Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];

const removedMediaSchema = v.looseObject({
  playlistId: v.string(),
  finalPath: v.nullish(v.string()),
});

export function getSharedDownloadReferences(jobId: string | null, excludedPlaylistId: string) {
  return flowPlaylistConfig
    .getStaticPlaylists()
    .filter(
      (playlist) =>
        playlist.id !== excludedPlaylistId &&
        playlist.tracks.some((track) => track.canonicalJobId === jobId),
    );
}

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
  if (!job || job.upgradeForJobId) return null;
  const track = playlist.tracks.find(
    (entry) =>
      entry.canonicalJobId === jobId ||
      (!entry.canonicalJobId &&
        job.playlistType === playlist.id &&
        tracksShareMembership(entry, job)),
  );
  if (job.playlistType !== playlist.id && !track?.canonicalJobId) return null;
  return {
    jobId,
    membershipId: track?.membershipId || null,
    jobPlaylistId: job.playlistType,
    jobGeneration: job.playlistGeneration,
    jobCreatedAt: job.createdAt,
  };
}

export function getPlaylistRemovalLockIds(
  playlistId: string,
  jobs: DownloadJob[],
  extraIds: (string | null | undefined)[] = [],
) {
  const owners: (string | null | undefined)[] = [playlistId, ...extraIds];
  const related = new Map(jobs.map((job) => [job.id, job] as const));
  const allJobs = downloadTracker.getAll();
  const pipelineRows = listHonkerJobs("slskd-pipeline");
  for (const job of related.values()) {
    owners.push(
      job.playlistType,
      ...getSharedDownloadReferences(job.id, playlistId).map((playlist) => playlist.id),
    );
    for (const candidate of allJobs) {
      if (
        candidate.upgradeForJobId === job.id ||
        (job.status === "done" &&
          job.finalPath &&
          candidate.status === "done" &&
          candidate.finalPath === job.finalPath)
      ) {
        related.set(candidate.id, candidate);
      }
    }
    for (const row of pipelineRows) {
      const payload = row.payload;
      const groupIds = payloadIds(payload?.albumGroupJobIds);
      if (!payload || (payload.jobId !== job.id && !groupIds.includes(job.id))) continue;
      owners.push(typeof payload.playlistId === "string" ? payload.playlistId : null);
      for (const id of [...payloadIds([payload.jobId]), ...groupIds]) {
        const peer = downloadTracker.getJob(id);
        if (peer) related.set(id, peer);
      }
    }
  }
  return [...new Set(owners.filter(Boolean))];
}

export async function withStaticPlaylistRemovalMutation(
  {
    playlistId,
    jobIds,
    extraPlaylistIds = [],
  }: { playlistId: string; jobIds: string[]; extraPlaylistIds?: (string | null | undefined)[] },
  operation: () => unknown,
) {
  while (true) {
    const readJobs = () =>
      jobIds
        .map((id) => downloadTracker.getJob(id))
        .filter((job): job is NonNullable<typeof job> => Boolean(job));
    const lockIds = getPlaylistRemovalLockIds(playlistId, readJobs(), extraPlaylistIds);
    const result = await withPlaylistMutationLock(lockIds, async () => {
      if (
        !getPlaylistRemovalLockIds(playlistId, readJobs(), extraPlaylistIds).every((id) =>
          lockIds.includes(id),
        )
      )
        return { retryLocks: true };
      return { value: await withPlaylistMutation(lockIds, operation, { clearPending: false }) };
    });
    if (!result.retryLocks) return result.value;
  }
}

export function isStaticPlaylistSelectionCurrent(
  selection: StaticPlaylistSelection,
  playlist: StaticPlaylist,
  job: DownloadJob | null | undefined,
) {
  if (selection.membershipId) {
    const track = playlist.tracks.find((entry) => entry.membershipId === selection.membershipId);
    return Boolean(
      track &&
      (!job ||
        track.canonicalJobId === job.id ||
        (!track.canonicalJobId &&
          job.playlistType === playlist.id &&
          tracksShareMembership(track, job))),
    );
  }
  return Boolean(
    job &&
    job.playlistType === playlist.id &&
    job.playlistType === selection.jobPlaylistId &&
    job.playlistGeneration === selection.jobGeneration &&
    job.createdAt === selection.jobCreatedAt,
  );
}

function replacementPeer(job: DownloadJob, removingIds: Set<string>): DownloadJob | null {
  const row = listHonkerJobs("slskd-pipeline").find(
    (entry) => entry.payload?.albumGrab === true && entry.payload.jobId === job.id,
  );
  if (!row) return null;
  return (
    payloadIds(row.payload?.albumGroupJobIds)
      .map((id) => downloadTracker.getJob(id))
      .filter(
        (peer): peer is NonNullable<typeof peer> =>
          peer !== null &&
          !removingIds.has(peer.id) &&
          peer.requestGroupId === job.requestGroupId &&
          peer.albumMbid === job.albumMbid &&
          peer.status === "downloading" &&
          !downloadTracker.isSlskdDispatched(peer.id),
      )
      .sort((a, b) => String(a.id).localeCompare(String(b.id)))[0] || null
  );
}

export async function removeStaticPlaylistSelectionsLocked({
  playlistId,
  selections,
  deleteFiles = false,
  requireAll = false,
  onCommitted,
}: {
  playlistId: string;
  selections: StaticPlaylistSelection[];
  deleteFiles?: boolean;
  requireAll?: boolean;
  onCommitted?: (outcomes: StaticPlaylistRemovalOutcome[], affectedPlaylistIds: string[]) => void;
}) {
  const playlist = flowPlaylistConfig.getStaticPlaylist(playlistId);
  if (!playlist) throw new Error("Source playlist no longer exists");
  const removingIds = new Set<string>(
    selections
      .filter((selection) =>
        isStaticPlaylistSelectionCurrent(
          selection,
          playlist,
          downloadTracker.getJob(selection.jobId),
        ),
      )
      .map((selection) => selection.jobId),
  );
  const plans: RemovalPlan[] = [];
  const preparedFiles = new Map<string | null, PreparedRetainedPlaylistFile>();
  const affectedPlaylistIds = new Set<string>();
  const outcomes: StaticPlaylistRemovalOutcome[] = [];
  for (const selection of selections) {
    const job = downloadTracker.getJob(selection.jobId);
    if (!isStaticPlaylistSelectionCurrent(selection, playlist, job)) {
      outcomes.push({
        jobId: selection.jobId,
        status: job ? "failed" : "alreadyAbsent",
        ...(job ? { message: "The selected membership changed. Select the track again." } : {}),
      });
      continue;
    }
    try {
      const owned = job?.playlistType === playlistId;
      const references = owned ? getSharedDownloadReferences(job.id, playlistId) : [];
      const target = references.sort((a, b) => String(a.id).localeCompare(String(b.id)))[0];
      const peer = owned && !target ? replacementPeer(job, removingIds) : null;
      const upgrades: DownloadJob[] = owned
        ? downloadTracker
            .getByPlaylistId(playlistId)
            .filter((entry) => entry.upgradeForJobId === job.id)
        : [];
      if (owned && !target && !peer) {
        await cancelDownloadWorkForJobs([job, ...upgrades], { lock: false });
      } else if (owned && target) {
        restoreDownloadJobCancellations([job.id, ...upgrades.map((entry) => entry.id)]);
      }
      let relocation: PreparedRetainedPlaylistFile | null | undefined = null;
      if (owned && job.status === "done") {
        const otherFileJob = downloadTracker
          .getAll()
          .find(
            (entry) =>
              !removingIds.has(entry.id) &&
              entry.status === "done" &&
              entry.finalPath === job.finalPath,
          );
        const fileTarget = target?.id || otherFileJob?.playlistType;
        if (fileTarget) {
          relocation = preparedFiles.get(job.finalPath);
          if (!relocation) {
            relocation = await prepareRetainedPlaylistFile({
              jobId: job.id,
              sourcePlaylistId: playlistId,
              targetPlaylistId: fileTarget,
              downloadRoot: downloadWorker.downloadRoot,
            });
            preparedFiles.set(job.finalPath, relocation);
          }
        }
      }
      affectedPlaylistIds.add(playlistId);
      if (target) {
        for (const reference of references) affectedPlaylistIds.add(reference.id);
      }
      if (owned && job.status === "done") {
        for (const sameFileJob of downloadTracker
          .getAll()
          .filter((entry) => entry.finalPath === downloadTracker.getJob(job.id)?.finalPath)) {
          affectedPlaylistIds.add(sameFileJob.playlistType);
          for (const reference of getSharedDownloadReferences(sameFileJob.id, playlistId))
            affectedPlaylistIds.add(reference.id);
        }
      }
      plans.push(
        owned
          ? { selection, job, owned, target, peer, upgrades, relocation }
          : { selection, job, owned, target, peer, upgrades, relocation },
      );
      outcomes.push({ jobId: selection.jobId, status: job ? "removed" : "alreadyAbsent" });
    } catch (error) {
      if (job?.playlistType === playlistId && isDownloadJobCancelled(job.id)) {
        const cancelledJobs = [
          job,
          ...downloadTracker
            .getByPlaylistId(playlistId)
            .filter((entry) => entry.upgradeForJobId === job.id),
        ];
        restoreDownloadJobCancellations(cancelledJobs.map((entry) => entry.id));
        for (const entry of cancelledJobs) {
          if (["pending", "downloading"].includes(entry.status))
            downloadTracker.setFailed(
              entry.id,
              "Provider cleanup failed. Retry removal or search again.",
            );
        }
      }
      outcomes.push({
        jobId: selection.jobId,
        status: "failed",
        message: asAppError(error)?.message,
      });
    }
  }
  const recoverCancelledPlans = () => {
    for (const plan of plans) {
      if (plan.owned && !plan.target && !plan.peer) {
        restoreDownloadJobCancellations([plan.job.id, ...plan.upgrades.map((job) => job.id)]);
        for (const job of [plan.job, ...plan.upgrades]) {
          if (["pending", "downloading"].includes(job.status))
            downloadTracker.setFailed(
              job.id,
              "Removal could not be saved after provider cleanup. Retry removal or search again.",
            );
        }
      }
    }
  };
  if (requireAll && outcomes.some((outcome) => outcome.status === "failed")) {
    recoverCancelledPlans();
    throw new Error(outcomes.find((outcome) => outcome.status === "failed")!.message);
  }
  const redirects: ReturnType<typeof transferDownloadOwnershipInTransaction>[] = [];
  try {
    db.transaction(() => {
      for (const relocation of new Set(plans.map((plan) => plan.relocation)))
        commitRetainedPlaylistRelocationInTransaction(relocation);
      for (const plan of plans) {
        if (!plan.owned) continue;
        if (plan.target) {
          for (const job of [plan.job, ...plan.upgrades])
            redirects.push(transferDownloadOwnershipInTransaction(job.id, plan.target.id));
        } else if (plan.peer) {
          redirects.push(replaceAlbumDownloadLeaderInTransaction(plan.job.id, plan.peer.id));
        } else {
          for (const job of [plan.job, ...plan.upgrades]) {
            if (deleteFiles && jobDownloadedItsFile(job)) {
              dbOps.setJSONSetting(`playlistRemovedMedia:${job.id}`, {
                playlistId,
                finalPath: plan.relocation?.finalPath || job.finalPath,
              });
            }
            db.prepare("DELETE FROM playlist_download_jobs WHERE id = ?").run(job.id);
          }
        }
      }
      if (plans.length) {
        const detached = new Set<string | null | undefined>(
          plans.map((plan) => plan.selection.membershipId).filter(Boolean),
        );
        const updated = flowPlaylistConfig.updateStaticPlaylist(playlistId, {
          tracks: playlist.tracks.filter((track) => !detached.has(track.membershipId)),
        });
        if (!updated) throw new Error("Could not persist source membership changes");
      }
      onCommitted?.(outcomes, [...affectedPlaylistIds]);
    })();
  } catch (error) {
    dbOps.invalidateSettingsCache();
    invalidateFlowPlaylistConfigCache();
    recoverCancelledPlans();
    throw error;
  }
  downloadTracker.reconcileCommittedJobs(redirects);
  await cleanupRemovedPlaylistFiles(playlistId);
  return { outcomes, changed: plans.length > 0, affectedPlaylistIds: [...affectedPlaylistIds] };
}

export async function cleanupRemovedPlaylistFiles(playlistId: string) {
  const rows = db
    .prepare<[], Pick<SettingsRow, "value"> & { key: string }>(
      "SELECT key, value FROM settings WHERE key LIKE 'playlistRemovedMedia:%'",
    )
    .all();
  for (const row of rows) {
    const intent = dbHelpers.readJSON(removedMediaSchema, row.value, row.key);
    if (intent && intent.playlistId !== playlistId) continue;
    if (intent) {
      await removePlaylistFileIfUnshared(intent.finalPath, playlistId, {
        downloadRoot: downloadWorker.downloadRoot,
        deleteIfUnshared: true,
      });
    }
    db.prepare("DELETE FROM settings WHERE key = ?").run(row.key);
  }
}

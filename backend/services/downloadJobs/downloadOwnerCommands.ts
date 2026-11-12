import { asAppError } from "../../../lib/errors.ts";
import { cancelTrackDownload, cancelTrackDownloads, retryTrackDownload } from "../albumJobs.ts";
import { syncStaticPlaylistImportHere } from "../importLists/importListSync.ts";
import { queueQualityUpgrade, runQualityUpgradeCheck } from "../qualityProfileService.ts";
import { approveBlockedJob, denyBlockedJob } from "./blockedJobReview.ts";
import { downloadTracker } from "./downloadTracker.ts";
import { followChangedLibraryFiles } from "./fileReuse.ts";
import { DownloadWorker, downloadWorker, startWorkerIfPending } from "./downloadWorker.ts";

type Worker = DownloadWorker;

const owner = () => {
  if (!(downloadWorker instanceof DownloadWorker)) {
    throw new Error("Download worker process requires the download owner");
  }
  return downloadWorker;
};

export const downloadOwnerCommands = {
  start: () => owner().start(),
  startIfPending: () => startWorkerIfPending(),
  stop: () => owner().stop(),
  stopAndDrain: () => owner().stopAndDrain(),
  wake: (...args: Parameters<Worker["wake"]>) => owner().wake(...args),
  async wakeOrStart(delayMs?: number) {
    const worker = owner();
    if (worker.running) worker.wake(delayMs);
    else await worker.start();
    return true;
  },
  researchMissingTracks: (...args: Parameters<Worker["researchMissingTracks"]>) =>
    owner().researchMissingTracks(...args),
  setRetryCyclePaused: (...args: Parameters<Worker["setRetryCyclePaused"]>) =>
    owner().setRetryCyclePaused(...args),
  updateWorkerSettings: (...args: Parameters<Worker["updateWorkerSettings"]>) =>
    owner().updateWorkerSettings(...args),
  checkPlaylistComplete: (...args: Parameters<Worker["checkPlaylistComplete"]>) =>
    owner().checkPlaylistComplete(...args),
  blockPlaylist: (...args: Parameters<Worker["blockPlaylist"]>) => owner().blockPlaylist(...args),
  unblockPlaylist: (...args: Parameters<Worker["unblockPlaylist"]>) =>
    owner().unblockPlaylist(...args),
  waitForPlaylistIdle: (...args: Parameters<Worker["waitForPlaylistIdle"]>) =>
    owner().waitForPlaylistIdle(...args),
  waitForIdle: () => owner().waitForIdle(),
  pruneOrphanedJobState: () => owner().pruneOrphanedJobState(),
  scheduleReuseLinkRepair: (...args: Parameters<Worker["scheduleReuseLinkRepair"]>) =>
    owner().scheduleReuseLinkRepair(...args),
  runQualityUpgradeChecks: (playlistIds: string[], limit = 500) =>
    runQualityUpgradeCheck({ force: true, playlistIds, limit }),
  queueQualityUpgradeForJob: (jobId: string) => queueQualityUpgrade(downloadTracker.getJob(jobId)),
  clearPendingByPlaylist: (playlistType: string) =>
    downloadTracker.clearPendingByPlaylistType(playlistType),
  enqueueManualMissingSelection: (
    ...args: Parameters<typeof downloadTracker.enqueueManualSelection>
  ) => downloadTracker.enqueueManualSelection(...args),
  enqueueManualReplacementSelection: (
    ...args: Parameters<typeof downloadTracker.enqueueManualReplacementSelection>
  ) => downloadTracker.enqueueManualReplacementSelection(...args),
  followChangedLibraryFiles,
  approveBlockedJob,
  denyBlockedJob,
  cancelTrackDownload,
  cancelTrackDownloads,
  retryTrackDownload,
  async syncStaticPlaylistImport(options: Parameters<typeof syncStaticPlaylistImportHere>[0]) {
    try {
      return { ok: true as const, result: await syncStaticPlaylistImportHere(options) };
    } catch (error) {
      const failure = asAppError(error);
      return {
        ok: false as const,
        error: {
          message: failure?.message || "Playlist sync failed",
          code: failure?.code || null,
          statusCode: failure?.statusCode || null,
        },
      };
    }
  },
};

export type DownloadOwnerCommands = typeof downloadOwnerCommands;

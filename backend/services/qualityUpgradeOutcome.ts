import fs from "fs/promises";
import path from "path";
import { logger, safeLogDiagnostic } from "./logger.ts";
import { downloadTracker } from "./downloadJobs/downloadTracker.ts";
import { isAurralOwnedPath, type QualityJob } from "./qualityProfile.ts";
import type { classifyAudioQuality } from "./qualityProfileModel.ts";
import { flowPlaylistConfig } from "./playlists/flowPlaylistConfig.ts";
import { recordTrackJobActivity } from "./aurralHistoryService.ts";
import { adoptLibraryFileIdentity } from "./libraryFiles/fileIdentity.ts";
import { playlistManager } from "./playlists/playlistManager.ts";
import { scheduleLibraryScan } from "./libraryScanWorker.ts";

type AudioQuality = ReturnType<typeof classifyAudioQuality>;

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// An upgrade with the old file's name lands beside it as "07 - Title (2)".
// Once the old file is gone, the upgrade takes its name back. A hardlinked
// old file only loses this link, so its other copy is never touched.
async function takeReplacedFileName(oldPath: string, newPath: string) {
  const directory = path.dirname(oldPath);
  const base = path.basename(oldPath, path.extname(oldPath));
  const extension = path.extname(newPath);
  if (path.dirname(newPath) !== directory) return newPath;
  if (
    !new RegExp(`^${escapeRegExp(base)} \\(\\d+\\)${escapeRegExp(extension)}$`).test(
      path.basename(newPath),
    )
  ) {
    return newPath;
  }
  const target = path.join(directory, `${base}${extension}`);
  try {
    await fs.link(newPath, target);
    await fs.unlink(newPath);
    return target;
  } catch {
    return newPath;
  }
}

export async function finalizeQualityUpgradeSuccess(
  upgradeJob: QualityJob,
  finalPath: string,
  quality: AudioQuality | null | undefined,
) {
  const original = downloadTracker.getJob(upgradeJob.upgradeForJobId);
  if (!original?.finalPath) {
    await fs.rm(finalPath, { force: true }).catch(() => {});
    downloadTracker.removeJob(upgradeJob.id);
    return null;
  }
  const oldPath = original.finalPath;
  const originalDetails = {
    trackName: original.trackName,
    playlistType: original.playlistType,
    qualityTier: original.qualityTier,
  };
  let upgradedPath = finalPath;
  let replaced = false;
  if (oldPath !== finalPath && isAurralOwnedPath(oldPath)) {
    await fs.rm(oldPath, { force: true }).catch(() => {});
    upgradedPath = await takeReplacedFileName(oldPath, finalPath);
    replaced = true;
  }
  const changed = downloadTracker.replaceFinalPath(oldPath, upgradedPath, quality);
  if (replaced) {
    await adoptLibraryFileIdentity(upgradedPath, { previousPath: oldPath }).catch((error) => {
      logger.warn("quality-upgrade", "The Library could not follow an upgraded file", {
        jobId: upgradeJob.id,
        reason: safeLogDiagnostic(error),
      });
    });
  }
  downloadTracker.removeJob(upgradeJob.id);
  const playlistIds = [
    ...changed.map((job) => job.playlistType),
    ...flowPlaylistConfig.getStaticPlaylistIdsUsingJobs(changed.map((job) => job.id)),
  ];
  playlistManager.requestPlaylistSync(playlistIds);
  scheduleLibraryScan({ includeLidarr: false, changedPaths: [oldPath, upgradedPath] });
  recordTrackJobActivity({
    jobId: upgradeJob.id,
    trackName: originalDetails.trackName,
    artistName: original.artistName,
    albumName: original.albumName,
    albumMbid: original.albumMbid,
    playlistId: originalDetails.playlistType,
    title: upgradeJob.manualReplacementSearch
      ? `Re-searched ${originalDetails.trackName}`
      : `Upgraded ${originalDetails.trackName}`,
    subtitle: upgradeJob.manualReplacementSearch
      ? "A replacement recording was added"
      : `${originalDetails.qualityTier || "Unknown"} → ${quality?.tier || "Unknown"}`,
    status: "completed",
    statusLabel: upgradeJob.manualReplacementSearch ? "Replaced" : "Upgraded",
    downloadSource: upgradeJob.downloadSource,
    downloadClient: upgradeJob.downloadClient,
  });
  return null;
}

export async function finalizeQualityUpgradeFailure(
  upgradeJob: QualityJob,
  message?: string | null,
) {
  const original = downloadTracker.getJob(upgradeJob?.upgradeForJobId);
  if (original && !upgradeJob?.manualReplacementSearch) {
    downloadTracker.markQualityUpgradeChecked(original.id);
  }
  if (upgradeJob?.id) downloadTracker.removeJob(upgradeJob.id);
  if (!original) return;
  recordTrackJobActivity({
    jobId: upgradeJob.id,
    trackName: original.trackName,
    artistName: original.artistName,
    albumName: original.albumName,
    albumMbid: original.albumMbid,
    playlistId: original.playlistType,
    title: upgradeJob.manualReplacementSearch
      ? `No replacement found for ${original.trackName}`
      : `No upgrade found for ${original.trackName}`,
    subtitle: String(
      message ||
        (upgradeJob.manualReplacementSearch
          ? "No replacement file was available"
          : "No better file was available"),
    ),
    status: upgradeJob.manualReplacementSearch ? "failed" : "unchanged",
    statusLabel: upgradeJob.manualReplacementSearch ? "No replacement" : "No upgrade",
    downloadSource: upgradeJob.downloadSource,
    downloadClient: upgradeJob.downloadClient,
  });
}

import fs from "fs/promises";
import path from "path";
import { parseFile } from "music-metadata";
import { dbOps } from "../db/helpers/index.js";
import { resolvePlaylistRoot, isPathInsideRoot, PLAYLIST_LIBRARY_DIR } from "./playlistPaths.js";
import { getEnabledDownloadSources } from "./downloadSourceService.js";
import { downloadTracker } from "./weeklyFlow/weeklyFlowDownloadTracker.js";
import {
  classifyAudioQuality,
  getQualityState,
  getQualityTier,
  isQualityUpgrade,
  normalizeQualityProfile,
} from "./qualityProfileModel.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export function getQualityProfile() {
  const settings = dbOps.getSettings();
  return normalizeQualityProfile(settings.qualityProfile, settings.integrations?.slskd);
}

export function isAurralOwnedPath(filePath) {
  if (!filePath) return false;
  const libraryRoot = path.join(resolvePlaylistRoot(), PLAYLIST_LIBRARY_DIR);
  return isPathInsideRoot(path.resolve(filePath), path.resolve(libraryRoot));
}

export function decorateJobQuality(job, profile = getQualityProfile()) {
  if (!job || job.upgradeForJobId) return job;
  const quality = {
    tier: job.qualityTier || null,
    format: job.qualityFormat || null,
    bitrateKbps: job.qualityBitrateKbps ?? null,
    sampleRate: job.qualitySampleRate ?? null,
    bitDepth: job.qualityBitDepth ?? null,
  };
  const owned = isAurralOwnedPath(job.finalPath);
  return {
    ...job,
    qualityOwned: owned,
    qualityState: job.status === "done"
      ? owned
        ? getQualityState(quality, profile)
        : "external"
      : null,
    qualityLabel: getQualityTier(quality.tier)?.label || "Unknown",
  };
}

export function validateParsedQuality(parsed, filePath, { upgradeForJobId = null } = {}) {
  const profile = getQualityProfile();
  const quality = classifyAudioQuality(parsed, filePath);
  const enabled = profile.enabled.includes(quality.tier);
  if (!quality.tier || !enabled) {
    return {
      valid: false,
      quality,
      reason: quality.tier
        ? `quality-below-floor: ${quality.tier}`
        : "quality-unknown: could not classify final file",
    };
  }
  if (upgradeForJobId) {
    const current = downloadTracker.getJob(upgradeForJobId);
    if (!current || !isQualityUpgrade(quality, current.qualityTier, profile)) {
      return {
        valid: false,
        quality,
        reason: `quality-not-an-upgrade: current=${current?.qualityTier || "unknown"}, candidate=${quality.tier}`,
      };
    }
  }
  return { valid: true, quality, reason: null };
}

async function readQuality(filePath) {
  const parsed = await parseFile(filePath, { duration: true });
  return classifyAudioQuality(parsed, filePath);
}

export async function classifyQualityJob(job) {
  if (
    !job?.finalPath ||
    job.status !== "done" ||
    job.upgradeForJobId
  ) {
    return null;
  }
  let quality;
  try {
    quality = await readQuality(job.finalPath);
  } catch {
    quality = {
      tier: null,
      format: null,
      bitrateKbps: null,
      sampleRate: null,
      bitDepth: null,
    };
  }
  const checkedAt = Date.now();
  for (const linked of downloadTracker.getAll()) {
    if (linked.status === "done" && linked.finalPath === job.finalPath) {
      downloadTracker.updateQuality(linked.id, { ...quality, checkedAt });
    }
  }
  return quality;
}

export async function reclassifyQualityJobs({ enqueue = false } = {}) {
  const seen = new Set();
  let classified = 0;
  for (const job of downloadTracker.getAll()) {
    if (
      !job?.finalPath ||
      job.status !== "done" ||
      job.upgradeForJobId
    ) {
      continue;
    }
    const filePath = path.resolve(job.finalPath);
    if (seen.has(filePath)) continue;
    seen.add(filePath);
    await classifyQualityJob(job);
    classified += 1;
  }
  const queued = enqueue ? await runQualityUpgradeCheck({ force: true }) : 0;
  return { classified, queued };
}

function hasUpgradeSource() {
  return getEnabledDownloadSources().some(
    (source) => source.id === "slskd" || source.id === "usenet",
  );
}

export async function queueQualityUpgrade(job) {
  if (!job?.id || job.status !== "done" || !isAurralOwnedPath(job.finalPath)) {
    return "ineligible";
  }
  if (!job.qualityCheckedAt) await classifyQualityJob(job);
  const current = downloadTracker.getJob(job.id);
  if (getQualityState({ tier: current?.qualityTier }, getQualityProfile()) === "preferred") {
    return "ineligible";
  }
  if (!hasUpgradeSource()) return "ineligible";
  if (downloadTracker.findActiveUpgradeJob(current)) return "already-queued";
  const upgradeJobId = downloadTracker.addUpgradeJob(current);
  if (!upgradeJobId) return "ineligible";
  if (!downloadTracker.enqueueDownloadPipeline(upgradeJobId)) {
    downloadTracker.removeJob(upgradeJobId);
    return "ineligible";
  }
  downloadTracker.markQualityUpgradeChecked(current.id);
  return "queued";
}

export async function runQualityUpgradeCheck({ force = false, playlistId = null, limit = 25 } = {}) {
  const profile = getQualityProfile();
  if (!force && !profile.automaticUpgrades) return 0;
  const dueBefore = Date.now() - profile.intervalDays * DAY_MS;
  const seen = new Set();
  let queued = 0;
  for (const job of downloadTracker.getAll()) {
    if (queued >= limit) break;
    if (job.status !== "done" || !job.finalPath || job.upgradeForJobId) continue;
    if (playlistId && job.playlistType !== playlistId) continue;
    const filePath = path.resolve(job.finalPath);
    if (seen.has(filePath)) continue;
    seen.add(filePath);
    if (!isAurralOwnedPath(filePath)) continue;
    if (!job.qualityCheckedAt) await classifyQualityJob(job);
    const current = downloadTracker.getJob(job.id);
    if (getQualityState({ tier: current?.qualityTier }, profile) === "preferred") continue;
    if (!force && Number(current?.qualityUpgradeCheckedAt || 0) > dueBefore) continue;
    if (await queueQualityUpgrade(current) === "queued") queued += 1;
  }
  return queued;
}

export async function finalizeQualityUpgradeSuccess(upgradeJob, finalPath, quality) {
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
  const changed = downloadTracker.replaceFinalPath(oldPath, finalPath, quality);
  downloadTracker.removeJob(upgradeJob.id);
  const playlistIds = [...new Set(changed.map((job) => job.playlistType).filter(Boolean))];
  const { playlistManager } = await import("./weeklyFlow/weeklyFlowPlaylistManager.js");
  for (const playlistId of playlistIds) await playlistManager.refreshPlaylist(playlistId);
  playlistManager.scheduleScanLibrary();
  if (oldPath !== finalPath && isAurralOwnedPath(oldPath)) {
    await fs.rm(oldPath, { force: true }).catch(() => {});
  }
  const { recordTrackJobActivity } = await import("./aurralHistoryService.js");
  recordTrackJobActivity({
    jobId: upgradeJob.id,
    trackName: originalDetails.trackName,
    artistName: original.artistName,
    albumName: original.albumName,
    playlistId: originalDetails.playlistType,
    title: `Upgraded ${originalDetails.trackName}`,
    subtitle: `${originalDetails.qualityTier || "Unknown"} → ${quality?.tier || "Unknown"}`,
    status: "completed",
    statusLabel: "Upgraded",
    downloadSource: upgradeJob.downloadSource,
    downloadClient: upgradeJob.downloadClient,
  });
  return null;
}

export async function finalizeQualityUpgradeFailure(upgradeJob, message) {
  const original = downloadTracker.getJob(upgradeJob?.upgradeForJobId);
  if (original) downloadTracker.markQualityUpgradeChecked(original.id);
  if (upgradeJob?.id) downloadTracker.removeJob(upgradeJob.id);
  if (!original) return;
  const { recordTrackJobActivity } = await import("./aurralHistoryService.js");
  recordTrackJobActivity({
    jobId: upgradeJob.id,
    trackName: original.trackName,
    artistName: original.artistName,
    albumName: original.albumName,
    playlistId: original.playlistType,
    title: `No upgrade found for ${original.trackName}`,
    subtitle: String(message || "No better file was available"),
    status: "failed",
    statusLabel: "No upgrade",
    downloadSource: upgradeJob.downloadSource,
    downloadClient: upgradeJob.downloadClient,
  });
}

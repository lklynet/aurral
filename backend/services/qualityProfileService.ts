import fs from "fs/promises";
import path from "path";
import { parseFile } from "music-metadata";
import { db } from "../config/db-sqlite.ts";
import { dbOps } from "../db/helpers/index.ts";
import type { LibraryMediaFilesRow } from "../db/rows.ts";
import { indexUnmonitoredJobs } from "./aurralUnmonitoredJobs.ts";
import { resolveDownloadRoot, isPathInsideRoot } from "./downloadPaths.ts";
import { getEnabledDownloadSources } from "./downloadSourceService.ts";
import { logger, safeLogDiagnostic } from "./logger.ts";
import { downloadTracker, type DownloadJob } from "./downloadJobs/downloadTracker.ts";
import { isPlaylistOwnerActive } from "./downloadJobs/playlistOwnerStatus.ts";
import { isPipelinePayloadActive } from "./downloadJobs/downloadCancellation.ts";
import {
  classifyAudioQuality,
  getQualityState,
  getQualityTier,
  isQualityUpgrade,
  normalizeQualityProfile,
} from "./qualityProfileModel.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

type QualityJob = Pick<
  DownloadJob,
  | "id"
  | "status"
  | "finalPath"
  | "upgradeForJobId"
  | "albumMbid"
  | "artistName"
  | "trackName"
  | "albumName"
  | "playlistId"
  | "playlistType"
  | "playlistGeneration"
  | "downloadSource"
  | "downloadClient"
  | "manualReplacementSearch"
  | "qualityTier"
  | "qualityFormat"
  | "qualityBitrateKbps"
  | "qualitySampleRate"
  | "qualityBitDepth"
  | "qualityCheckedAt"
  | "qualityUpgradeCheckedAt"
>;

type AudioQuality = ReturnType<typeof classifyAudioQuality>;
type QualityProfile = ReturnType<typeof getQualityProfile>;

interface StoredQuality {
  format?: string | null;
  bitrate?: number | null;
  sampleRate?: number | null;
  bitsPerSample?: number | null;
}

interface UpgradePlan {
  status?: string;
  sourceJobId?: string;
  context?: object;
}

interface UpgradeCandidate {
  owner: string;
  add: () => Promise<UpgradePlan>;
}

type LibraryUpgradeRow = Pick<
  LibraryMediaFilesRow,
  "path" | "track_id" | "album_id" | "quality_json"
> & {
  album_mbid: string | null;
};

export function getQualityProfile() {
  const settings = dbOps.getSettings();
  return normalizeQualityProfile(settings.qualityProfile, settings.integrations?.slskd);
}

export function isAurralOwnedPath(filePath: string | null | undefined) {
  if (!filePath) return false;
  return isPathInsideRoot(path.resolve(filePath), path.resolve(resolveDownloadRoot()));
}

function getJobQuality(job: QualityJob, profile: QualityProfile) {
  const quality = {
    tier: job.qualityTier || null,
    format: job.qualityFormat || null,
    bitrateKbps: job.qualityBitrateKbps ?? null,
    sampleRate: job.qualitySampleRate ?? null,
    bitDepth: job.qualityBitDepth ?? null,
  };
  const owned = isAurralOwnedPath(job.finalPath);
  return {
    qualityOwned: owned,
    qualityState:
      job.status === "done" ? (owned ? getQualityState(quality, profile) : "external") : null,
    qualityLabel: getQualityTier(quality.tier)?.label || "Unknown",
  };
}

export function decorateJobQuality<T extends QualityJob>(job: T, profile = getQualityProfile()) {
  return { ...job, ...(job.upgradeForJobId ? {} : getJobQuality(job, profile)) };
}

export function validateParsedQuality(
  parsed: Parameters<typeof classifyAudioQuality>[0],
  filePath: string,
  {
    upgradeForJobId = null,
    manualReplacementSearch = false,
    manualSelection = false,
  }: {
    upgradeForJobId?: string | null;
    manualReplacementSearch?: boolean;
    manualSelection?: boolean;
  } = {},
) {
  const profile = getQualityProfile();
  const quality = classifyAudioQuality(parsed, filePath);
  const enabled = quality.tier !== null && profile.enabled.includes(quality.tier);
  if (!quality.tier || (!enabled && !manualSelection)) {
    return {
      valid: false,
      quality,
      reason: quality.tier
        ? `quality-below-floor: ${quality.tier}`
        : "quality-unknown: could not classify final file",
    };
  }
  if (upgradeForJobId && !manualReplacementSearch) {
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

async function readQuality(filePath: string) {
  const parsed = await parseFile(filePath, { duration: true });
  return classifyAudioQuality(parsed, filePath);
}

export async function classifyQualityJob(job: QualityJob | null | undefined) {
  if (!job?.finalPath || job.status !== "done" || job.upgradeForJobId) {
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

export async function reclassifyQualityJobs({ enqueue = false }: { enqueue?: boolean } = {}) {
  const seen = new Set();
  let classified = 0;
  for (const job of downloadTracker.getAll()) {
    if (!job?.finalPath || job.status !== "done" || job.upgradeForJobId) {
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

const UPGRADE_SOURCE_IDS = new Set(["slskd", "usenet", "deemix"]);

function hasUpgradeSource() {
  return getEnabledDownloadSources().some((source) => UPGRADE_SOURCE_IDS.has(source.id));
}

const keptFilePathsStmt = db
  .prepare<[], string>(`
  SELECT media.path FROM library_media_files AS media
  JOIN library_tracks AS track ON track.id = media.track_id
  WHERE track.keep_file = 1
`)
  .pluck();

const isKeptFile = (filePath: string) => {
  const resolved = path.resolve(filePath);
  return keptFilePathsStmt.all().some((keptPath) => path.resolve(keptPath) === resolved);
};

async function readUpgradeSearchContext(job: QualityJob) {
  try {
    const { resolveTrackSearchContext } = await import("./downloadJobs/trackSearchContext.ts");
    return await resolveTrackSearchContext(job);
  } catch (error) {
    logger.warn("downloads", "Could not read release details for a quality upgrade", {
      jobId: job.id,
      reason: safeLogDiagnostic(error),
    });
    return {};
  }
}

function upgradeBlocker(job: QualityJob | null | undefined) {
  if (!job?.id || job.status !== "done" || !isAurralOwnedPath(job.finalPath)) return "ineligible";
  if (getQualityState({ tier: job.qualityTier }, getQualityProfile()) === "preferred")
    return "ineligible";
  if (!hasUpgradeSource()) return "ineligible";
  if (isKeptFile(job.finalPath!)) return "kept";
  if (downloadTracker.findActiveUpgradeJob(job)) return "already-queued";
  const playlistId = job.playlistId || job.playlistType;
  if (!isPipelinePayloadActive({ playlistId, playlistGeneration: job.playlistGeneration }))
    return "ineligible";
  return null;
}

// Returns what adding the upgrade of a done track needs, or why it has none.
async function prepareQualityUpgrade(job: QualityJob | null | undefined) {
  if (!job?.id || job.status !== "done" || !isAurralOwnedPath(job.finalPath)) {
    return { status: "ineligible" };
  }
  if (!job.qualityCheckedAt) await classifyQualityJob(job);
  const current = downloadTracker.getJob(job.id);
  const blocker = upgradeBlocker(current);
  if (blocker) return { status: blocker };
  return { sourceJobId: current!.id, context: await readUpgradeSearchContext(current!) };
}

async function addUpgradesAtOnce(
  prepared: UpgradePlan[],
  { aheadOfWaiting = false }: { aheadOfWaiting?: boolean } = {},
) {
  const { recordTrackJobQueued } = await import("./aurralHistoryService.ts");
  const queuedIds: string[] = [];
  const statuses = prepared.map(({ sourceJobId, context }) => {
    const source = downloadTracker.getJob(sourceJobId);
    const blocker = upgradeBlocker(source);
    if (blocker) return blocker;
    const upgradeJobId = downloadTracker.addUpgradeJob(source);
    if (!upgradeJobId) return "ineligible";
    downloadTracker.updateMetadata(upgradeJobId, context);
    downloadTracker.markQualityUpgradeChecked(sourceJobId!);
    recordTrackJobQueued(downloadTracker.getJob(upgradeJobId), null, {
      fromQuality: getQualityTier(source?.qualityTier)?.label ?? null,
    });
    queuedIds.push(upgradeJobId);
    return "queued";
  });
  if (aheadOfWaiting) downloadTracker.queueFirst(queuedIds);
  if (queuedIds.length > 0) {
    const { wakeDownloadWorker } = await import("./downloadJobs/mutationGuards.ts");
    await wakeDownloadWorker();
  }
  return statuses;
}

export async function queueQualityUpgrade(job: QualityJob | null | undefined) {
  const prepared = await prepareQualityUpgrade(job);
  if (prepared.status) return prepared.status;
  const [status] = await addUpgradesAtOnce([prepared], { aheadOfWaiting: true });
  return status;
}

function classifyLibraryFileQuality(file: Pick<LibraryMediaFilesRow, "path" | "quality_json">) {
  let stored: StoredQuality = {};
  try {
    stored = JSON.parse(file.quality_json || "{}") || {};
  } catch {}
  return classifyAudioQuality(
    {
      format: {
        codec: stored.format,
        bitrate: stored.bitrate,
        sampleRate: stored.sampleRate,
        bitsPerSample: stored.bitsPerSample,
      },
    },
    file.path,
  );
}

// Monitored Library tracks whose file Aurral did not download have no job
// yet. Each one below the cutoff gets the Library job an upgrade replaces.
function listLibraryUpgradeCandidates(profile: QualityProfile) {
  const jobPaths = new Set(
    downloadTracker
      .getAll()
      .filter((job: QualityJob) => job.status === "done" && job.finalPath && !job.upgradeForJobId)
      .map((job: QualityJob) => path.resolve(job.finalPath!)),
  );
  const candidates = [];
  for (const file of db
    .prepare<[], LibraryUpgradeRow>(
      `SELECT media.path, media.track_id, media.album_id, media.quality_json,
       COALESCE(album.release_group_mbid, album.mbid) AS album_mbid
     FROM library_media_files AS media
     JOIN library_tracks AS track ON track.id = media.track_id
     LEFT JOIN library_albums AS album ON album.id = media.album_id
     WHERE media.source = 'aurral' AND media.available = 1
       AND track.monitored = 1 AND track.keep_file = 0
     ORDER BY media.id`,
    )
    .iterate()) {
    const filePath = path.resolve(file.path);
    if (jobPaths.has(filePath) || !isAurralOwnedPath(filePath)) continue;
    const quality = classifyLibraryFileQuality(file);
    if (getQualityState(quality, profile) === "preferred") continue;
    candidates.push({
      trackId: file.track_id,
      albumId: file.album_id,
      albumMbid: file.album_mbid,
      quality,
    });
  }
  return candidates;
}

// The tracks a check may upgrade, by album, each with how to add its upgrade.
// A track whose owner is not active waits until the owner is again.
async function listUpgradeCandidatesByAlbum({
  force,
  owners,
  profile,
}: {
  force: boolean;
  owners: Set<string> | null;
  profile: QualityProfile;
}) {
  const dueBefore = Date.now() - profile.intervalDays * DAY_MS;
  const isUnmonitored = indexUnmonitoredJobs();
  const keptFiles = new Set(keptFilePathsStmt.all().map((filePath) => path.resolve(filePath)));
  const albums = new Map<string, UpgradeCandidate[]>();
  const collect = (albumKey: string, candidate: UpgradeCandidate) =>
    albums.set(albumKey, [...(albums.get(albumKey) || []), candidate]);
  const seen = new Set();
  for (const job of downloadTracker.getAll()) {
    if (job.status !== "done" || !job.finalPath || job.upgradeForJobId) continue;
    if (owners && !owners.has(job.playlistType)) continue;
    if (!isPlaylistOwnerActive(job.playlistId || job.playlistType)) continue;
    const filePath = path.resolve(job.finalPath);
    if (seen.has(filePath)) continue;
    seen.add(filePath);
    if (!isAurralOwnedPath(filePath) || isUnmonitored(job) || keptFiles.has(filePath)) continue;
    collect(job.albumMbid || `job:${job.id}`, {
      owner: job.playlistType,
      add: async () => {
        if (!job.qualityCheckedAt) await classifyQualityJob(job);
        const current = downloadTracker.getJob(job.id);
        if (getQualityState({ tier: current?.qualityTier }, profile) === "preferred") return {};
        if (!force && Number(current?.qualityUpgradeCheckedAt || 0) > dueBefore) return {};
        return prepareQualityUpgrade(current);
      },
    });
  }
  if ((!owners || owners.has("library")) && hasUpgradeSource()) {
    const { resolveAurralOwnedTrackJob } = await import("./libraryTrackResearchService.ts");
    for (const candidate of listLibraryUpgradeCandidates(profile)) {
      collect(candidate.albumMbid || `track:${candidate.trackId}`, {
        owner: "library",
        add: async () => {
          const job = resolveAurralOwnedTrackJob({
            trackId: candidate.trackId,
            albumId: candidate.albumId,
          });
          return job ? prepareQualityUpgrade(job) : {};
        },
      });
    }
  }
  return albums.values();
}

// One check covers every owner it is given, `limit` upgrades each, or
// `limit` in all when it is given none.
export async function runQualityUpgradeCheck({
  force = false,
  playlistIds = null,
  limit = 25,
}: { force?: boolean; playlistIds?: string[] | null; limit?: number } = {}) {
  const profile = getQualityProfile();
  if (!force && !profile.automaticUpgrades) return 0;
  const owners = playlistIds ? new Set(playlistIds) : null;
  const addedByOwner = new Map<string | null, number>();
  let queued = 0;
  for (const candidates of await listUpgradeCandidatesByAlbum({ force, owners, profile })) {
    const prepared: UpgradePlan[] = [];
    for (const { owner, add } of candidates) {
      const counted = owners ? owner : null;
      if ((addedByOwner.get(counted) || 0) >= limit) continue;
      const upgrade = await add();
      if (!upgrade.sourceJobId) continue;
      prepared.push(upgrade);
      addedByOwner.set(counted, (addedByOwner.get(counted) || 0) + 1);
    }
    queued += (await addUpgradesAtOnce(prepared)).filter((status) => status === "queued").length;
  }
  return queued;
}

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
    const { createPlaybackDeletionGuard } = await import("./playback/playbackFileRetention.ts");
    if (await createPlaybackDeletionGuard().canDelete(oldPath)) {
      await fs.rm(oldPath, { force: true }).catch(() => {});
      upgradedPath = await takeReplacedFileName(oldPath, finalPath);
      replaced = true;
    }
  }
  const changed = downloadTracker.replaceFinalPath(oldPath, upgradedPath, quality);
  if (replaced) {
    const { adoptLibraryFileIdentity } = await import("./libraryFiles/fileIdentity.ts");
    await adoptLibraryFileIdentity(upgradedPath, { previousPath: oldPath }).catch((error) => {
      logger.warn("quality-upgrade", "The Library could not follow an upgraded file", {
        jobId: upgradeJob.id,
        reason: safeLogDiagnostic(error),
      });
    });
  }
  downloadTracker.removeJob(upgradeJob.id);
  const playlistIds = [...new Set(changed.map((job) => job.playlistType).filter(Boolean))];
  const { playlistManager } = await import("./playlists/playlistManager.ts");
  playlistManager.requestPlaylistSync(playlistIds);
  playlistManager.scheduleScanLibrary();
  const { recordTrackJobActivity } = await import("./aurralHistoryService.ts");
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
  const { recordTrackJobActivity } = await import("./aurralHistoryService.ts");
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
    status: "failed",
    statusLabel: upgradeJob.manualReplacementSearch ? "No replacement" : "No upgrade",
    downloadSource: upgradeJob.downloadSource,
    downloadClient: upgradeJob.downloadClient,
  });
}

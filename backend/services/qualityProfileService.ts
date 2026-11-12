import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import path from "path";
import { parseFile } from "music-metadata";
import { db } from "../config/db-sqlite.ts";
import type { LibraryMediaFilesRow } from "../db/rows.ts";
import { indexUnmonitoredJobs } from "./unmonitoredJobs.ts";
import { getEnabledDownloadSources, upgradeSourceIds } from "./downloadSourceService.ts";
import { logger, safeLogDiagnostic } from "./logger.ts";
import { downloadTracker } from "./downloadJobs/downloadTracker.ts";
import { isPlaylistOwnerActive } from "./downloadJobs/playlistOwnerStatus.ts";
import { isPipelinePayloadActive } from "./downloadJobs/downloadCancellation.ts";
import {
  classifyLibraryFileQuality,
  getQualityProfile,
  isAurralOwnedPath,
  type QualityJob,
  type QualityProfile,
} from "./qualityProfile.ts";
import { readOnlyFolderPaths } from "./libraryFolders.ts";
import { classifyAudioQuality, getQualityState, getQualityTier } from "./qualityProfileModel.ts";
import { recordTrackJobQueued } from "./aurralHistoryService.ts";
import { resolveTrackSearchContext } from "./downloadJobs/trackSearchContext.ts";
import { resolveAurralOwnedTrackJob } from "./libraryTrackResearchService.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

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

async function readQuality(filePath: string) {
  const parsed = await parseFile(filePath, { duration: true });
  return classifyAudioQuality(parsed, filePath);
}

export async function classifyQualityJob(job: QualityJob | null | undefined) {
  if (job?.status !== "done" || job.upgradeForJobId) {
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
    if (job?.status !== "done" || job.upgradeForJobId) {
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
  const ids = upgradeSourceIds();
  return getEnabledDownloadSources().some((source) => ids.includes(source.id));
}

async function readUpgradeSearchContext(job: QualityJob) {
  try {
    return await resolveTrackSearchContext(job);
  } catch (error) {
    logger.warn("downloads", "Could not read release details for a quality upgrade", {
      jobId: job.id,
      reason: safeLogDiagnostic(error),
    });
    return {};
  }
}

function upgradeBlocker(
  job: QualityJob | null | undefined,
  isUnmonitored = indexUnmonitoredJobs(),
) {
  if (!job?.id || job.status !== "done" || !isAurralOwnedPath(job.finalPath)) return "ineligible";
  if (getQualityState({ tier: job.qualityTier }, getQualityProfile()) === "preferred")
    return "ineligible";
  if (!hasUpgradeSource()) return "ineligible";
  if (isUnmonitored(job)) return "unmonitored";
  if (downloadTracker.findActiveUpgradeJob(job)) return "already-queued";
  const playlistId = job.playlistId || job.playlistType;
  if (!isPipelinePayloadActive({ playlistId, playlistGeneration: job.playlistGeneration }))
    return "ineligible";
  return null;
}

// Returns what adding the upgrade of a done track needs, or why it has none.
async function prepareQualityUpgrade(
  job: QualityJob | null | undefined,
  isUnmonitored = indexUnmonitoredJobs(),
) {
  if (!job?.id || job.status !== "done" || !isAurralOwnedPath(job.finalPath)) {
    return { status: "ineligible" };
  }
  if (!job.qualityCheckedAt) await classifyQualityJob(job);
  const current = downloadTracker.getJob(job.id);
  const blocker = upgradeBlocker(current, isUnmonitored);
  if (blocker) return { status: blocker };
  return { sourceJobId: current!.id, context: await readUpgradeSearchContext(current!) };
}

async function addUpgradesAtOnce(
  prepared: UpgradePlan[],
  { aheadOfWaiting = false }: { aheadOfWaiting?: boolean } = {},
) {
  const queuedIds: string[] = [];
  const isUnmonitored = indexUnmonitoredJobs();
  const statuses = prepared.map(({ sourceJobId, context }) => {
    const source = downloadTracker.getJob(sourceJobId);
    const blocker = upgradeBlocker(source, isUnmonitored);
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
  return statuses;
}

export async function queueQualityUpgrade(job: QualityJob | null | undefined) {
  const prepared = await prepareQualityUpgrade(job);
  if (prepared.status) return prepared.status;
  const [status] = await addUpgradesAtOnce([prepared], { aheadOfWaiting: true });
  return status;
}

// Monitored Library tracks whose file Aurral did not download have no job
// yet. Each one below the cutoff gets the Library job an upgrade replaces.
function listLibraryUpgradeCandidates(profile: QualityProfile) {
  const jobPaths = new Set(
    downloadTracker
      .getAll()
      .filter((job: QualityJob) => job.status === "done" && !job.upgradeForJobId)
      .map((job: QualityJob) => path.resolve(job.finalPath!)),
  );
  const candidates = [];
  const readOnlyRoots = readOnlyFolderPaths();
  for (const file of db
    .prepare<[], LibraryUpgradeRow>(
      `SELECT media.path, media.track_id, media.album_id, media.quality_json,
       COALESCE(album.release_group_mbid, album.mbid) AS album_mbid
     FROM library_media_files AS media
     JOIN library_tracks AS track ON track.id = media.track_id
     LEFT JOIN library_albums AS album ON album.id = media.album_id
     WHERE media.source = 'aurral' AND media.available = 1
       AND track.monitored = 1
     ORDER BY media.id`,
    )
    .iterate()) {
    const filePath = path.resolve(file.path);
    if (jobPaths.has(filePath) || !isAurralOwnedPath(filePath, readOnlyRoots)) continue;
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
  isUnmonitored,
}: {
  force: boolean;
  owners: Set<string> | null;
  profile: QualityProfile;
  isUnmonitored: ReturnType<typeof indexUnmonitoredJobs>;
}) {
  const dueBefore = Date.now() - profile.intervalDays * DAY_MS;
  const albums = new Map<string, UpgradeCandidate[]>();
  const collect = (albumKey: string, candidate: UpgradeCandidate) =>
    albums.set(albumKey, [...(albums.get(albumKey) || []), candidate]);
  const seen = new Set();
  const readOnlyRoots = readOnlyFolderPaths();
  for (const job of downloadTracker.getAll()) {
    if (job.status !== "done" || job.upgradeForJobId) continue;
    if (owners && !owners.has(job.playlistType)) continue;
    if (!isPlaylistOwnerActive(job.playlistId || job.playlistType)) continue;
    const filePath = path.resolve(job.finalPath);
    if (seen.has(filePath)) continue;
    seen.add(filePath);
    if (!isAurralOwnedPath(filePath, readOnlyRoots) || isUnmonitored(job)) continue;
    collect(job.albumMbid || `job:${job.id}`, {
      owner: job.playlistType,
      add: async () => {
        if (!job.qualityCheckedAt) await classifyQualityJob(job);
        const current = downloadTracker.getJob(job.id);
        if (getQualityState({ tier: current?.qualityTier }, profile) === "preferred") return {};
        if (!force && Number(current?.qualityUpgradeCheckedAt || 0) > dueBefore) return {};
        return prepareQualityUpgrade(current, isUnmonitored);
      },
    });
  }
  if ((!owners || owners.has("library")) && hasUpgradeSource()) {
    for (const candidate of listLibraryUpgradeCandidates(profile)) {
      collect(candidate.albumMbid || `track:${candidate.trackId}`, {
        owner: "library",
        add: async () => {
          const job = resolveAurralOwnedTrackJob({
            trackId: candidate.trackId,
            albumId: candidate.albumId,
          });
          return job ? prepareQualityUpgrade(job, isUnmonitored) : {};
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
  const isUnmonitored = indexUnmonitoredJobs();
  let queued = 0;
  for (const candidates of await listUpgradeCandidatesByAlbum({
    force,
    owners,
    profile,
    isUnmonitored,
  })) {
    await yieldToEventLoop();
    const prepared: UpgradePlan[] = [];
    for (const { owner, add } of candidates) {
      const counted = owners ? owner : null;
      if ((addedByOwner.get(counted) || 0) >= limit) continue;
      const upgrade = await add();
      if (!upgrade.sourceJobId) continue;
      prepared.push(upgrade);
      addedByOwner.set(counted, (addedByOwner.get(counted) || 0) + 1);
    }
    if (prepared.length === 0) continue;
    queued += (await addUpgradesAtOnce(prepared)).filter((status) => status === "queued").length;
  }
  return queued;
}

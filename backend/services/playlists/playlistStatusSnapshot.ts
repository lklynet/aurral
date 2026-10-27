import { getPlaylistArtworkRevisions } from "../playlistArtworkState.ts";
import { createHash } from "node:crypto";
import { downloadTracker } from "../downloadJobs/downloadTracker.ts";
import type { DownloadJob } from "../downloadJobs/downloadTracker.ts";
import { downloadWorker } from "../downloadJobs/downloadWorker.ts";
import {
  getDownloadOwnerStatus,
  isDownloadOwnerProcess,
} from "../downloadJobs/downloadOwnerClient.ts";
import type { DownloadOwnerStatus } from "../downloadJobs/downloadOwnerClient.ts";
import { slskdClient } from "../slskdClient.ts";
import {
  buildPlaylistTrackIdentity,
  flowPlaylistConfig,
  invalidateFlowPlaylistConfigCache,
} from "./flowPlaylistConfig.ts";
import type { FlowConfig, StaticPlaylist } from "./flowPlaylistConfig.ts";
import { playlistOperationQueue } from "./playlistOperationQueue.ts";
import { getPlaylistOperationWorkerStatus } from "./playlistOperationWorker.ts";
import { getDownloadClient } from "../download/downloadClientSettings.ts";
import { dbOps, userOps } from "../../db/helpers/index.ts";
import { db, getDatabaseRevision } from "../../config/db-sqlite.ts";
import type { RequestUser } from "../../middleware/requestUser.ts";
import type { SettingsRow } from "../../db/rows.ts";

const playlistSettingsStmt = db.prepare<[], Pick<SettingsRow, "value"> & { key: string }>(
  "SELECT key, value FROM settings WHERE key IN ('flows', 'sharedPlaylists') ORDER BY key",
);
type MembershipSummary = {
  trackIdentities: ReturnType<typeof collectPlaylistTrackIdentities>;
  trackEntries: ReturnType<typeof collectPlaylistTrackEntries>;
};
const membershipCache = new Map<string, MembershipSummary>();
const MEMBERSHIP_CACHE_LIMIT = 128;
let cachedSettings: string | null = null;
let cachedJobRevision: ReturnType<typeof downloadTracker.getRevision> | null = null;
let cachedDatabaseRevision: string | null = null;
let cacheCleanupTimer: ReturnType<typeof setTimeout> | null = null;

export function clearPlaylistStatusCache() {
  if (cacheCleanupTimer) clearTimeout(cacheCleanupTimer);
  cacheCleanupTimer = null;
  membershipCache.clear();
  cachedSettings = null;
  cachedJobRevision = null;
  cachedDatabaseRevision = null;
}

function readPlaylistSettingsVersion() {
  const hash = createHash("sha256");
  for (const { key, value } of playlistSettingsStmt.all()) {
    hash.update(`${key.length}:${key}:${value.length}:`).update(value);
  }
  return hash.digest("hex");
}

function refreshMembershipCache() {
  const databaseRevision = getDatabaseRevision();
  if (databaseRevision === cachedDatabaseRevision) return;
  const settings = readPlaylistSettingsVersion();
  const revision = downloadTracker.getRevision();
  if (settings !== cachedSettings) {
    dbOps.invalidateSettingsCache();
    invalidateFlowPlaylistConfigCache();
  }
  if (settings !== cachedSettings || revision !== cachedJobRevision) {
    membershipCache.clear();
  }
  cachedSettings = settings;
  cachedJobRevision = revision;
  cachedDatabaseRevision = databaseRevision;
}

function getMembershipSummary(playlist: StaticPlaylist) {
  let summary = membershipCache.get(playlist.id);
  if (!summary) {
    const jobs = downloadTracker.getByPlaylistType(playlist.id);
    summary = {
      trackIdentities: collectPlaylistTrackIdentities(playlist, jobs),
      trackEntries: collectPlaylistTrackEntries(jobs),
    };
  }
  membershipCache.delete(playlist.id);
  membershipCache.set(playlist.id, summary);
  if (membershipCache.size > MEMBERSHIP_CACHE_LIMIT) {
    membershipCache.delete(membershipCache.keys().next().value!);
  }
  return {
    trackIdentities: [...summary.trackIdentities],
    trackEntries: summary.trackEntries.map((entry) => ({ ...entry })),
  };
}

function getCountdown(nextRunAt: unknown): ["soon" | "minute" | "hour" | "day", number] | null {
  const timestamp = Number(nextRunAt);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  const diff = timestamp - Date.now();
  if (diff <= 0) return ["soon", 0];
  const minuteMs = 60 * 1000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;
  if (diff < hourMs) return ["minute", Math.ceil(diff / minuteMs)];
  if (diff < dayMs) return ["hour", Math.ceil(diff / hourMs)];
  return ["day", Math.ceil(diff / dayMs)];
}

function formatNextRunMessage(flows: FlowConfig[]) {
  const nextRunAt = (Array.isArray(flows) ? flows : [])
    .filter((flow) => flow?.enabled === true)
    .map((flow) => Number(flow?.nextRunAt))
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b)[0];
  const countdown = getCountdown(nextRunAt);
  if (!countdown) return null;
  const [unit, value] = countdown;
  if (unit === "soon") return "Next update soon";
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "always" });
  return `Next update ${rtf.format(value, unit)}`;
}

export function getPlaylistStatusVersion() {
  return JSON.stringify([
    getDatabaseRevision(),
    isDownloadOwnerProcess() ? downloadWorker.getStatus() : getDownloadOwnerStatus(),
    getPlaylistOperationWorkerStatus(),
    slskdClient.getStatus(),
    flowPlaylistConfig
      .getFlows()
      .filter((flow) => flow?.enabled === true)
      .map((flow) => getCountdown(flow.nextRunAt)),
  ]);
}

function aggregateStats(
  statsByType: ReturnType<typeof downloadTracker.getStatsByPlaylistType>,
  ids: string[],
) {
  const base = {
    total: 0,
    pending: 0,
    downloading: 0,
    blocked: 0,
    done: 0,
    failed: 0,
  };
  for (const id of Array.isArray(ids) ? ids : []) {
    const stats = statsByType?.[id];
    if (!stats) continue;
    base.pending += Number(stats.pending || 0);
    base.downloading += Number(stats.downloading || 0);
    base.blocked += Number(stats.blocked || 0);
    base.done += Number(stats.done || 0);
    base.failed += Number(stats.failed || 0);
  }
  base.total = base.pending + base.downloading + base.blocked + base.done + base.failed;
  return base;
}

function collectPlaylistTrackIdentities(playlist: StaticPlaylist, jobs: DownloadJob[]) {
  const playlistId = String(playlist?.id || "");
  if (!playlistId) return [];
  const seen = new Set<string>();
  const identities: string[] = [];
  const addIdentity = (track: Parameters<typeof buildPlaylistTrackIdentity>[0]) => {
    const identity = buildPlaylistTrackIdentity(track);
    if (!identity || seen.has(identity)) return;
    seen.add(identity);
    identities.push(identity);
  };
  for (const job of jobs) {
    addIdentity(job);
  }
  for (const track of Array.isArray(playlist?.tracks) ? playlist.tracks : []) {
    addIdentity(track);
  }
  return identities;
}

function collectPlaylistTrackEntries(jobs: DownloadJob[]) {
  return jobs
    .filter((job) =>
      [
        job?.artistName,
        job?.trackName,
        job?.albumName,
        job?.artistMbid,
        job?.albumMbid,
        job?.trackMbid,
        job?.releaseYear,
      ].some((value) => String(value ?? "").trim()),
    )
    .map((job) => ({
      id: job.id,
      identity: buildPlaylistTrackIdentity(job),
    }));
}

function buildOwnerMap(
  flows: Pick<FlowConfig, "ownerUserId">[],
  staticPlaylists: Pick<StaticPlaylist, "ownerUserId">[],
) {
  const ownerIds = new Set<number>();
  for (const item of [
    ...(Array.isArray(flows) ? flows : []),
    ...(Array.isArray(staticPlaylists) ? staticPlaylists : []),
  ]) {
    const ownerUserId = Number(item?.ownerUserId);
    if (Number.isFinite(ownerUserId)) {
      ownerIds.add(ownerUserId);
    }
  }
  const ownerMap = new Map();
  for (const ownerUserId of ownerIds) {
    const owner = userOps.getUserById(ownerUserId);
    if (owner?.username) {
      ownerMap.set(ownerUserId, owner.username);
    }
  }
  return ownerMap;
}

export function getPlaylistStatusSnapshot({ user = null }: { user?: RequestUser | null } = {}) {
  refreshMembershipCache();
  if (cacheCleanupTimer) clearTimeout(cacheCleanupTimer);
  cacheCleanupTimer = setTimeout(clearPlaylistStatusCache, 60000);
  cacheCleanupTimer.unref?.();
  const workerStatus: ReturnType<typeof downloadWorker.getStatus> & {
    operationWorker?: DownloadOwnerStatus["operationWorker"];
  } = downloadWorker.getStatus();
  const flows = user ? flowPlaylistConfig.getFlowsForUser(user) : flowPlaylistConfig.getFlows();
  const rawStaticPlaylists = user
    ? flowPlaylistConfig.getStaticPlaylistsForUser(user)
    : flowPlaylistConfig.getStaticPlaylists();
  const flowIds = flows.map((flow) => flow.id);
  const staticPlaylistIds = rawStaticPlaylists.map((playlist) => playlist.id);
  const scopedStats = downloadTracker.getStatsByPlaylistType([
    ...flowIds,
    ...staticPlaylistIds,
    "library",
  ]);
  const staticPlaylists = rawStaticPlaylists.map((playlist) => {
    const playlistStats = scopedStats?.[playlist.id];
    const jobTotal =
      Number(playlistStats?.pending || 0) +
      Number(playlistStats?.downloading || 0) +
      Number(playlistStats?.blocked || 0) +
      Number(playlistStats?.done || 0) +
      Number(playlistStats?.failed || 0);
    return {
      id: playlist.id,
      name: playlist.name,
      ownerUserId: playlist.ownerUserId ?? null,
      sourceName: playlist.sourceName,
      sourceFlowId: playlist.sourceFlowId,
      importedAt: playlist.importedAt,
      createdAt: playlist.createdAt,
      trackCount: Math.max(jobTotal, Number(playlist.trackCount || 0)),
      recordHistory: playlist.recordHistory !== false,
      showTrackAvailability: playlist.showTrackAvailability === true,
      ...getMembershipSummary(playlist),
      importSource: playlist.importSource
        ? {
            provider: playlist.importSource.provider,
            ...(playlist.importSource.artworkUrl
              ? { artworkUrl: playlist.importSource.artworkUrl }
              : {}),
            syncEnabled: playlist.importSource.syncEnabled === true,
            syncIntervalHours: playlist.importSource.syncEnabled
              ? playlist.importSource.syncIntervalHours
              : 0,
            keepRemovedTracks: playlist.importSource.keepRemovedTracks !== false,
          }
        : null,
    };
  });
  const ownerMap = buildOwnerMap(flows, staticPlaylists);
  const artworkRevisions = getPlaylistArtworkRevisions();
  const artworkRevision = (id: string) =>
    artworkRevisions.has(id) ? { artworkRevision: artworkRevisions.get(id) } : {};
  const flowsWithOwners = flows.map((flow) => ({
    ...flow,
    ...artworkRevision(flow.id),
    ownerUsername: ownerMap.get(Number(flow?.ownerUserId)) || null,
  }));
  const staticPlaylistsWithOwners = staticPlaylists.map((playlist) => ({
    ...playlist,
    ...artworkRevision(playlist.id),
    ownerUsername: ownerMap.get(Number(playlist?.ownerUserId)) || null,
  }));
  const stats = aggregateStats(scopedStats, flowIds);
  const sharedStats = aggregateStats(scopedStats, staticPlaylistIds);
  const reviewCount =
    stats.blocked + sharedStats.blocked + Number(scopedStats.library?.blocked || 0);
  const nextRunMessage = formatNextRunMessage(flowsWithOwners);
  const operationQueue = playlistOperationQueue.getStatus();
  const operationWorker = workerStatus?.operationWorker || getPlaylistOperationWorkerStatus();
  const queueLabel = String(operationQueue?.currentLabel || operationWorker?.currentLabel || "");
  let phase = "idle";
  let message = "Idle";
  if (operationQueue?.processing || operationWorker?.currentLabel) {
    phase = "preparing";
    if (queueLabel.startsWith("enable:") || queueLabel.startsWith("scheduled:")) {
      message = "Generating playlist";
    } else if (queueLabel.startsWith("disable:") || queueLabel.startsWith("delete:")) {
      message = "Cleaning existing flow files";
    } else if (queueLabel.startsWith("reset:")) {
      message = "Resetting flow files";
    } else {
      message = "Generating playlist";
    }
  } else if (workerStatus?.processing) {
    phase = "downloading";
    message = "Downloading track";
  } else if (Number(stats?.pending || 0) > 0) {
    phase = "queued";
    message = "Tracks queued and waiting";
  } else if (
    Number(stats?.total || 0) > 0 &&
    Number(stats?.pending || 0) === 0 &&
    Number(stats?.downloading || 0) === 0
  ) {
    phase = "completed";
  }
  if (phase === "completed" && nextRunMessage) {
    message = nextRunMessage;
  }
  const flowStats: Record<string, ReturnType<typeof aggregateStats>> = {};
  for (const flowId of flowIds) {
    flowStats[flowId] = scopedStats[flowId] || aggregateStats({}, []);
  }
  const staticPlaylistStats: Record<string, ReturnType<typeof aggregateStats>> = {};
  for (const playlistId of staticPlaylistIds) {
    staticPlaylistStats[playlistId] = scopedStats[playlistId] || aggregateStats({}, []);
  }
  const retryCyclePausedByPlaylist = downloadWorker.getRetryCyclePausedMap([
    ...flowIds,
    ...staticPlaylistIds,
  ]);
  return {
    worker: {
      ...workerStatus,
      stats,
    },
    slskd: getDownloadClient("slskd").getStatus(),
    stats,
    reviewCount,
    flowStats,
    sharedStats,
    sharedPlaylistStats: staticPlaylistStats,
    flows: flowsWithOwners,
    sharedPlaylists: staticPlaylistsWithOwners,
    retryCyclePausedByPlaylist,
    operationQueue,
    operationWorker,
    hint: {
      phase,
      message,
    },
  };
}

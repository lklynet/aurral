import { downloadTracker } from "../downloadJobs/downloadTracker.js";
import { downloadWorker } from "../downloadJobs/downloadWorker.js";
import { buildPlaylistTrackIdentity, flowPlaylistConfig, invalidateFlowPlaylistConfigCache } from "./flowPlaylistConfig.js";
import { playlistOperationQueue } from "./playlistOperationQueue.js";
import { getPlaylistOperationWorkerStatus } from "./playlistOperationWorker.js";
import { getDownloadClient } from "../download/downloadClientSettings.js";
import { dbOps, userOps } from "../../db/helpers/index.js";
import { db } from "../../config/db-sqlite.js";
import { getStaticPlaylistJobs } from "./staticPlaylistJobs.js";

const playlistSettingsStmt = db.prepare("SELECT key, value FROM settings WHERE key IN ('flows', 'staticPlaylists') ORDER BY key");
const membershipCache = new Map();
const MEMBERSHIP_CACHE_LIMIT = 128;
let cachedSettings = null;
let cachedJobRevision = null;

function readPlaylistSettingsVersion() {
  return JSON.stringify(playlistSettingsStmt.all());
}

function refreshMembershipCache() {
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
}

function getMembershipSummary(playlist) {
  let summary = membershipCache.get(playlist.id);
  if (!summary) {
    const jobs = getStaticPlaylistJobs(playlist);
    summary = {
      trackIdentities: collectPlaylistTrackIdentities(playlist, jobs),
      trackEntries: collectPlaylistTrackEntries(jobs),
    };
  }
  membershipCache.delete(playlist.id);
  membershipCache.set(playlist.id, summary);
  if (membershipCache.size > MEMBERSHIP_CACHE_LIMIT) {
    membershipCache.delete(membershipCache.keys().next().value);
  }
  return {
    trackIdentities: [...summary.trackIdentities],
    trackEntries: summary.trackEntries.map((entry) => ({ ...entry })),
  };
}

function formatNextRunMessage(flows) {
  const nextRunAt = (Array.isArray(flows) ? flows : [])
    .filter((flow) => flow?.enabled === true)
    .map((flow) => Number(flow?.nextRunAt))
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b)[0];
  if (!nextRunAt) return null;
  const diff = nextRunAt - Date.now();
  if (diff <= 0) return "Next update soon";
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "always" });
  const minuteMs = 60 * 1000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;
  if (diff < hourMs) return `Next update ${rtf.format(Math.ceil(diff / minuteMs), "minute")}`;
  if (diff < dayMs) return `Next update ${rtf.format(Math.ceil(diff / hourMs), "hour")}`;
  return `Next update ${rtf.format(Math.ceil(diff / dayMs), "day")}`;
}

function countJobStatuses(jobs) {
  const stats = { total: 0, pending: 0, downloading: 0, blocked: 0, done: 0, failed: 0 };
  for (const job of jobs) {
    if (Object.hasOwn(stats, job.status) && job.status !== "total") stats[job.status] += 1;
  }
  stats.total = stats.pending + stats.downloading + stats.blocked + stats.done + stats.failed;
  return stats;
}

function aggregateStats(statsByType, ids) {
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


function collectPlaylistTrackIdentities(playlist, jobs) {
  const playlistId = String(playlist?.id || "");
  if (!playlistId) return [];
  const seen = new Set();
  const identities = [];
  const addIdentity = (track) => {
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

function collectPlaylistTrackEntries(jobs) {
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

function buildOwnerMap(flows, staticPlaylists) {
  const ownerIds = new Set();
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

export function getPlaylistStatusSnapshot({
  user = null,
} = {}) {
  refreshMembershipCache();
  const workerStatus = downloadWorker.getStatus();
  const flows = user ? flowPlaylistConfig.getFlowsForUser(user) : flowPlaylistConfig.getFlows();
  const rawStaticPlaylists = user
    ? flowPlaylistConfig.getStaticPlaylistsForUser(user)
    : flowPlaylistConfig.getStaticPlaylists();
  const flowIds = flows.map((flow) => flow.id);
  const staticPlaylistIds = rawStaticPlaylists.map((playlist) => playlist.id);
  const scopedStats = {
    ...downloadTracker.getStatsByOwner(flowIds),
    ...Object.fromEntries(rawStaticPlaylists.map((playlist) => [
      playlist.id,
      countJobStatuses(getStaticPlaylistJobs(playlist)),
    ])),
  };
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
  const flowsWithOwners = flows.map((flow) => ({
    ...flow,
    ownerUsername: ownerMap.get(Number(flow?.ownerUserId)) || null,
  }));
  const staticPlaylistsWithOwners = staticPlaylists.map((playlist) => ({
    ...playlist,
    ownerUsername: ownerMap.get(Number(playlist?.ownerUserId)) || null,
  }));
  const stats = aggregateStats(scopedStats, flowIds);
  const staticPlaylistTotals = aggregateStats(scopedStats, staticPlaylistIds);
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
  const flowStats = {};
  for (const flowId of flowIds) {
    flowStats[flowId] = scopedStats[flowId] || aggregateStats({}, []);
  }
  const staticPlaylistStats = {};
  for (const playlistId of staticPlaylistIds) {
    staticPlaylistStats[playlistId] = scopedStats[playlistId] || aggregateStats({}, []);
  }
  const retryCyclePausedByPlaylist = downloadWorker.getRetryCyclePausedMap(flowIds);
  return {
    worker: {
      ...workerStatus,
      stats,
    },
    slskd: getDownloadClient("slskd").getStatus(),
    stats,
    flowStats,
    staticPlaylistTotals,
    staticPlaylistStats: staticPlaylistStats,
    flows: flowsWithOwners,
    staticPlaylists: staticPlaylistsWithOwners,
    retryCyclePausedByPlaylist,
    operationQueue,
    operationWorker,
    hint: {
      phase,
      message,
    },
  };
}

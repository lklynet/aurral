import { downloadTracker } from "./weeklyFlowDownloadTracker.js";
import { weeklyFlowWorker } from "./weeklyFlowWorker.js";
import { buildSharedTrackIdentity, flowPlaylistConfig } from "./weeklyFlowPlaylistConfig.js";
import { weeklyFlowOperationQueue } from "./weeklyFlowOperationQueue.js";
import { getWeeklyFlowOperationWorkerStatus } from "./weeklyFlowOperationWorker.js";
import { slskdClient } from "../slskdClient.js";
import { userOps } from "../../db/helpers/index.js";
import { getFlowCapabilities } from "../listenbrainzDiscoveryFallback.js";

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


function collectPlaylistTrackIdentities(playlist) {
  const playlistId = String(playlist?.id || "");
  if (!playlistId) return [];
  const seen = new Set();
  const identities = [];
  const addIdentity = (track) => {
    const identity = buildSharedTrackIdentity(track);
    if (!identity || seen.has(identity)) return;
    seen.add(identity);
    identities.push(identity);
  };
  for (const job of downloadTracker.getByPlaylistType(playlistId)) {
    addIdentity(job);
  }
  for (const track of Array.isArray(playlist?.tracks) ? playlist.tracks : []) {
    addIdentity(track);
  }
  return identities;
}

function collectPlaylistTrackEntries(playlist) {
  const playlistId = String(playlist?.id || "");
  if (!playlistId) return [];
  return downloadTracker
    .getByPlaylistType(playlistId)
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
      identity: buildSharedTrackIdentity(job),
    }));
}

function buildOwnerMap(flows, sharedPlaylists) {
  const ownerIds = new Set();
  for (const item of [
    ...(Array.isArray(flows) ? flows : []),
    ...(Array.isArray(sharedPlaylists) ? sharedPlaylists : []),
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

export function getWeeklyFlowStatusSnapshot({
  user = null,
} = {}) {
  const workerStatus = weeklyFlowWorker.getStatus();
  const flows = user ? flowPlaylistConfig.getFlowsForUser(user) : flowPlaylistConfig.getFlows();
  const rawSharedPlaylists = user
    ? flowPlaylistConfig.getSharedPlaylistsForUser(user)
    : flowPlaylistConfig.getSharedPlaylists();
  const flowIds = flows.map((flow) => flow.id);
  const sharedPlaylistIds = rawSharedPlaylists.map((playlist) => playlist.id);
  const scopedStats = downloadTracker.getStatsByPlaylistType([
    ...flowIds,
    ...sharedPlaylistIds,
  ]);
  const sharedPlaylists = rawSharedPlaylists.map((playlist) => {
    const playlistStats = scopedStats?.[playlist.id];
    const jobTotal =
      Number(playlistStats?.pending || 0) +
      Number(playlistStats?.downloading || 0) +
      Number(playlistStats?.blocked || 0) +
      Number(playlistStats?.done || 0);
    return {
      id: playlist.id,
      name: playlist.name,
      ownerUserId: playlist.ownerUserId ?? null,
      sourceName: playlist.sourceName,
      sourceFlowId: playlist.sourceFlowId,
      importedAt: playlist.importedAt,
      createdAt: playlist.createdAt,
      trackCount: jobTotal > 0 ? jobTotal : playlist.trackCount,
      trackIdentities: collectPlaylistTrackIdentities(playlist),
      trackEntries: collectPlaylistTrackEntries(playlist),
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
  const ownerMap = buildOwnerMap(flows, sharedPlaylists);
  const flowsWithOwners = flows.map((flow) => ({
    ...flow,
    ownerUsername: ownerMap.get(Number(flow?.ownerUserId)) || null,
  }));
  const sharedPlaylistsWithOwners = sharedPlaylists.map((playlist) => ({
    ...playlist,
    ownerUsername: ownerMap.get(Number(playlist?.ownerUserId)) || null,
  }));
  const stats = aggregateStats(scopedStats, flowIds);
  const sharedStats = aggregateStats(scopedStats, sharedPlaylistIds);
  const nextRunMessage = formatNextRunMessage(flowsWithOwners);
  const operationQueue = weeklyFlowOperationQueue.getStatus();
  const operationWorker = getWeeklyFlowOperationWorkerStatus();
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
  const sharedPlaylistStats = {};
  for (const playlistId of sharedPlaylistIds) {
    sharedPlaylistStats[playlistId] = scopedStats[playlistId] || aggregateStats({}, []);
  }
  const retryCyclePausedByPlaylist = weeklyFlowWorker.getRetryCyclePausedMap([
    ...flowIds,
    ...sharedPlaylistIds,
  ]);
  const retryCycleScheduledByPlaylist = weeklyFlowWorker.getIncompleteRetryMap([
    ...flowIds,
    ...sharedPlaylistIds,
  ]);
  return {
    worker: {
      ...workerStatus,
      stats,
    },
    slskd: slskdClient.getStatus(),
    stats,
    flowStats,
    sharedStats,
    sharedPlaylistStats,
    flows: flowsWithOwners,
    sharedPlaylists: sharedPlaylistsWithOwners,
    capabilities: getFlowCapabilities(),
    retryCyclePausedByPlaylist,
    retryCycleScheduledByPlaylist,
    operationQueue,
    operationWorker,
    hint: {
      phase,
      message,
    },
  };
}

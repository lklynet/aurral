import { downloadTracker } from "./weeklyFlowDownloadTracker.js";
import { weeklyFlowWorker } from "./weeklyFlowWorker.js";
import { flowPlaylistConfig } from "./weeklyFlowPlaylistConfig.js";
import { weeklyFlowOperationQueue } from "./weeklyFlowOperationQueue.js";
import { soulseekClient } from "./simpleSoulseekClient.js";

function formatNextRunMessage(flows) {
  const nextRunAt = (Array.isArray(flows) ? flows : [])
    .filter((flow) => flow?.enabled === true)
    .map((flow) => Number(flow?.nextRunAt))
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b)[0];
  if (!nextRunAt) return null;
  const diff = nextRunAt - Date.now();
  if (diff <= 0) return "Next update soon";
  const minuteMs = 60 * 1000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;
  if (diff < hourMs) {
    const minutes = Math.ceil(diff / minuteMs);
    return minutes === 1
      ? "Next update in 1 minute"
      : `Next update in ${minutes} minutes`;
  }
  if (diff < dayMs) {
    const hours = Math.ceil(diff / hourMs);
    return hours === 1
      ? "Next update in 1 hour"
      : `Next update in ${hours} hours`;
  }
  const days = Math.ceil(diff / dayMs);
  return days === 1 ? "Next update in 1 day" : `Next update in ${days} days`;
}

function aggregateStats(statsByType, ids) {
  const base = {
    total: 0,
    pending: 0,
    downloading: 0,
    done: 0,
    failed: 0,
  };
  for (const id of Array.isArray(ids) ? ids : []) {
    const stats = statsByType?.[id];
    if (!stats) continue;
    base.pending += Number(stats.pending || 0);
    base.downloading += Number(stats.downloading || 0);
    base.done += Number(stats.done || 0);
    base.failed += Number(stats.failed || 0);
  }
  base.total = base.pending + base.downloading + base.done + base.failed;
  return base;
}

export function getWeeklyFlowStatusSnapshot({
  includeJobs = false,
  flowId = null,
  jobsLimit = null,
} = {}) {
  const workerStatus = weeklyFlowWorker.getStatus();
  const flows = flowPlaylistConfig.getFlows();
  const sharedPlaylists = flowPlaylistConfig.getSharedPlaylistSummaries();
  const flowIds = flows.map((flow) => flow.id);
  const sharedPlaylistIds = sharedPlaylists.map((playlist) => playlist.id);
  const scopedStats = downloadTracker.getStatsByPlaylistType([
    ...flowIds,
    ...sharedPlaylistIds,
  ]);
  const stats = aggregateStats(scopedStats, flowIds);
  const sharedStats = aggregateStats(scopedStats, sharedPlaylistIds);
  const nextRunMessage = formatNextRunMessage(flows);
  const operationQueue = weeklyFlowOperationQueue.getStatus();
  const queueLabel = String(operationQueue?.currentLabel || "");
  let phase = "idle";
  let message = "Idle";
  if (operationQueue?.processing) {
    phase = "preparing";
    if (
      queueLabel.startsWith("enable:") ||
      queueLabel.startsWith("scheduled:")
    ) {
      message = "Generating playlist";
    } else if (
      queueLabel.startsWith("disable:") ||
      queueLabel.startsWith("delete:")
    ) {
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
  let jobs;
  if (includeJobs) {
    const sourceJobs = flowId
      ? downloadTracker.getByPlaylistType(flowId)
      : downloadTracker.getAll();
    jobs = jobsLimit ? sourceJobs.slice(0, jobsLimit) : sourceJobs;
  }
  return {
    worker: {
      ...workerStatus,
      stats,
    },
    soulseek: soulseekClient.getStatus(),
    stats,
    flowStats,
    sharedStats,
    sharedPlaylistStats,
    jobs,
    flows,
    sharedPlaylists,
    retryCyclePausedByPlaylist,
    retryCycleScheduledByPlaylist,
    operationQueue,
    hint: {
      phase,
      message,
    },
  };
}

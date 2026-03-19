import { downloadTracker } from "./weeklyFlowDownloadTracker.js";
import { weeklyFlowWorker } from "./weeklyFlowWorker.js";
import { flowPlaylistConfig } from "./weeklyFlowPlaylistConfig.js";
import { weeklyFlowOperationQueue } from "./weeklyFlowOperationQueue.js";

export function getWeeklyFlowStatusSnapshot({
  includeJobs = false,
  flowId = null,
  jobsLimit = null,
} = {}) {
  const workerStatus = weeklyFlowWorker.getStatus();
  const stats = workerStatus.stats || downloadTracker.getStats();
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
      message = "Generating track list";
    } else if (
      queueLabel.startsWith("disable:") ||
      queueLabel.startsWith("delete:")
    ) {
      message = "Cleaning existing flow files";
    } else if (queueLabel.startsWith("reset:")) {
      message = "Resetting flow files";
    } else {
      message = "Applying flow operation";
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
    message = "Flow run completed";
  }
  const flows = flowPlaylistConfig.getFlows();
  const flowIds = flows.map((flow) => flow.id);
  const flowStats = downloadTracker.getStatsByPlaylistType(flowIds);
  let jobs;
  if (includeJobs) {
    const sourceJobs = flowId
      ? downloadTracker.getByPlaylistType(flowId)
      : downloadTracker.getAll();
    jobs = jobsLimit ? sourceJobs.slice(0, jobsLimit) : sourceJobs;
  }
  return {
    worker: workerStatus,
    stats,
    flowStats,
    jobs,
    flows,
    operationQueue,
    hint: {
      phase,
      message,
    },
  };
}

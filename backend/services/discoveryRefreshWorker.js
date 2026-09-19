import createHonkerWorker from "./honkerWorkerFactory.js";
import { getDiscoveryRefreshQueue } from "./honkerDb.js";
import { websocketService } from "./websocketService.js";
import {
  clearDiscoveryUpdateProgress,
  getDiscoveryCache,
  recordDiscoveryUpdateProgress,
  updateDiscoveryCache,
} from "./discovery/index.js";
import {
  discoveryNeedsRefresh,
  isDiscoveryRefreshConfigured,
  scheduleNextDiscoveryRefresh,
} from "./discovery/refreshScheduler.js";
async function runDiscoveryRefresh(payload) {
  if (!(await isDiscoveryRefreshConfigured())) {
    getDiscoveryCache().isUpdating = false;
    clearDiscoveryUpdateProgress();
    websocketService.emitDiscoveryUpdate({
      isUpdating: false,
      configured: false,
      phase: "skipped",
      progressMessage: "Discovery refresh skipped because it is not configured",
    });
    return;
  }

  if (payload?.scheduleOnly === true && !discoveryNeedsRefresh()) {
    getDiscoveryCache().isUpdating = false;
    clearDiscoveryUpdateProgress();
    websocketService.emitDiscoveryUpdate({
      isUpdating: false,
      configured: true,
      phase: "skipped",
      progressMessage: "Discovery cache is already current",
    });
    return;
  }

  const cache = getDiscoveryCache();
  if (!cache.isUpdating) {
    cache.isUpdating = true;
    recordDiscoveryUpdateProgress("starting", "Starting discovery refresh", 2, {
      reason: payload?.reason || "scheduled",
    });
  }

  await updateDiscoveryCache();
}

const {  start: startDiscoveryRefreshWorker,
  stop: stopDiscoveryRefreshWorker,
  isRunning: isDiscoveryRefreshWorkerRunning,
} = createHonkerWorker({
  name: "discovery-refresh",
  getQueue: getDiscoveryRefreshQueue,
  processJob: runDiscoveryRefresh,
  idlePollS: 5,
  retryDelayS: 300,
  onJobSuccess: scheduleNextDiscoveryRefresh,
  onJobError: () => {
    getDiscoveryCache().isUpdating = false;
    clearDiscoveryUpdateProgress();
  },
});

export {
  startDiscoveryRefreshWorker,
  stopDiscoveryRefreshWorker,
  isDiscoveryRefreshWorkerRunning,
};

import createHonkerWorker from "./honkerWorkerFactory.js";
import { getDiscoveryRefreshQueue } from "./honkerDb.js";
import { websocketService } from "./websocketService.js";
import { updateDiscoveryCache } from "./discovery/index.js";
import {
  markDiscoveryRefreshFinished,
  markDiscoveryRefreshStarted,
} from "./discovery/persistence.js";
import {
  discoveryNeedsRefresh,
  isDiscoveryRefreshConfigured,
  scheduleNextDiscoveryRefresh,
} from "./discovery/refreshScheduler.js";

function skipDiscoveryRefresh({ configured, progressMessage }) {
  markDiscoveryRefreshStarted();
  markDiscoveryRefreshFinished();
  websocketService.emitDiscoveryUpdate({
    isUpdating: false,
    configured,
    phase: "skipped",
    progressMessage,
  });
}

async function runDiscoveryRefresh(payload) {
  if (!(await isDiscoveryRefreshConfigured())) {
    skipDiscoveryRefresh({
      configured: false,
      progressMessage: "Discovery refresh skipped because it is not configured",
    });
    return;
  }

  if (payload?.scheduleOnly === true && !discoveryNeedsRefresh()) {
    skipDiscoveryRefresh({
      configured: true,
      progressMessage: "Discovery cache is already current",
    });
    return;
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
});

export {
  startDiscoveryRefreshWorker,
  stopDiscoveryRefreshWorker,
  isDiscoveryRefreshWorkerRunning,
};

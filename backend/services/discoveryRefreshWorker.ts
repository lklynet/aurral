import createHonkerWorker from "./honkerWorkerFactory.ts";
import { getDiscoveryRefreshQueue } from "./honkerDb.ts";
import { websocketService } from "./websocketService.ts";
import { updateDiscoveryCache } from "./discovery/index.ts";
import {
  markDiscoveryRefreshFinished,
  markDiscoveryRefreshStarted,
} from "./discovery/persistence.ts";
import {
  discoveryNeedsRefresh,
  scheduleNextDiscoveryRefresh,
} from "./discovery/refreshScheduler.ts";

function skipDiscoveryRefresh(progressMessage) {
  markDiscoveryRefreshStarted();
  markDiscoveryRefreshFinished();
  websocketService.emitDiscoveryUpdate({
    isUpdating: false,
    configured: true,
    phase: "skipped",
    progressMessage,
  });
}

async function runDiscoveryRefresh(payload) {
  if (payload?.scheduleOnly === true && !discoveryNeedsRefresh()) {
    skipDiscoveryRefresh("Discovery cache is already current");
    return;
  }

  await updateDiscoveryCache();
}

const {
  start: startDiscoveryRefreshWorker,
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

export { startDiscoveryRefreshWorker, stopDiscoveryRefreshWorker, isDiscoveryRefreshWorkerRunning };

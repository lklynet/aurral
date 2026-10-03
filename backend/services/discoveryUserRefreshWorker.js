import createHonkerWorker from "./honkerWorkerFactory.js";
import { getDiscoveryUserRefreshQueue } from "./honkerDb.js";
import { updateUserDiscoveryCache } from "./discovery/index.js";

async function processDiscoveryUserRefresh(payload = {}) {
  const userId = Number(payload?.userId);
  if (!Number.isInteger(userId) || userId <= 0) {
    return { skipped: true, reason: "invalid_payload" };
  }
  return updateUserDiscoveryCache(userId, { requestedAt: Number(payload?.requestedAt) });
}

const {  start: startDiscoveryUserRefreshWorker,
  stop: stopDiscoveryUserRefreshWorker,
  isRunning: isDiscoveryUserRefreshWorkerRunning,
} = createHonkerWorker({
  name: "discovery-user-refresh",
  getQueue: getDiscoveryUserRefreshQueue,
  processJob: processDiscoveryUserRefresh,
  idlePollS: 10,
  retryDelayS: 300,
});

export {
  startDiscoveryUserRefreshWorker,
  stopDiscoveryUserRefreshWorker,
  isDiscoveryUserRefreshWorkerRunning,
};

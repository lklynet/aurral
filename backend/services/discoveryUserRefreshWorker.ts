import * as v from "valibot";
import createHonkerWorker from "./honkerWorkerFactory.ts";
import { getDiscoveryUserRefreshQueue } from "./honkerDb.ts";
import { updateUserDiscoveryCache } from "./discovery/index.ts";

const {
  start: startDiscoveryUserRefreshWorker,
  stop: stopDiscoveryUserRefreshWorker,
  isRunning: isDiscoveryUserRefreshWorkerRunning,
} = createHonkerWorker({
  name: "discovery-user-refresh",
  schema: v.looseObject({
    userId: v.pipe(v.number(), v.integer(), v.minValue(1)),
    requestedAt: v.optional(v.number()),
  }),
  getQueue: getDiscoveryUserRefreshQueue,
  processJob: ({ userId, requestedAt }) => updateUserDiscoveryCache(userId, { requestedAt }),
  idlePollS: 10,
  retryDelayS: 300,
});

export {
  startDiscoveryUserRefreshWorker,
  stopDiscoveryUserRefreshWorker,
  isDiscoveryUserRefreshWorkerRunning,
};

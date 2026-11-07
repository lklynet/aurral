import * as v from "valibot";
import { createJobWorker } from "./jobs/worker.ts";
import { discoveryUserRefreshQueue } from "./jobs/queues.ts";
import { updateUserDiscoveryCache } from "./discovery/index.ts";

export const discoveryUserRefreshSchema = v.looseObject({
  userId: v.pipe(v.number(), v.integer(), v.minValue(1)),
  requestedAt: v.optional(v.number()),
});

const {
  start: startDiscoveryUserRefreshWorker,
  stop: stopDiscoveryUserRefreshWorker,
  isRunning: isDiscoveryUserRefreshWorkerRunning,
} = createJobWorker(discoveryUserRefreshQueue, {
  schema: discoveryUserRefreshSchema,
  processJob: ({ userId, requestedAt }) => updateUserDiscoveryCache(userId, { requestedAt }),
});

export {
  startDiscoveryUserRefreshWorker,
  stopDiscoveryUserRefreshWorker,
  isDiscoveryUserRefreshWorkerRunning,
};

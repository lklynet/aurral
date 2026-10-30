import * as v from "valibot";
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

function skipDiscoveryRefresh(progressMessage: string) {
  markDiscoveryRefreshStarted();
  markDiscoveryRefreshFinished();
  websocketService.emitDiscoveryUpdate({
    isUpdating: false,
    configured: true,
    phase: "skipped",
    progressMessage,
  });
}

const discoveryRefreshSchema = v.looseObject({ scheduleOnly: v.optional(v.boolean()) });

async function runDiscoveryRefresh({ scheduleOnly }: v.InferOutput<typeof discoveryRefreshSchema>) {
  if (scheduleOnly === true && !discoveryNeedsRefresh()) {
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
  schema: discoveryRefreshSchema,
  getQueue: getDiscoveryRefreshQueue,
  processJob: runDiscoveryRefresh,
  idlePollS: 5,
  retryDelayS: 300,
  onJobSuccess: scheduleNextDiscoveryRefresh,
});

export { startDiscoveryRefreshWorker, stopDiscoveryRefreshWorker, isDiscoveryRefreshWorkerRunning };

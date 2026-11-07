import * as v from "valibot";
import { createJobWorker } from "./jobs/worker.ts";
import { discoveryRefreshQueue } from "./jobs/queues.ts";
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

export const discoveryRefreshSchema = v.looseObject({ scheduleOnly: v.optional(v.boolean()) });

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
} = createJobWorker(discoveryRefreshQueue, {
  schema: discoveryRefreshSchema,
  processJob: runDiscoveryRefresh,
  onJobSuccess: scheduleNextDiscoveryRefresh,
});

export { startDiscoveryRefreshWorker, stopDiscoveryRefreshWorker, isDiscoveryRefreshWorkerRunning };

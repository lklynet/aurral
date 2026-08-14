import { downloadTracker } from "./weeklyFlowDownloadTracker.js";
import { weeklyFlowWorker } from "./weeklyFlowWorker.js";
import { flowPlaylistConfig } from "./weeklyFlowPlaylistConfig.js";
import { isAnyDownloadSourceConfigured } from "../downloadSourceService.js";
import { weeklyFlowOperationQueue } from "./weeklyFlowOperationQueue.js";
import { userOps } from "../../db/helpers/index.js";
import {
  createWeeklyFlowOperationToken,
  markLatestWeeklyFlowOperationToken,
} from "./weeklyFlowOperations.js";

function isFlowOwnerActive(flow) {
  const ownerUserId = Number(flow?.ownerUserId);
  if (!Number.isFinite(ownerUserId)) return true;
  const owner = userOps.getUserById(ownerUserId);
  return !owner || owner.status === "active";
}

export async function runScheduledRefresh() {
  if (!isAnyDownloadSourceConfigured()) return;

  const due = flowPlaylistConfig.getDueForRefresh();
  if (due.length === 0) return;

  for (const flow of due) {
    if (!isFlowOwnerActive(flow)) continue;
    try {
      const token = createWeeklyFlowOperationToken();
      const tokenScope = `flow:${flow.id}:scheduled`;
      markLatestWeeklyFlowOperationToken(tokenScope, token);
      await weeklyFlowOperationQueue.enqueuePayload({
        kind: "scheduled-flow-refresh",
        label: `scheduled:${flow.id}`,
        flowId: flow.id,
        tokenScope,
        token,
      });
    } catch (error) {
      console.error(`[WeeklyFlowScheduler] Failed to refresh ${flow.id}:`, error.message);
    }
  }
}

export async function startWorkerIfPending() {
  const pending = downloadTracker.getNextPending();
  if (!pending) return;
  if (weeklyFlowWorker.running) {
    weeklyFlowWorker.wake();
    return;
  }
  await weeklyFlowWorker.start();
}

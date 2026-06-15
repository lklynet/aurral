import { downloadTracker } from "./weeklyFlowDownloadTracker.js";
import { weeklyFlowWorker } from "./weeklyFlowWorker.js";
import { flowPlaylistConfig } from "./weeklyFlowPlaylistConfig.js";
import { slskdClient } from "./slskdClient.js";
import { weeklyFlowOperationQueue } from "./weeklyFlowOperationQueue.js";
import {
  createWeeklyFlowOperationToken,
  markLatestWeeklyFlowOperationToken,
} from "./weeklyFlowOperations.js";

export async function runScheduledRefresh() {
  if (!slskdClient.isConfigured()) return;

  const due = flowPlaylistConfig.getDueForRefresh();
  if (due.length === 0) return;

  for (const flow of due) {
    try {
      const token = createWeeklyFlowOperationToken();
      const tokenScope = `flow:${flow.id}:scheduled`;
      markLatestWeeklyFlowOperationToken(tokenScope, token);
      await weeklyFlowOperationQueue.enqueuePayload(
        {
          kind: "scheduled-flow-refresh",
          label: `scheduled:${flow.id}`,
          flowId: flow.id,
          tokenScope,
          token,
        },
        { waitForCompletion: false },
      );
    } catch (error) {
      console.error(
        `[WeeklyFlowScheduler] Failed to refresh ${flow.id}:`,
        error.message,
      );
    }
  }
}

export async function startWorkerIfPending() {
  const pending = downloadTracker.getNextPending();
  if (pending) {
    if (weeklyFlowWorker.running) {
      weeklyFlowWorker.wake();
      return;
    }
    await weeklyFlowWorker.start();
    return;
  }
  const flowIds = flowPlaylistConfig
    .getFlows()
    .filter((flow) => flow?.enabled === true)
    .map((flow) => flow.id);
  const sharedIds = flowPlaylistConfig
    .getSharedPlaylists()
    .map((playlist) => playlist.id);
  const playlistIds = [...new Set([...flowIds, ...sharedIds])];
  for (const playlistId of playlistIds) {
    await weeklyFlowWorker.retryIncompletePlaylist(playlistId);
  }
}

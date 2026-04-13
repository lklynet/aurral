import { downloadTracker } from "./weeklyFlowDownloadTracker.js";
import { weeklyFlowWorker } from "./weeklyFlowWorker.js";
import { playlistSource } from "./weeklyFlowPlaylistSource.js";
import { playlistManager } from "./weeklyFlowPlaylistManager.js";
import { flowPlaylistConfig } from "./weeklyFlowPlaylistConfig.js";
import { soulseekClient } from "./simpleSoulseekClient.js";
import { weeklyFlowOperationQueue } from "./weeklyFlowOperationQueue.js";

export async function runScheduledRefresh() {
  if (!soulseekClient.isConfigured()) return;

  const due = flowPlaylistConfig.getDueForRefresh();
  if (due.length === 0) return;

  for (const flow of due) {
    try {
      await weeklyFlowOperationQueue.enqueue(
        `scheduled:${flow.id}`,
        async () => {
          if (!flowPlaylistConfig.isEnabled(flow.id)) return;
          const flowStats = downloadTracker.getPlaylistTypeStats(flow.id);
          const shouldStopWorker =
            weeklyFlowWorker.running &&
            (flowStats.pending > 0 || flowStats.downloading > 0);
          if (shouldStopWorker) {
            weeklyFlowWorker.stop();
          }
          weeklyFlowWorker.clearIncompleteRetry(flow.id);
          playlistManager.updateConfig(false);
          await playlistManager.weeklyReset([flow.id]);
          downloadTracker.clearByPlaylistType(flow.id);

          const latestFlow = flowPlaylistConfig.getFlow(flow.id);
          if (!latestFlow || !latestFlow.enabled) return;
          const tracks = await playlistSource.getTracksForFlow(latestFlow);
          if (tracks.length === 0) {
            flowPlaylistConfig.scheduleNextRun(flow.id);
            if (shouldStopWorker) {
              const stillPending = downloadTracker.getNextPending();
              if (stillPending && !weeklyFlowWorker.running) {
                await weeklyFlowWorker.start();
              }
            }
            return;
          }

          downloadTracker.addJobs(tracks, flow.id);
          if (!weeklyFlowWorker.running) {
            await weeklyFlowWorker.start();
          } else {
            weeklyFlowWorker.wake();
          }
          flowPlaylistConfig.scheduleNextRun(flow.id);
          console.log(
            `[WeeklyFlowScheduler] Refreshed ${flow.id} (${tracks.length} tracks)`,
          );
        },
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

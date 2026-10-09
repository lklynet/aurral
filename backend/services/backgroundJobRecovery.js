import { ISOLATED_QUEUE_GROUPS } from "./backgroundWorkerQueues.js";
import { getHonkerDb, getHonkerQueueByName } from "./honkerDb.js";

async function releaseClaimedJob(database, row, logger, reason) {
  try {
    if (row.queue === "library-scan") {
      const { restoreLibraryScanAfterWorkerExit } = await import("./libraryScanWorker.js");
      restoreLibraryScanAfterWorkerExit(row.id);
    }
    if (row.queue === "discovery-user-refresh") {
      try {
        const { markInterruptedUserDiscoveryRefresh } = await import("./discovery/provider.js");
        const userId = Number(JSON.parse(row.payload || "{}").userId);
        if (Number.isInteger(userId) && userId > 0) {
          markInterruptedUserDiscoveryRefresh(userId, reason);
        }
      } catch (error) {
        logger.warn?.("[AppRuntime] Could not update discovery status:", error?.message || error);
      }
    }
    try {
      const { recordHonkerTaskRunFinished } = await import("./honkerTaskStatus.js");
      const runs = database.query(
        "SELECT id FROM honker_task_runs WHERE job_id = ? AND worker_id = ? AND status = 'running'",
        [row.id, row.worker_id],
      );
      for (const run of runs) {
        recordHonkerTaskRunFinished(run.id, "failed", reason);
      }
    } catch (error) {
      logger.warn?.(`[AppRuntime] Could not update ${row.queue} task history:`, error?.message || error);
    }
    // Honker registers retry on its queue connection, not on the raw query connection.
    getHonkerQueueByName(row.queue)._retry(row.id, row.worker_id, 1, reason);
  } catch (error) {
    logger.warn?.(`[AppRuntime] Could not requeue ${row.queue} job ${row.id}:`, error?.message || error);
  }
}

export async function recoverExitedWorkerJobs(group, pid, logger = console, reason = null) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  const database = getHonkerDb();
  const rows = database.query(
    "SELECT id, queue, payload, worker_id FROM _honker_live WHERE worker_id = ? AND state = 'processing'",
    [`aurral-${pid}`],
  );
  for (const row of rows) {
    if (ISOLATED_QUEUE_GROUPS[row.queue] !== group) continue;
    await releaseClaimedJob(database, row, logger, reason || "Background worker process exited");
  }
  if (group === "downloads") {
    const { downloadTracker } = await import("./downloadJobs/downloadTracker.js");
    downloadTracker.resetDownloadingToPending();
  }
}

// A job claimed before this process started belongs to a process that no
// longer exists, so it runs again now instead of after its claim expires.
// A claim stamps its expiry one visibility timeout ahead.
export async function recoverJobsClaimedBeforeStart(logger = console) {
  const startedAt = Math.floor(Date.now() / 1000 - process.uptime());
  const database = getHonkerDb();
  const rows = database.query(
    "SELECT id, queue, payload, worker_id, claim_expires_at FROM _honker_live WHERE state = 'processing'",
  );
  for (const row of rows) {
    const visibilityTimeoutS = Number(getHonkerQueueByName(row.queue)?.visibilityTimeoutS);
    if (!Number.isFinite(visibilityTimeoutS)) continue;
    if (Number(row.claim_expires_at) - visibilityTimeoutS >= startedAt) continue;
    await releaseClaimedJob(database, row, logger, "Aurral restarted");
  }
}

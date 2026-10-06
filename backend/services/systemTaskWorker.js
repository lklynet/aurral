import { acquireReleaseMetadataLease } from "./releaseMetadataLease.js";
import createHonkerWorker from "./honkerWorkerFactory.js";
import {
  getInboxTaskQueue,
  getMaintenanceTaskQueue,
  getSystemTaskQueue,
} from "./honkerDb.js";
import { cleanExpiredSessions } from "../config/session-helpers.js";

export async function processSystemTask(payload = {}, job = null, context = {}) {
  const kind = String(payload?.kind || "").trim();
  switch (kind) {
    case "flow-refresh": {
      const { runScheduledFlowRefresh } = await import("./flows/flowScheduler.js");
      await runScheduledFlowRefresh();
      return;
    }
    case "aurral-monitoring-apply": {
      const { libraryManager } = await import("./libraryManager.js");
      await libraryManager.acquireAurralReleases(payload);
      return;
    }
    case "aurral-monitoring-reconcile": {
      const { libraryManager } = await import("./libraryManager.js");
      await libraryManager.reconcileAurralMonitoring();
      return;
    }
    case "aurral-missing-track-search": {
      const { runMissingTrackSearch } = await import("./aurralMissingTrackSearch.js");
      await runMissingTrackSearch();
      return;
    }
    case "session-cleanup":
      cleanExpiredSessions();
      return;
    case "file-reuse-repair": {
      const { downloadWorker } = await import("./downloadJobs/downloadWorker.js");
      downloadWorker.scheduleReuseLinkRepair(false);
      return;
    }
    case "quality-upgrade-check": {
      const { runQualityUpgradeCheck } = await import("./qualityProfileService.js");
      await runQualityUpgradeCheck({
        force: payload.force === true,
        limit: payload.limit,
      });
      return;
    }
    case "quality-profile-refresh": {
      const { reclassifyQualityJobs, getQualityProfile } = await import(
        "./qualityProfileService.js"
      );
      await reclassifyQualityJobs({ enqueue: getQualityProfile().automaticUpgrades });
      return;
    }
    case "startup-file-reuse-repair": {
      const { downloadWorker } = await import("./downloadJobs/downloadWorker.js");
      downloadWorker.scheduleReuseLinkRepair(true);
      return;
    }
    case "discovery-refresh-check": {
      const { enqueueDiscoveryRefreshIfNeeded } = await import("./discovery/refreshScheduler.js");
      await enqueueDiscoveryRefreshIfNeeded({ reason: "interval" });
      return;
    }
    case "import-list-sync": {
      const { runDueImportSourceSyncs } = await import("./importLists/importListSync.js");
      await runDueImportSourceSyncs();
      return;
    }
    case "library-index-refresh": {
      return;
    }
    case "release-metadata-refresh": {
      const { refreshReleaseMetadata } = await import("./releaseMetadataSync.js");
      const result = await refreshReleaseMetadata({ signal: context.signal, lease: context.lease });
      const { websocketService } = await import("./websocketService.js");
      websocketService.broadcast("library", {
        type: "release_metadata_refreshed",
      });
      return result;
    }
    case "library-index-bootstrap": {
      const { hasCompletedLibraryScan, scheduleLibraryScan } = await import(
        "./libraryScanWorker.js"
      );
      if (!hasCompletedLibraryScan()) scheduleLibraryScan();
      return;
    }
    case "flow-startup-check": {
      const { startWorkerIfPending } = await import("./downloadJobs/downloadWorker.js");
      await startWorkerIfPending();
      return;
    }
    case "discovery-bootstrap": {
      const { bootstrapDiscoveryRefresh } = await import("./discovery/refreshScheduler.js");
      await bootstrapDiscoveryRefresh();
      return;
    }
    case "inbox-refresh": {
      const {
        enqueueInboxRefreshForAllUsers,
        refreshInboxForUser,
      } = await import("./inboxService.js");
      const userId = Number(payload.userId);
      if (Number.isInteger(userId) && userId > 0) {
        await refreshInboxForUser(userId, {
          force: true,
          throwOnFailure: true,
          jobId: job?.id || payload.jobId || null,
          zipCode: payload.zipCode || "",
          ipAddress: payload.ipAddress || "",
        });
      } else {
        await enqueueInboxRefreshForAllUsers({
          reason: payload.reason || "scheduled",
        });
      }
      return;
    }
    case "news-refresh": {
      const { refreshNewsFeeds } = await import("./newsService.js");
      await refreshNewsFeeds();
      return;
    }
    case "lidarr-retry": {
      const { libraryManager } = await import("./libraryManager.js");
      await libraryManager.syncLidarrArtists({ forceRefresh: true });
      if (process.connected && process.send) {
        process.send({ type: "cache-invalidate", cache: "lidarr-artists" });
      }
      return;
    }
    default:
      throw new Error(`Unknown system task: ${kind || "unknown"}`);
  }
}

const {
  start: startSystemTaskWorker,
  stop: stopSystemTaskWorker,
  isRunning: isSystemTaskWorkerRunning,
} = createHonkerWorker({
  name: "system-task",
  getQueue: getSystemTaskQueue,
  processJob: processSystemTask,
  idlePollS: 10,
  retryDelayS: 120,
});

export {
  startSystemTaskWorker,
  stopSystemTaskWorker,
  isSystemTaskWorkerRunning,
};

const { start: startMaintenanceTaskWorker } = createHonkerWorker({
  name: "system-task-maintenance",
  getQueue: getMaintenanceTaskQueue,
  processJob: processSystemTask,
  idlePollS: 10,
  retryDelayS: 120,
  onJobSuccess(payload) {
    if (payload?.kind === "news-refresh" && process.connected && process.send) {
      process.send({ type: "cache-invalidate", cache: "news" });
    }
  },
});

const { start: startInboxTaskWorker } = createHonkerWorker({
  name: "system-task-inbox",
  getQueue: getInboxTaskQueue,
  processJob: processSystemTask,
  idlePollS: 10,
  retryDelayS: 120,
});

export { startMaintenanceTaskWorker, startInboxTaskWorker };

export async function prepareSystemTask(payload, job, { signal }) {
  if (payload?.kind !== "release-metadata-refresh") return null;
  const lease = await acquireReleaseMetadataLease({ signal });
  return { lease, release: () => lease.release() };
}

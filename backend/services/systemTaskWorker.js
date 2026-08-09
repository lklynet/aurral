import createHonkerWorker from "./honkerWorkerFactory.js";
import { getSystemTaskQueue } from "./honkerDb.js";
import { cleanExpiredSessions } from "../config/session-helpers.js";

async function processSystemTask(payload = {}) {
  const kind = String(payload?.kind || "").trim();
  switch (kind) {
    case "weekly-flow-refresh": {
      const { runScheduledRefresh } = await import("./weeklyFlow/weeklyFlowScheduler.js");
      await runScheduledRefresh();
      return;
    }
    case "session-cleanup":
      cleanExpiredSessions();
      return;
    case "weekly-flow-reuse-repair": {
      const { weeklyFlowWorker } = await import("./weeklyFlow/weeklyFlowWorker.js");
      weeklyFlowWorker.scheduleReuseLinkRepair(false);
      return;
    }
    case "quality-upgrade-check": {
      const { runQualityUpgradeCheck } = await import("./qualityProfileService.js");
      await runQualityUpgradeCheck();
      return;
    }
    case "quality-profile-refresh": {
      const { reclassifyQualityJobs, getQualityProfile } = await import(
        "./qualityProfileService.js"
      );
      await reclassifyQualityJobs({ enqueue: getQualityProfile().automaticUpgrades });
      return;
    }
    case "weekly-flow-startup-reuse-repair": {
      const { weeklyFlowWorker } = await import("./weeklyFlow/weeklyFlowWorker.js");
      weeklyFlowWorker.scheduleReuseLinkRepair(true);
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
    case "weekly-flow-startup-check": {
      const { startWorkerIfPending } = await import("./weeklyFlow/weeklyFlowScheduler.js");
      await startWorkerIfPending();
      return;
    }
    case "discovery-bootstrap": {
      const { bootstrapDiscoveryRefresh } = await import("./discovery/refreshScheduler.js");
      await bootstrapDiscoveryRefresh();
      return;
    }
    case "inbox-refresh": {
      const { refreshInboxForAllUsers } = await import("./inboxService.js");
      await refreshInboxForAllUsers();
      return;
    }
    case "news-refresh": {
      const { refreshLibraryNews } = await import("./newsService.js");
      await refreshLibraryNews();
      return;
    }
    case "playlist-startup-migration": {
      const [
        { migrateLegacyPaths, resolvePlaylistRoot },
        trackerModule,
        { playlistManager },
        { repairYtdlpMetadata },
      ] = await Promise.all([
        import("./playlistPaths.js"),
        import("./weeklyFlow/weeklyFlowDownloadTracker.js"),
        import("./weeklyFlow/weeklyFlowPlaylistManager.js"),
        import("./playlistDownloadUtils.js"),
      ]);
      const result = await migrateLegacyPaths(
        resolvePlaylistRoot(),
        trackerModule.downloadTracker,
      );
      if (result.migrated > 0) {
        console.log(
          `[Playlists] Migrated ${result.migrated} legacy track paths to ${resolvePlaylistRoot()}`,
        );
      }
      const metadataRepair = await repairYtdlpMetadata(
        trackerModule.downloadTracker.getAll(),
      );
      if (metadataRepair.repaired > 0) {
        console.log(
          `[Playlists] Added metadata to ${metadataRepair.repaired} yt-dlp track(s)`,
        );
      }
      if (metadataRepair.failed > 0) {
        console.warn(
          `[Playlists] Could not add metadata to ${metadataRepair.failed} yt-dlp track(s)`,
        );
      }
      playlistManager.updateConfig(false);
      await playlistManager.ensurePlaylists();
      await playlistManager.scheduleScanLibrary(true);
      return;
    }
    case "lidarr-retry": {
      const { libraryManager } = await import("./libraryManager.js");
      await libraryManager.getAllArtists();
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

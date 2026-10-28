import type { Job } from "@russellthehippo/honker-node";
import { asAppError } from "../../lib/errors.ts";
import type { libraryManager } from "./libraryManager.ts";
import { acquireReleaseMetadataLease } from "./releaseMetadataLease.ts";
import createHonkerWorker from "./honkerWorkerFactory.ts";
import {
  getInboxTaskQueue,
  getMaintenanceTaskQueue,
  getPlaybackTaskQueue,
  getSystemTaskQueue,
  PLAYLIST_STARTUP_MIGRATION_SETTING,
  PLAYLIST_STARTUP_MIGRATION_VERSION,
  type HonkerPayload,
} from "./honkerDb.ts";
import { cleanExpiredSessions } from "../config/session-helpers.ts";
import { dbOps } from "../db/helpers/index.ts";
import { resolveDownloadRoot } from "./downloadPaths.ts";

type ReleaseMetadataLease = Awaited<ReturnType<typeof acquireReleaseMetadataLease>>;
type SystemTaskJob = Job & { payload: HonkerPayload | null };
type SystemTaskContext = { signal?: AbortSignal; lease?: ReleaseMetadataLease };
type PayloadValue = HonkerPayload[string] | undefined;
type MonitoringApply = NonNullable<Parameters<typeof libraryManager.acquireAurralReleases>[0]>;

const stringOrNull = (value: PayloadValue) => (typeof value === "string" ? value : null);

const stringList = (value: PayloadValue) =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : null;

const recordList = (value: PayloadValue) =>
  Array.isArray(value)
    ? value.filter(
        (entry): entry is HonkerPayload =>
          typeof entry === "object" && entry !== null && !Array.isArray(entry),
      )
    : [];

function parseMonitoringApply(payload: HonkerPayload): MonitoringApply {
  return {
    artistMbid: stringOrNull(payload.artistMbid) ?? undefined,
    token: stringOrNull(payload.token),
    releaseGroups: recordList(payload.releaseGroups).flatMap(({ id, title }) =>
      typeof id === "string" && typeof title === "string" ? [{ id, title }] : [],
    ),
    topTracks: recordList(payload.topTracks).flatMap(({ title, albumName, mbid, durationMs }) =>
      typeof title === "string"
        ? [
            {
              title,
              albumName: stringOrNull(albumName),
              mbid: stringOrNull(mbid),
              durationMs: typeof durationMs === "number" ? durationMs : null,
            },
          ]
        : [],
    ),
  };
}

export async function processSystemTask(
  payload: HonkerPayload | null = {},
  job: SystemTaskJob | null = null,
  context: SystemTaskContext = {},
) {
  const kind = String(payload?.kind || "").trim();
  switch (kind) {
    case "weekly-flow-refresh": {
      const { runScheduledFlowRefresh } = await import("./flows/flowScheduler.ts");
      await runScheduledFlowRefresh();
      return;
    }
    case "aurral-monitoring-apply": {
      const { libraryManager } = await import("./libraryManager.ts");
      await libraryManager.acquireAurralReleases(parseMonitoringApply(payload!));
      return;
    }
    case "aurral-monitoring-reconcile": {
      const { libraryManager } = await import("./libraryManager.ts");
      await libraryManager.reconcileAurralMonitoring();
      return;
    }
    case "aurral-missing-track-search": {
      const { runMissingTrackSearch } = await import("./aurralMissingTrackSearch.ts");
      await runMissingTrackSearch();
      return;
    }
    case "session-cleanup":
      cleanExpiredSessions();
      return;
    case "weekly-flow-reuse-repair": {
      const { downloadWorker } = await import("./downloadJobs/downloadWorker.ts");
      downloadWorker.scheduleReuseLinkRepair(false);
      return;
    }
    case "review-timeout": {
      const { denyExpiredReviews } = await import("./downloadJobs/blockedJobReview.ts");
      await denyExpiredReviews();
      return;
    }
    case "quality-upgrade-check": {
      const { runQualityUpgradeCheck } = await import("./qualityProfileService.ts");
      await runQualityUpgradeCheck({
        force: payload!.force === true,
        playlistIds:
          typeof payload!.playlistId === "string" && payload!.playlistId
            ? [payload!.playlistId]
            : null,
        limit: typeof payload!.limit === "number" ? payload!.limit : undefined,
      });
      return;
    }
    case "quality-profile-refresh": {
      const { reclassifyQualityJobs, getQualityProfile } =
        await import("./qualityProfileService.ts");
      await reclassifyQualityJobs({ enqueue: getQualityProfile().automaticUpgrades });
      return;
    }
    case "weekly-flow-startup-reuse-repair": {
      const { downloadWorker } = await import("./downloadJobs/downloadWorker.ts");
      downloadWorker.scheduleReuseLinkRepair(true);
      return;
    }
    case "discovery-refresh-check": {
      const { enqueueDiscoveryRefreshIfNeeded } = await import("./discovery/refreshScheduler.ts");
      await enqueueDiscoveryRefreshIfNeeded({ reason: "interval" });
      return;
    }
    case "share-playlist-refresh": {
      const { refreshPlaylistShares } = await import("./shareLinks/refresh.ts");
      await refreshPlaylistShares();
      return;
    }
    case "import-list-sync": {
      const { runDueImportSourceSyncs } = await import("./importLists/importListSync.ts");
      await runDueImportSourceSyncs();
      return;
    }
    case "playback-library-scan": {
      const { playlistManager } = await import("./playlists/playlistManager.ts");
      playlistManager.updateConfig();
      const results = await playlistManager.scanLibrary(
        stringList(payload!.folders) ?? playlistManager.libraryRoots(),
        stringList(payload!.destinations),
      );
      const failures = (results || []).filter((result) => !result.ok);
      if (failures.length) {
        throw new Error(
          failures.map((result) => `${result.destination}: ${result.error!.message}`).join("; "),
        );
      }
      return;
    }
    case "playback-playlist-sync": {
      const { playlistManager } = await import("./playlists/playlistManager.ts");
      playlistManager.updateConfig();
      await playlistManager.syncPlaylists({
        entityIds: stringList(payload!.entityIds),
        destinations: stringList(payload!.destinations),
        chain: stringOrNull(payload!.chain),
        attempt: typeof payload!.attempt === "number" ? payload!.attempt : undefined,
      });
      return;
    }
    case "library-index-refresh": {
      return;
    }
    case "release-metadata-refresh": {
      const { refreshReleaseMetadata } = await import("./releaseMetadataSync.ts");
      const result = await refreshReleaseMetadata({ signal: context.signal, lease: context.lease });
      const { websocketService } = await import("./websocketService.ts");
      websocketService.broadcast("library", {
        type: "release_metadata_refreshed",
      });
      return result;
    }
    case "library-index-bootstrap": {
      const { hasCompletedLibraryScan, scheduleLibraryScan } =
        await import("./libraryScanWorker.ts");
      const { lidarrClient } = await import("./lidarrClient.ts");
      const { hasLidarrLibraryData } = await import("./libraryMediaStore.ts");
      if (!hasCompletedLibraryScan() || (!lidarrClient.isConfigured() && hasLidarrLibraryData())) {
        scheduleLibraryScan();
      }
      return;
    }
    case "weekly-flow-startup-check": {
      const { startWorkerIfPending } = await import("./downloadJobs/downloadWorker.ts");
      await startWorkerIfPending();
      const { stopOrphanedSlskdSearches } =
        await import("./downloadJobs/downloadCancellationService.ts");
      await stopOrphanedSlskdSearches();
      return;
    }
    case "playlist-startup-publish": {
      const { playlistManager } = await import("./playlists/playlistManager.ts");
      playlistManager.requestPlaylistSync();
      return;
    }
    case "discovery-bootstrap": {
      const { bootstrapDiscoveryRefresh } = await import("./discovery/refreshScheduler.ts");
      await bootstrapDiscoveryRefresh();
      return;
    }
    case "inbox-refresh": {
      const { enqueueInboxRefreshForAllUsers, refreshInboxForUser } =
        await import("./inboxService.ts");
      const userId = Number(payload!.userId);
      if (Number.isInteger(userId) && userId > 0) {
        await refreshInboxForUser(userId, {
          force: true,
          throwOnFailure: true,
          jobId: job?.id || (typeof payload!.jobId === "number" ? payload!.jobId : null) || null,
          zipCode: stringOrNull(payload!.zipCode) || "",
          ipAddress: stringOrNull(payload!.ipAddress) || "",
        });
      } else {
        await enqueueInboxRefreshForAllUsers({
          reason: stringOrNull(payload!.reason) || "scheduled",
        });
      }
      return;
    }
    case "news-refresh": {
      const { refreshNewsFeeds } = await import("./newsService.ts");
      await refreshNewsFeeds();
      return;
    }
    case "trending-charts-refresh": {
      const { refreshTrendingCharts } = await import("./discovery/trendingCharts.ts");
      await refreshTrendingCharts();
      return;
    }
    case "playlist-startup-migration": {
      const [
        migrationModule,
        { ensurePlaylistFilesystemLayout },
        trackerModule,
        { repairYtdlpMetadata },
      ] = await Promise.all([
        import("./aurralDownloadFolderMigration.ts"),
        import("./playlistFilesystemMigration.ts"),
        import("./downloadJobs/downloadTracker.ts"),
        import("./downloadUtils.ts"),
      ]);
      const { migrateAurralDownloadFolder } = migrationModule;
      const layout = ensurePlaylistFilesystemLayout();
      let result;
      try {
        result = {
          flowMigrated: 0,
          failed: 0,
          repaired: 0,
          ...(await migrateAurralDownloadFolder()),
        };
      } catch (error) {
        console.error(
          `[Playlists] Aurral download folder migration failed: ${asAppError(error)?.message}`,
        );
        throw error;
      }
      const flowMigrated = result.flowMigrated || 0;
      const permanentMigrated = (result.migrated || 0) - flowMigrated;
      if (result.migrated > 0 || result.removed > 0) {
        console.log(
          `[Playlists] Migrated ${permanentMigrated} permanent track(s) and ${flowMigrated} flow track(s), and removed ${result.removed} unkept flow file(s)`,
        );
      }
      if (result.repaired > 0) {
        console.log(`[Playlists] Repaired ${result.repaired} migrated tracker path(s)`);
      }
      if (result.retained > 0 || result.failed > 0) {
        console.warn(
          `[Playlists] Retained ${result.retained} item(s) and failed ${result.failed} migration item(s) for review`,
        );
      }
      if (result.status === "blocked" || result.failed > 0) {
        throw new Error("Playlist filesystem migration requires review before playlist rebuild");
      }
      const metadataRepair = await repairYtdlpMetadata(trackerModule.downloadTracker.getAll());
      if (metadataRepair.repaired > 0) {
        console.log(`[Playlists] Added metadata to ${metadataRepair.repaired} yt-dlp track(s)`);
      }
      if (metadataRepair.failed > 0) {
        console.warn(
          `[Playlists] Could not add metadata to ${metadataRepair.failed} yt-dlp track(s)`,
        );
      }
      if (
        layout.sidecarsMoved > 0 ||
        result.migrated > 0 ||
        result.removed > 0 ||
        metadataRepair.repaired > 0
      ) {
        const { playlistManager } = await import("./playlists/playlistManager.ts");
        playlistManager.requestPlaylistSync();
      }
      if (metadataRepair.failed === 0) {
        dbOps.setJSONSetting(PLAYLIST_STARTUP_MIGRATION_SETTING, {
          version: PLAYLIST_STARTUP_MIGRATION_VERSION,
          rootPath: resolveDownloadRoot(),
          completedAt: Date.now(),
        });
      }
      return;
    }
    case "stored-data-migration": {
      const { migrateStoredData } = await import("./storedDataMigration.ts");
      migrateStoredData();
      return;
    }
    case "upgrade-readiness-check": {
      return;
    }
    case "identity-marker-migration": {
      const { migrateIdentityMarkers } = await import("./identityMarkerMigration.ts");
      const result = await migrateIdentityMarkers();
      if (result.moved > 0 || result.failed > 0) {
        console.log(
          `[Library] Moved the identity marker to its own tag in ${result.moved} file(s); ${result.failed} file(s) failed`,
        );
      }
      return;
    }
    case "lidarr-files-release": {
      const { downloadWorker } = await import("./downloadJobs/downloadWorker.ts");
      if (!("releaseLidarrFiles" in downloadWorker)) {
        throw new TypeError("downloadWorker.releaseLidarrFiles is not a function");
      }
      await downloadWorker.releaseLidarrFiles();
      return;
    }
    case "read-only-folder-release": {
      const { downloadWorker } = await import("./downloadJobs/downloadWorker.ts");
      if (!("releaseReadOnlyFolderFiles" in downloadWorker)) {
        throw new TypeError("downloadWorker.releaseReadOnlyFolderFiles is not a function");
      }
      await downloadWorker.releaseReadOnlyFolderFiles(stringList(payload!.folders) ?? []);
      return;
    }
    case "lidarr-retry": {
      const { libraryManager } = await import("./libraryManager.ts");
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
  interruptible: (payload) => payload?.kind === "release-metadata-refresh",
  prepareJob: prepareSystemTask,
  getQueue: getSystemTaskQueue,
  processJob: processSystemTask,
  idlePollS: 10,
  retryDelayS: 120,
});

export { startSystemTaskWorker, stopSystemTaskWorker, isSystemTaskWorkerRunning };

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

const { start: startPlaybackTaskWorker } = createHonkerWorker({
  name: "playback",
  getQueue: getPlaybackTaskQueue,
  processJob: processSystemTask,
  idlePollS: 10,
  retryDelayS: 120,
});

export { startMaintenanceTaskWorker, startInboxTaskWorker, startPlaybackTaskWorker };

export async function prepareSystemTask(
  payload: HonkerPayload | null,
  job: SystemTaskJob,
  { signal }: { signal: AbortSignal },
) {
  if (payload?.kind !== "release-metadata-refresh") return null;
  const lease = await acquireReleaseMetadataLease({ signal });
  return { lease, release: () => lease.release() };
}

import * as v from "valibot";
import type { libraryManager } from "./libraryManager.ts";
import { acquireReleaseMetadataLease } from "./releaseMetadataLease.ts";
import { createJobWorker, type TypedJob } from "./jobs/worker.ts";
import {
  inboxTaskQueue,
  maintenanceTaskQueue,
  playbackTaskQueue,
  systemTaskQueue,
  systemTaskSchema,
} from "./jobs/queues.ts";
import { cleanExpiredSessions } from "../config/session-helpers.ts";

type ReleaseMetadataLease = Awaited<ReturnType<typeof acquireReleaseMetadataLease>>;
type SystemTask = v.InferOutput<typeof systemTaskSchema>;
type SystemTaskJob = TypedJob<SystemTask>;
type SystemTaskContext = { signal?: AbortSignal; lease?: ReleaseMetadataLease };
type MonitoringApply = NonNullable<Parameters<typeof libraryManager.acquireAurralReleases>[0]>;

const stringOrNull = (value: unknown) => (typeof value === "string" ? value : null);

const stringList = (value: unknown) =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : null;

const recordList = (value: unknown) =>
  v.is(v.array(v.unknown()), value) ? value.filter((entry) => v.is(v.looseObject({}), entry)) : [];

function parseMonitoringApply(payload: SystemTask): MonitoringApply {
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
  payload: SystemTask,
  job: SystemTaskJob | null = null,
  context: SystemTaskContext = {},
) {
  const { kind } = payload;
  switch (kind) {
    case "wrapped-build": {
      if (typeof payload.userId !== "number" || typeof payload.timeZone !== "string")
        throw new Error("Invalid recap job");
      const { processWrappedBuild } = await import("./wrapped/reports.ts");
      await processWrappedBuild(payload.userId, payload.timeZone);
      return;
    }
    case "flow-refresh": {
      const { runScheduledFlowRefresh } = await import("./flows/flowScheduler.ts");
      await runScheduledFlowRefresh();
      return;
    }
    case "aurral-monitoring-apply": {
      const { libraryManager } = await import("./libraryManager.ts");
      await libraryManager.acquireAurralReleases(parseMonitoringApply(payload));
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
    case "flow-reuse-repair": {
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
        force: payload.force === true,
        playlistIds:
          typeof payload.playlistId === "string" && payload.playlistId
            ? [payload.playlistId]
            : null,
        limit: typeof payload.limit === "number" ? payload.limit : undefined,
      });
      return;
    }
    case "quality-profile-refresh": {
      const { reclassifyQualityJobs, getQualityProfile } =
        await import("./qualityProfileService.ts");
      await reclassifyQualityJobs({ enqueue: getQualityProfile().automaticUpgrades });
      return;
    }
    case "flow-startup-reuse-repair": {
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
    case "playback-library-scan":
      return;
    case "history-server-sync": {
      const { HISTORY_SERVER_PROVIDERS, syncAllHistoryServers, syncHistoryServer } =
        await import("./historyServers.ts");
      if (
        typeof payload.userId === "number" &&
        v.is(v.picklist(HISTORY_SERVER_PROVIDERS), payload.provider)
      ) {
        await syncHistoryServer(payload.userId, payload.provider);
      } else {
        await syncAllHistoryServers();
      }
      return;
    }
    case "playback-server-cleanup": {
      const { cleanUpPlaybackServers } = await import("./playbackServerCleanup.ts");
      await cleanUpPlaybackServers();
      return;
    }
    case "playback-playlist-sync": {
      const { playlistManager } = await import("./playlists/playlistManager.ts");
      await playlistManager.syncPlaylists({
        entityIds: stringList(payload.entityIds),
        rewrite: payload.rewrite === true,
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
    case "flow-startup-check": {
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
      const userId = Number(payload.userId);
      if (Number.isInteger(userId) && userId > 0) {
        await refreshInboxForUser(userId, {
          force: true,
          throwOnFailure: true,
          jobId: job?.id || (typeof payload.jobId === "number" ? payload.jobId : null) || null,
          zipCode: stringOrNull(payload.zipCode) || "",
          ipAddress: stringOrNull(payload.ipAddress) || "",
        });
      } else {
        await enqueueInboxRefreshForAllUsers({
          reason: stringOrNull(payload.reason) || "scheduled",
        });
      }
      return;
    }
    case "news-refresh": {
      const { refreshNewsFeeds } = await import("./newsService.ts");
      await refreshNewsFeeds();
      return;
    }
    case "plugin-schedules": {
      const { runDuePluginSchedules } = await import("./plugins/pluginSchedule.ts");
      await runDuePluginSchedules();
      return;
    }
    case "plugin-update-check": {
      const { checkPluginUpdates } = await import("./plugins/pluginInstaller.ts");
      await checkPluginUpdates();
      return;
    }
    case "update-check": {
      const { checkForUpdates } = await import("./updates.ts");
      await checkForUpdates();
      return;
    }
    case "trending-charts-refresh": {
      const { getChartStarterArtists, refreshTrendingCharts } =
        await import("./discovery/trendingCharts.ts");
      const hadStarters = getChartStarterArtists(1).length > 0;
      await refreshTrendingCharts();
      if (!hadStarters && getChartStarterArtists(1).length > 0) {
        const { enqueueAllUserDiscoveryRefreshes } = await import("./discovery/provider.ts");
        enqueueAllUserDiscoveryRefreshes("charts_ready");
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
      await downloadWorker.releaseReadOnlyFolderFiles(stringList(payload.folders) ?? []);
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

const notifyNewsRefreshed = (payload: SystemTask) => {
  if (payload.kind === "news-refresh" && process.connected && process.send) {
    process.send({ type: "cache-invalidate", cache: "news" });
  }
};

const workers = new Map(
  [systemTaskQueue, maintenanceTaskQueue, inboxTaskQueue, playbackTaskQueue].map((queue) => [
    queue.name,
    createJobWorker(queue, {
      schema: systemTaskSchema,
      processJob: processSystemTask,
      onJobSuccess: notifyNewsRefreshed,
    }),
  ]),
);

export function startSystemTaskWorker(name: string) {
  return workers.get(name)?.start();
}

export async function prepareSystemTask(
  payload: SystemTask,
  job: SystemTaskJob,
  { signal }: { signal: AbortSignal },
) {
  if (payload.kind !== "release-metadata-refresh") return null;
  const lease = await acquireReleaseMetadataLease({ signal });
  return { lease, release: () => lease.release() };
}

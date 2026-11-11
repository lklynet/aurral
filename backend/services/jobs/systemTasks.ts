import fs from "node:fs";
import * as v from "valibot";
import { isOwnKey } from "../../../lib/ownKey.ts";
import { cleanExpiredSessions } from "../../config/session-helpers.ts";
import type { libraryManager } from "../libraryManager.ts";
import { acquireReleaseMetadataLease } from "../releaseMetadataLease.ts";
import type { EnqueueOptions, Queue } from "./queue.ts";
import {
  inboxTaskQueue,
  maintenanceTaskQueue,
  playbackTaskQueue,
  releaseMetadataQueue,
  systemTaskQueue,
} from "./queues.ts";
import type { TypedJob } from "./worker.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

type ReleaseMetadataLease = Awaited<ReturnType<typeof acquireReleaseMetadataLease>>;
type MonitoringApply = NonNullable<Parameters<typeof libraryManager.acquireReleases>[0]>;
type Payload = { readonly [key: string]: unknown };
type RunContext = {
  job: TypedJob<SystemTask> | null;
  signal?: AbortSignal;
  lease?: ReleaseMetadataLease;
};
type QueueKey = "system" | "playback" | "maintenance" | "inbox" | "releaseMetadata";

interface SystemTaskDefinition {
  queue: QueueKey;
  label?: string;
  description?: string;
  schedule?: { everyMs: number; priority?: number };
  startup?: { delayMs: number; priority: number };
  invalidates?: "news";
  interruptible?: true;
  prepare?: (context: {
    signal: AbortSignal;
  }) => Promise<{ lease: ReleaseMetadataLease; release: () => void }>;
  run: (payload: Payload, context: RunContext) => unknown;
}

const stringOrNull = (value: unknown) => (typeof value === "string" ? value : null);

const stringList = (value: unknown) =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : null;

const recordList = (value: unknown) =>
  v.is(v.array(v.unknown()), value) ? value.filter((entry) => v.is(v.looseObject({}), entry)) : [];

function parseMonitoringApply(payload: Payload): MonitoringApply {
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

// Kinds that no longer do anything. Jobs queued before an upgrade may still carry them.
const retired = (queue: QueueKey): SystemTaskDefinition => ({ queue, run() {} });

const SYSTEM_TASKS = {
  "flow-startup-check": {
    queue: "system",
    label: "Startup playlist schedule check",
    description: "Resumes playlist work and stops orphaned slskd searches at startup.",
    startup: { delayMs: 5000, priority: 5 },
    async run() {
      const { startWorkerIfPending } = await import("../downloadJobs/downloadWorker.ts");
      await startWorkerIfPending();
      const { stopOrphanedSlskdSearches } =
        await import("../downloadJobs/downloadCancellationService.ts");
      await stopOrphanedSlskdSearches();
    },
  },
  "playlist-startup-publish": {
    queue: "system",
    label: "Startup playlist publish",
    description: "Queues a playlist file sync after Aurral starts.",
    startup: { delayMs: 10_000, priority: 0 },
    async run() {
      const { playlistManager } = await import("../playlists/playlistManager.ts");
      playlistManager.requestPlaylistSync();
    },
  },
  "discovery-bootstrap": {
    queue: "system",
    label: "Discovery startup check",
    description: "Initializes discovery data and schedules the next refresh.",
    startup: { delayMs: 15_000, priority: 5 },
    async run() {
      const { bootstrapDiscoveryRefresh } = await import("../discovery/refreshScheduler.ts");
      await bootstrapDiscoveryRefresh();
    },
  },
  "library-index-bootstrap": {
    queue: "system",
    startup: { delayMs: 8000, priority: 0 },
    async run() {
      const { hasCompletedLibraryScan, scheduleLibraryScan } =
        await import("../libraryScanWorker.ts");
      const { readOnlyFolderPaths } = await import("../libraryFolders.ts");
      const unscannedReadOnly = readOnlyFolderPaths().some(
        (folder) => fs.existsSync(folder) && !hasCompletedLibraryScan("readonly", folder),
      );
      if (!hasCompletedLibraryScan() || unscannedReadOnly) scheduleLibraryScan();
    },
  },
  "release-metadata-refresh": {
    queue: "releaseMetadata",
    label: "Release metadata refresh",
    description: "Refreshes recent and upcoming releases from BrainzMash.",
    schedule: { everyMs: 24 * HOUR, priority: -5 },
    startup: { delayMs: 12_000, priority: -5 },
    interruptible: true,
    async prepare({ signal }) {
      const lease = await acquireReleaseMetadataLease({ signal });
      return { lease, release: () => lease.release() };
    },
    async run(_payload, { signal, lease }) {
      const { refreshReleaseMetadata } = await import("../releaseMetadataSync.ts");
      const result = await refreshReleaseMetadata({ signal, lease });
      const { websocketService } = await import("../websocketService.ts");
      websocketService.broadcast("library", { type: "release_metadata_refreshed" });
      return result;
    },
  },
  "news-refresh": {
    queue: "maintenance",
    schedule: { everyMs: 15 * MINUTE },
    startup: { delayMs: 20_000, priority: -5 },
    invalidates: "news",
    async run() {
      const { refreshNewsFeeds } = await import("../newsService.ts");
      await refreshNewsFeeds();
    },
  },
  "trending-charts-refresh": {
    queue: "maintenance",
    label: "Trending charts refresh",
    description: "Updates the Trending charts from Deezer and Apple Music.",
    schedule: { everyMs: 6 * HOUR },
    startup: { delayMs: 25_000, priority: -5 },
    async run() {
      const { getChartStarterArtists, refreshTrendingCharts } =
        await import("../discovery/trendingCharts.ts");
      const hadStarters = getChartStarterArtists(1).length > 0;
      await refreshTrendingCharts();
      if (!hadStarters && getChartStarterArtists(1).length > 0) {
        const { enqueueAllUserDiscoveryRefreshes } =
          await import("../discovery/userRefreshRequests.ts");
        enqueueAllUserDiscoveryRefreshes("charts_ready");
      }
    },
  },
  "flow-refresh": {
    queue: "maintenance",
    label: "Playlist schedule check",
    description: "Queues enabled playlist flows that are due to run.",
    schedule: { everyMs: HOUR },
    async run() {
      const { runScheduledFlowRefresh } = await import("../flows/flowScheduler.ts");
      await runScheduledFlowRefresh();
    },
  },
  "session-cleanup": {
    queue: "maintenance",
    label: "Session cleanup",
    description: "Removes expired sign-in sessions.",
    schedule: { everyMs: HOUR },
    run: () => cleanExpiredSessions(),
  },
  "flow-reuse-repair": {
    queue: "system",
    label: "Playlist file reuse repair",
    description: "Repairs reusable playlist file links when source files move.",
    schedule: { everyMs: 30 * MINUTE },
    async run() {
      const { downloadWorker } = await import("../downloadJobs/downloadWorker.ts");
      downloadWorker.scheduleReuseLinkRepair(false);
    },
  },
  "flow-startup-reuse-repair": {
    queue: "system",
    label: "Startup playlist reuse repair",
    description: "Checks reusable playlist links after Aurral starts.",
    async run() {
      const { downloadWorker } = await import("../downloadJobs/downloadWorker.ts");
      downloadWorker.scheduleReuseLinkRepair(true);
    },
  },
  "review-timeout": {
    queue: "system",
    label: "Review timeout",
    description: "Denies tracks past the review deadline.",
    schedule: { everyMs: 15 * MINUTE },
    async run() {
      const { denyExpiredReviews } = await import("../downloadJobs/blockedJobReview.ts");
      await denyExpiredReviews();
    },
  },
  "quality-upgrade-check": {
    queue: "system",
    schedule: { everyMs: HOUR, priority: -10 },
    async run(payload) {
      const { runQualityUpgradeCheck } = await import("../qualityProfileService.ts");
      await runQualityUpgradeCheck({
        force: payload.force === true,
        playlistIds:
          typeof payload.playlistId === "string" && payload.playlistId
            ? [payload.playlistId]
            : null,
        limit: typeof payload.limit === "number" ? payload.limit : undefined,
      });
    },
  },
  "quality-profile-refresh": {
    queue: "system",
    async run() {
      const { reclassifyQualityJobs } = await import("../qualityProfileService.ts");
      const { getQualityProfile } = await import("../qualityProfile.ts");
      await reclassifyQualityJobs({ enqueue: getQualityProfile().automaticUpgrades });
    },
  },
  "discovery-refresh-check": {
    queue: "system",
    label: "Discovery auto refresh check",
    description: "Checks whether discovery recommendations need a scheduled refresh.",
    schedule: { everyMs: 15 * MINUTE },
    async run() {
      const { enqueueDiscoveryRefreshIfNeeded } = await import("../discovery/refreshScheduler.ts");
      await enqueueDiscoveryRefreshIfNeeded({ reason: "interval" });
    },
  },
  "inbox-refresh": {
    queue: "inbox",
    label: "Inbox refresh",
    description: "Refreshes release, show, news, and discovery updates.",
    schedule: { everyMs: 24 * HOUR },
    async run(payload, { job }) {
      const { enqueueInboxRefreshForAllUsers, refreshInboxForUser } =
        await import("../inboxService.ts");
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
    },
  },
  "update-check": {
    queue: "maintenance",
    label: "Update check",
    description: "Checks aurral.org for a newer Aurral build in this channel.",
    schedule: { everyMs: HOUR },
    async run() {
      const { checkForUpdates } = await import("../updates.ts");
      await checkForUpdates();
    },
  },
  "plugin-update-check": {
    queue: "maintenance",
    schedule: { everyMs: 24 * HOUR },
    async run() {
      const { checkPluginUpdates } = await import("../plugins/pluginInstaller.ts");
      await checkPluginUpdates();
    },
  },
  "plugin-schedules": {
    queue: "maintenance",
    schedule: { everyMs: 15 * MINUTE },
    async run() {
      const { runDuePluginSchedules } = await import("../plugins/pluginSchedule.ts");
      await runDuePluginSchedules();
    },
  },
  "import-list-sync": {
    queue: "system",
    schedule: { everyMs: 30 * MINUTE },
    async run() {
      const { runDueImportSourceSyncs } = await import("../importLists/importListSync.ts");
      await runDueImportSourceSyncs();
    },
  },
  "history-server-sync": {
    queue: "system",
    label: "Listening history import",
    description: "Imports new plays from connected Navidrome, Plex, and Jellyfin servers.",
    schedule: { everyMs: HOUR },
    async run(payload) {
      const { HISTORY_SERVER_PROVIDERS, syncAllHistoryServers, syncHistoryServer } =
        await import("../historyServers.ts");
      if (
        typeof payload.userId === "number" &&
        v.is(v.picklist(HISTORY_SERVER_PROVIDERS), payload.provider)
      ) {
        await syncHistoryServer(payload.userId, payload.provider);
      } else {
        await syncAllHistoryServers();
      }
    },
  },
  "share-playlist-refresh": {
    queue: "system",
    schedule: { everyMs: 24 * HOUR },
    async run() {
      const { refreshPlaylistShares } = await import("../shareLinks/refresh.ts");
      await refreshPlaylistShares();
    },
  },
  "aurral-monitoring-reconcile": {
    queue: "system",
    schedule: { everyMs: 24 * HOUR },
    async run() {
      const { libraryManager } = await import("../libraryManager.ts");
      await libraryManager.reconcileMonitoring();
    },
  },
  "aurral-missing-track-search": {
    queue: "system",
    schedule: { everyMs: HOUR },
    async run() {
      const { runMissingTrackSearch } = await import("../missingTrackSearch.ts");
      await runMissingTrackSearch();
    },
  },
  "aurral-monitoring-apply": {
    queue: "system",
    async run(payload) {
      const { libraryManager } = await import("../libraryManager.ts");
      await libraryManager.acquireReleases(parseMonitoringApply(payload));
    },
  },
  "wrapped-build": {
    queue: "maintenance",
    async run(payload) {
      if (typeof payload.userId !== "number" || typeof payload.timeZone !== "string")
        throw new Error("Invalid recap job");
      const { processWrappedBuild } = await import("../wrapped/reports.ts");
      await processWrappedBuild(payload.userId, payload.timeZone);
    },
  },
  "playback-server-cleanup": {
    queue: "system",
    label: "Old media server playlist cleanup",
    description:
      "Removes the playlists Aurral used to create in Navidrome, Plex, and Jellyfin, then forgets those connections.",
    async run() {
      const { cleanUpPlaybackServers } = await import("../playbackServerCleanup.ts");
      await cleanUpPlaybackServers();
    },
  },
  "playback-playlist-sync": {
    queue: "playback",
    label: "Playlist file sync",
    description:
      "Writes a playlist file for each flow and playlist, then writes changed files again once media servers have scanned new tracks.",
    async run(payload) {
      const { playlistManager } = await import("../playlists/playlistManager.ts");
      await playlistManager.syncPlaylists({
        entityIds: stringList(payload.entityIds),
        rewrite: payload.rewrite === true,
      });
    },
  },
  "read-only-folder-release": {
    queue: "system",
    label: "Read-only folder removed",
    description: "Downloads Aurral copies of playlist and flow tracks that used its files.",
    async run(payload) {
      const { downloadWorker } = await import("../downloadJobs/downloadWorker.ts");
      if (!("releaseReadOnlyFolderFiles" in downloadWorker)) {
        throw new TypeError("downloadWorker.releaseReadOnlyFolderFiles is not a function");
      }
      await downloadWorker.releaseReadOnlyFolderFiles(stringList(payload.folders) ?? []);
    },
  },
  "lidarr-files-release": retired("system"),
  "lidarr-retry": retired("system"),
  "playback-library-scan": retired("playback"),
  "library-index-refresh": retired("system"),
} satisfies Record<string, SystemTaskDefinition>;

export type SystemTaskKind = keyof typeof SYSTEM_TASKS;
export type SystemTask = { kind: SystemTaskKind; [key: string]: unknown };

const isSystemTaskKind = (kind: unknown): kind is SystemTaskKind =>
  typeof kind === "string" && isOwnKey(SYSTEM_TASKS, kind);

export const systemTaskSchema = v.looseObject({ kind: v.custom<SystemTaskKind>(isSystemTaskKind) });

const QUEUES: Record<QueueKey, Queue<SystemTask>> = {
  system: systemTaskQueue,
  playback: playbackTaskQueue,
  maintenance: maintenanceTaskQueue,
  inbox: inboxTaskQueue,
  releaseMetadata: releaseMetadataQueue,
};

export const SYSTEM_TASK_QUEUES = Object.values(QUEUES);

const titleize = (value: string) =>
  value
    .replace(/[-_:]+/g, " ")
    .trim()
    .replace(/^\w/, (letter) => letter.toUpperCase());

export function describeSystemTask(kind: string) {
  const task: SystemTaskDefinition | null = isSystemTaskKind(kind) ? SYSTEM_TASKS[kind] : null;
  return {
    label: task?.label ?? (titleize(kind) || "System task"),
    description: task?.description ?? systemTaskQueue.description ?? "",
  };
}

export function systemTaskQueueFor(kind: SystemTaskKind) {
  return QUEUES[SYSTEM_TASKS[kind].queue];
}

export function enqueueSystemTask(payload: SystemTask, options?: EnqueueOptions<SystemTask>) {
  return systemTaskQueueFor(payload.kind).enqueue(payload, options);
}

export function systemTask(kind: SystemTaskKind): SystemTaskDefinition {
  return SYSTEM_TASKS[kind];
}

const tasksWith = <Field extends "schedule" | "startup">(field: Field) =>
  Object.entries(SYSTEM_TASKS).flatMap(([kind, task]: [string, SystemTaskDefinition]) => {
    const value = task[field];
    return isSystemTaskKind(kind) && value ? [{ kind, ...value }] : [];
  });

export const SYSTEM_TASK_SCHEDULES = tasksWith("schedule");
export const SYSTEM_TASK_STARTUPS = tasksWith("startup");

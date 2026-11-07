import * as v from "valibot";
import { isOwnKey } from "../../../lib/ownKey.ts";
import { defineQueue, type EnqueueOptions, type Queue } from "./queue.ts";
import type { pipelinePayloadSchema } from "../downloadPipelineWorker.ts";
import type { playlistOperationSchema } from "../playlists/playlistOperations.ts";
import type { playlistMbidEnrichmentSchema } from "../playlistMbidEnrichmentWorker.ts";
import type { libraryScanSchema } from "../libraryScanWorker.ts";
import type { libraryFileJobSchema } from "../libraryFiles/libraryFileWorker.ts";
import type { discoveryRefreshSchema } from "../discoveryRefreshWorker.ts";
import type { discoveryUserRefreshSchema } from "../discoveryUserRefreshWorker.ts";
import type { queuedNotificationSchema } from "../notificationService.ts";
import type { playEventDeliverySchema } from "../playEventService.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const PIPELINE_PHASE_PRIORITY = { search: 0, poll: 10, download: 20, finalize: 30 };

export const downloadPipelineQueue = defineQueue<v.InferOutput<typeof pipelinePayloadSchema>>({
  name: "download-pipeline",
  group: "downloads",
  leaseMs: 20 * MINUTE,
  maxAttempts: 5,
  retryDelayMs: 30_000,
  timeoutMs: 6 * HOUR,
  start: (): Promise<unknown> =>
    import("../downloadPipelineWorker.ts").then((m) => m.startDownloadPipelineWorker()),
  priority: (payload) => {
    const phase = String(payload.phase || "").toLowerCase();
    const base = isOwnKey(PIPELINE_PHASE_PRIORITY, phase) ? PIPELINE_PHASE_PRIORITY[phase] : 0;
    return base - (payload.upgrade ? 100 : 0);
  },
});

export const SYSTEM_TASK_KINDS = [
  "aurral-missing-track-search",
  "aurral-monitoring-apply",
  "aurral-monitoring-reconcile",
  "discovery-bootstrap",
  "discovery-refresh-check",
  "flow-refresh",
  "flow-reuse-repair",
  "flow-startup-check",
  "flow-startup-reuse-repair",
  "history-server-sync",
  "identity-marker-migration",
  "import-list-sync",
  "inbox-refresh",
  "library-index-bootstrap",
  "library-index-refresh",
  "lidarr-files-release",
  "lidarr-retry",
  "news-refresh",
  "playback-library-scan",
  "playback-playlist-sync",
  "playback-server-cleanup",
  "playlist-startup-migration",
  "playlist-startup-publish",
  "plugin-schedules",
  "plugin-update-check",
  "quality-profile-refresh",
  "quality-upgrade-check",
  "read-only-folder-release",
  "release-metadata-refresh",
  "review-timeout",
  "session-cleanup",
  "share-playlist-refresh",
  "stored-data-migration",
  "trending-charts-refresh",
  "update-check",
  "upgrade-readiness-check",
  "wrapped-build",
] as const;

export type SystemTaskKind = (typeof SYSTEM_TASK_KINDS)[number];

export const systemTaskSchema = v.looseObject({ kind: v.picklist(SYSTEM_TASK_KINDS) });

type SystemTask = v.InferOutput<typeof systemTaskSchema>;

const defineSystemTaskQueue = (name: string, group: "downloads" | "maintenance" | "inbox") =>
  defineQueue<SystemTask>({
    name,
    group,
    leaseMs: HOUR,
    maxAttempts: 3,
    retryDelayMs: 2 * MINUTE,
    timeoutMs: group === "downloads" ? 2 * HOUR : 15 * MINUTE,
    start: (): Promise<unknown> =>
      import("../systemTaskWorker.ts").then((m) => m.startSystemTaskWorker(name)),
  });

export const systemTaskQueue = defineSystemTaskQueue("system-task", "downloads");
export const playbackTaskQueue = defineSystemTaskQueue("playback", "downloads");
export const maintenanceTaskQueue = defineSystemTaskQueue("system-task-maintenance", "maintenance");
export const inboxTaskQueue = defineSystemTaskQueue("system-task-inbox", "inbox");

export const releaseMetadataQueue = defineQueue<SystemTask>({
  name: "release-metadata-refresh",
  group: "release-metadata",
  leaseMs: HOUR,
  maxAttempts: 3,
  retryDelayMs: 2 * MINUTE,
  timeoutMs: 2 * HOUR,
  skipInTest: true,
  start: (): Promise<unknown> =>
    import("../releaseMetadataWorker.ts").then((m) => m.startReleaseMetadataWorker()),
});

const SYSTEM_TASK_QUEUES: Record<SystemTaskKind, Queue<SystemTask>> = {
  "aurral-missing-track-search": systemTaskQueue,
  "aurral-monitoring-apply": systemTaskQueue,
  "aurral-monitoring-reconcile": systemTaskQueue,
  "discovery-bootstrap": systemTaskQueue,
  "discovery-refresh-check": systemTaskQueue,
  "flow-refresh": maintenanceTaskQueue,
  "flow-reuse-repair": systemTaskQueue,
  "flow-startup-check": systemTaskQueue,
  "flow-startup-reuse-repair": systemTaskQueue,
  "history-server-sync": systemTaskQueue,
  "identity-marker-migration": systemTaskQueue,
  "import-list-sync": systemTaskQueue,
  "inbox-refresh": inboxTaskQueue,
  "library-index-bootstrap": systemTaskQueue,
  "library-index-refresh": systemTaskQueue,
  "lidarr-files-release": systemTaskQueue,
  "lidarr-retry": systemTaskQueue,
  "news-refresh": maintenanceTaskQueue,
  "playback-library-scan": playbackTaskQueue,
  "playback-playlist-sync": playbackTaskQueue,
  "playback-server-cleanup": systemTaskQueue,
  "playlist-startup-migration": systemTaskQueue,
  "playlist-startup-publish": systemTaskQueue,
  "plugin-schedules": maintenanceTaskQueue,
  "plugin-update-check": maintenanceTaskQueue,
  "quality-profile-refresh": systemTaskQueue,
  "quality-upgrade-check": systemTaskQueue,
  "read-only-folder-release": systemTaskQueue,
  "release-metadata-refresh": releaseMetadataQueue,
  "review-timeout": systemTaskQueue,
  "session-cleanup": maintenanceTaskQueue,
  "share-playlist-refresh": systemTaskQueue,
  "stored-data-migration": systemTaskQueue,
  "trending-charts-refresh": maintenanceTaskQueue,
  "update-check": maintenanceTaskQueue,
  "upgrade-readiness-check": systemTaskQueue,
  "wrapped-build": maintenanceTaskQueue,
};

export function systemTaskQueueFor(kind: SystemTaskKind) {
  return SYSTEM_TASK_QUEUES[kind];
}

export function enqueueSystemTask(payload: SystemTask, options?: EnqueueOptions<SystemTask>) {
  return systemTaskQueueFor(payload.kind).enqueue(payload, options);
}

const playlistQueue = (
  name: string,
  start: "startPlaylistOperationWorker" | "startFlowRunWorker",
) =>
  defineQueue<v.InferOutput<typeof playlistOperationSchema>>({
    name,
    group: "downloads",
    leaseMs: HOUR,
    maxAttempts: 3,
    retryDelayMs: MINUTE,
    timeoutMs: 2 * HOUR,
    start: (): Promise<unknown> =>
      import("../playlists/playlistOperationWorker.ts").then((m) => m[start]()),
  });

export const playlistOperationQueue = playlistQueue(
  "playlist-operation",
  "startPlaylistOperationWorker",
);
export const flowRunQueue = playlistQueue("flow-run", "startFlowRunWorker");

export const playlistMbidEnrichmentQueue = defineQueue<
  v.InferOutput<typeof playlistMbidEnrichmentSchema>
>({
  name: "playlist-mbid-enrichment",
  group: "downloads",
  leaseMs: HOUR,
  maxAttempts: 4,
  retryDelayMs: 5 * MINUTE,
  timeoutMs: 2 * HOUR,
  skipInTest: true,
  start: (): Promise<unknown> =>
    import("../playlistMbidEnrichmentWorker.ts").then((m) => m.startPlaylistMbidEnrichmentWorker()),
});

export const libraryScanQueue = defineQueue<v.InferOutput<typeof libraryScanSchema>>({
  name: "library-scan",
  group: "library",
  leaseMs: 10 * MINUTE,
  maxAttempts: 3,
  retryDelayMs: MINUTE,
  timeoutMs: 6 * HOUR,
  skipInTest: true,
  start: (): Promise<unknown> =>
    import("../libraryScanWorker.ts").then((m) => m.startLibraryScanWorker()),
  onAbandoned: async (job): Promise<void> => {
    const { restoreLibraryScanAfterWorkerExit } = await import("../libraryScanWorker.ts");
    restoreLibraryScanAfterWorkerExit(job.id);
  },
});

export const libraryFileQueue = defineQueue<v.InferOutput<typeof libraryFileJobSchema>>({
  name: "library-files",
  group: "downloads",
  leaseMs: 10 * MINUTE,
  maxAttempts: 5,
  retryDelayMs: 30_000,
  timeoutMs: 6 * HOUR,
  skipInTest: true,
  start: (): Promise<unknown> =>
    import("../libraryFiles/libraryFileWorker.ts").then((m) => m.startLibraryFileWorker()),
});

export const discoveryRefreshQueue = defineQueue<v.InferOutput<typeof discoveryRefreshSchema>>({
  name: "discovery-refresh",
  group: "discovery-refresh",
  leaseMs: HOUR,
  maxAttempts: 4,
  retryDelayMs: 5 * MINUTE,
  timeoutMs: 2 * HOUR,
  skipInTest: true,
  start: (): Promise<unknown> =>
    import("../discoveryRefreshWorker.ts").then((m) => m.startDiscoveryRefreshWorker()),
});

export const discoveryUserRefreshQueue = defineQueue<
  v.InferOutput<typeof discoveryUserRefreshSchema>
>({
  name: "discovery-user-refresh",
  group: "discovery-user-refresh",
  leaseMs: HOUR,
  maxAttempts: 4,
  retryDelayMs: 5 * MINUTE,
  timeoutMs: 2 * HOUR,
  skipInTest: true,
  start: (): Promise<unknown> =>
    import("../discoveryUserRefreshWorker.ts").then((m) => m.startDiscoveryUserRefreshWorker()),
  onAbandoned: async (job, reason): Promise<void> => {
    const { parseJobPayload } = await import("./queue.ts");
    const userId = Number(parseJobPayload(job.payload)?.userId);
    if (!Number.isInteger(userId) || userId <= 0) return;
    const { markInterruptedUserDiscoveryRefresh } = await import("../discovery/provider.ts");
    markInterruptedUserDiscoveryRefresh(userId, reason);
  },
});

export const notificationQueue = defineQueue<v.InferOutput<typeof queuedNotificationSchema>>({
  name: "notifications",
  group: "notifications",
  leaseMs: 2 * MINUTE,
  maxAttempts: 5,
  retryDelayMs: 30_000,
  backoff: "exponential",
  timeoutMs: 15 * MINUTE,
  start: (): Promise<unknown> =>
    import("../notificationOutboxWorker.ts").then((m) => m.startNotificationOutboxWorker()),
});

export const playEventQueue = defineQueue<v.InferOutput<typeof playEventDeliverySchema>>({
  name: "play-events",
  group: "play-events",
  leaseMs: 2 * MINUTE,
  maxAttempts: 5,
  retryDelayMs: 30_000,
  backoff: "exponential",
  timeoutMs: 15 * MINUTE,
  skipInTest: true,
  start: (): Promise<unknown> =>
    import("../playEventOutboxWorker.ts").then((m) => m.startPlayEventOutboxWorker()),
});

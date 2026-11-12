import * as v from "valibot";
import { isOwnKey } from "../../../lib/ownKey.ts";
import { defineQueue, parseJobPayload } from "./queue.ts";
import type { WorkerGroup } from "./groups.ts";
import type { SystemTask } from "./systemTasks.ts";
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

const systemQueue = (
  name: string,
  group: WorkerGroup,
  config: { timeoutMs: number; label: string; description: string; skipInTest?: boolean },
) =>
  defineQueue<SystemTask>({
    name,
    group,
    leaseMs: HOUR,
    maxAttempts: 3,
    retryDelayMs: 2 * MINUTE,
    start: (): Promise<unknown> =>
      import("../systemTaskWorker.ts").then((m) => m.startSystemTaskWorker(name)),
    ...config,
  });

export const systemTaskQueue = systemQueue("system-task", "downloads", {
  timeoutMs: 2 * HOUR,
  label: "System maintenance",
  description: "Runs housekeeping, startup checks, and scheduled playlist maintenance.",
});
export const releaseMetadataQueue = systemQueue("release-metadata-refresh", "release-metadata", {
  timeoutMs: 2 * HOUR,
  label: "Release metadata",
  description: "Refreshes release catalogues outside playlist processing.",
  skipInTest: true,
});
export const maintenanceTaskQueue = systemQueue("system-task-maintenance", "maintenance", {
  timeoutMs: 15 * MINUTE,
  label: "Background maintenance",
  description: "Runs cleanup, news and chart refreshes, and playlist schedule checks.",
});
export const inboxTaskQueue = systemQueue("system-task-inbox", "inbox", {
  timeoutMs: 15 * MINUTE,
  label: "Inbox refreshes",
  description: "Refreshes the Inbox.",
});
export const playbackTaskQueue = systemQueue("playback", "downloads", {
  timeoutMs: 2 * HOUR,
  label: "Playlist files",
  description: "Writes playlist files for media servers, one job at a time.",
});

const playlistQueue = (
  name: string,
  start: "startPlaylistOperationWorker" | "startFlowRunWorker",
  label: string,
  description: string,
) =>
  defineQueue<v.InferOutput<typeof playlistOperationSchema>>({
    name,
    label,
    description,
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
  "Playlist operations",
  "Applies playlist edits, flow cleanup, and track actions.",
);
export const flowRunQueue = playlistQueue(
  "flow-run",
  "startFlowRunWorker",
  "Flow runs",
  "Picks new tracks for flows and queues their downloads.",
);

const PIPELINE_PHASE_PRIORITY = { search: 0, poll: 10, download: 20, finalize: 30 };

export const downloadPipelineQueue = defineQueue<v.InferOutput<typeof pipelinePayloadSchema>>({
  name: "download-pipeline",
  label: "Download pipeline",
  description: "Searches, downloads, validates, and finalizes playlist tracks.",
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

export const playlistMbidEnrichmentQueue = defineQueue<
  v.InferOutput<typeof playlistMbidEnrichmentSchema>
>({
  name: "playlist-mbid-enrichment",
  label: "Playlist metadata",
  description: "Fills missing MusicBrainz IDs on imported tracks.",
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
  label: "Library scans",
  description: "Scans files after Library or playlist changes.",
  group: "library",
  leaseMs: 10 * MINUTE,
  maxAttempts: 3,
  retryDelayMs: MINUTE,
  timeoutMs: 6 * HOUR,
  skipInTest: true,
  start: (): Promise<unknown> =>
    import("../libraryScanWorker.ts").then((m) => m.startLibraryScanWorker()),
  onAbandoned: async (job): Promise<void> => {
    const { clearScheduledLibraryScan, restoreLibraryScanAfterWorkerExit } =
      await import("../libraryScanWorker.ts");
    if (job.cancel_requested || job.attempts >= job.max_attempts) clearScheduledLibraryScan(job.id);
    else restoreLibraryScanAfterWorkerExit(job.id);
  },
});

export const libraryFileQueue = defineQueue<v.InferOutput<typeof libraryFileJobSchema>>({
  name: "library-files",
  label: "Library Files",
  description: "Ingests folders and renames and upgrades Library files.",
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
  label: "Discovery refreshes",
  description: "Refreshes discovery recommendations from library and listening data.",
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
  label: "Listening history refreshes",
  description: "Refreshes user listening profiles used by discovery.",
  group: "discovery-user-refresh",
  leaseMs: HOUR,
  maxAttempts: 4,
  retryDelayMs: 5 * MINUTE,
  timeoutMs: 2 * HOUR,
  skipInTest: true,
  start: (): Promise<unknown> =>
    import("../discoveryUserRefreshWorker.ts").then((m) => m.startDiscoveryUserRefreshWorker()),
  onAbandoned: async (job, reason): Promise<void> => {
    const userId = Number(parseJobPayload(job.payload)?.userId);
    if (!Number.isInteger(userId) || userId <= 0) return;
    const { markInterruptedUserDiscoveryRefresh } =
      await import("../discovery/userRefreshRequests.ts");
    markInterruptedUserDiscoveryRefresh(userId, reason);
  },
});

export const notificationQueue = defineQueue<v.InferOutput<typeof queuedNotificationSchema>>({
  name: "notifications",
  label: "Notifications",
  description: "Delivers queued Gotify and webhook notifications and plugin events.",
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

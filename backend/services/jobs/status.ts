import { db } from "../../config/db-sqlite.ts";
import { isOwnKey } from "../../../lib/ownKey.ts";
import { parseJobPayload, type JobRow, type JsonObject } from "./queue.ts";
import { listSchedules } from "./schedules.ts";
import { getWorkerStatuses } from "./worker.ts";

const HISTORY_WINDOW_MS = 60 * 60 * 1000;
const STALE_RUNNING_MS = 60 * 60 * 1000;
const ROW_LIMIT = 500;

const QUEUES = [
  {
    queue: "system-task",
    label: "System maintenance",
    description: "Runs housekeeping, startup checks, and scheduled playlist maintenance.",
  },
  {
    queue: "release-metadata-refresh",
    label: "Release metadata",
    description: "Refreshes release catalogues outside playlist processing.",
  },
  {
    queue: "system-task-maintenance",
    label: "Background maintenance",
    description: "Runs cleanup, news and chart refreshes, and playlist schedule checks.",
  },
  { queue: "system-task-inbox", label: "Inbox refreshes", description: "Refreshes the Inbox." },
  {
    queue: "playback",
    label: "Playlist files",
    description: "Writes playlist files for media servers, one job at a time.",
  },
  {
    queue: "playlist-operation",
    label: "Playlist operations",
    description: "Applies playlist edits, flow cleanup, and track actions.",
  },
  {
    queue: "flow-run",
    label: "Flow runs",
    description: "Picks new tracks for flows and queues their downloads.",
  },
  {
    queue: "download-pipeline",
    label: "Download pipeline",
    description: "Searches, downloads, validates, and finalizes playlist tracks.",
  },
  {
    queue: "playlist-mbid-enrichment",
    label: "Playlist metadata",
    description: "Fills missing MusicBrainz IDs on imported tracks.",
  },
  {
    queue: "library-scan",
    label: "Library scans",
    description: "Scans files after Library or playlist changes.",
  },
  {
    queue: "library-files",
    label: "Library Files",
    description: "Ingests folders and renames and upgrades Library files.",
  },
  {
    queue: "discovery-refresh",
    label: "Discovery refreshes",
    description: "Refreshes discovery recommendations from library and listening data.",
  },
  {
    queue: "discovery-user-refresh",
    label: "Listening history refreshes",
    description: "Refreshes user listening profiles used by discovery.",
  },
  {
    queue: "notifications",
    label: "Notifications",
    description: "Delivers queued Gotify and webhook notifications and plugin events.",
  },
];

const SYSTEM_TASK_QUEUES = new Set([
  "system-task",
  "system-task-maintenance",
  "system-task-inbox",
  "release-metadata-refresh",
  "playback",
]);

const SYSTEM_TASK_LABELS = {
  "playback-playlist-sync": {
    label: "Playlist file sync",
    description:
      "Writes a playlist file for each flow and playlist, then writes changed files again once media servers have scanned new tracks.",
  },
  "history-server-sync": {
    label: "Listening history import",
    description: "Imports new plays from connected Navidrome, Plex, and Jellyfin servers.",
  },
  "playback-server-cleanup": {
    label: "Old media server playlist cleanup",
    description:
      "Removes the playlists Aurral used to create in Navidrome, Plex, and Jellyfin, then forgets those connections.",
  },
  "flow-refresh": {
    label: "Playlist schedule check",
    description: "Queues enabled playlist flows that are due to run.",
  },
  "session-cleanup": { label: "Session cleanup", description: "Removes expired sign-in sessions." },
  "flow-reuse-repair": {
    label: "Playlist file reuse repair",
    description: "Repairs reusable playlist file links when source files move.",
  },
  "review-timeout": {
    label: "Review timeout",
    description: "Denies tracks past the review deadline.",
  },
  "flow-startup-reuse-repair": {
    label: "Startup playlist reuse repair",
    description: "Checks reusable playlist links after Aurral starts.",
  },
  "flow-startup-check": {
    label: "Startup playlist schedule check",
    description: "Resumes playlist work and stops orphaned slskd searches at startup.",
  },
  "playlist-startup-publish": {
    label: "Startup playlist publish",
    description: "Queues a playlist file sync after Aurral starts.",
  },
  "discovery-refresh-check": {
    label: "Discovery auto refresh check",
    description: "Checks whether discovery recommendations need a scheduled refresh.",
  },
  "discovery-bootstrap": {
    label: "Discovery startup check",
    description: "Initializes discovery data and schedules the next refresh.",
  },
  "update-check": {
    label: "Update check",
    description: "Checks aurral.org for a newer Aurral build in this channel.",
  },
  "trending-charts-refresh": {
    label: "Trending charts refresh",
    description: "Updates the Trending charts from Deezer and Apple Music.",
  },
  "inbox-refresh": {
    label: "Inbox refresh",
    description: "Refreshes release, show, news, and discovery updates.",
  },
  "stored-data-migration": {
    label: "Stored settings update",
    description: "Updates older settings, flows, and sign-in data.",
  },
  "identity-marker-migration": {
    label: "Track identity tag update",
    description: "Moves track identifiers from comment or grouping tags to a dedicated tag.",
  },
  "playlist-startup-migration": {
    label: "Playlist startup migration",
    description: "Migrates legacy playlist files and reconciles playlist folders.",
  },
  "lidarr-files-release": {
    label: "Lidarr turned off",
    description: "Downloads Aurral copies of playlist and flow tracks that used Lidarr files.",
  },
  "read-only-folder-release": {
    label: "Read-only folder removed",
    description: "Downloads Aurral copies of playlist and flow tracks that used its files.",
  },
  "lidarr-retry": {
    label: "Lidarr retry",
    description: "Retries Lidarr library access after a temporary connection problem.",
  },
  "release-metadata-refresh": {
    label: "Release metadata refresh",
    description: "Refreshes recent and upcoming releases from BrainzMash.",
  },
};

const DISCOVERY_REASONS = {
  scheduled: {
    label: "Discovery auto refresh",
    description: "Refreshes discovery recommendations on the configured schedule.",
  },
  startup: {
    label: "Discovery startup refresh",
    description: "Refreshes discovery data after startup when the cache is missing or stale.",
  },
  startup_incomplete: {
    label: "Discovery startup refresh",
    description: "Refreshes discovery data after startup when the cache is missing or stale.",
  },
  interval: {
    label: "Discovery refresh check",
    description: "Checks whether discovery data is stale enough to refresh.",
  },
  manual: {
    label: "Manual discovery refresh",
    description: "Refreshes discovery recommendations after a manual request.",
  },
};

const SUMMARY_KEYS = [
  "kind",
  "reason",
  "phase",
  "playlistType",
  "playlistId",
  "flowId",
  "jobId",
  "source",
  "event",
];

type TaskState = "running" | "queued" | "scheduled" | "completed" | "failed" | "cancelled";

export interface TaskQueueRow {
  id: string;
  jobId: number;
  queue: string;
  name: string;
  description: string;
  payloadSummary: string;
  attempt: number;
  maxAttempts: number;
  status: TaskState;
  queuedAt: string | null;
  runAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  error: string | null;
  duplicateCount: number;
  runningForMs: number | null;
  isStale: boolean;
}

export interface TaskScheduledRow {
  id: string;
  name: string;
  scheduleName: string;
  queue: string;
  description: string;
  interval: string;
  schedule: string;
  lastExecutionAt: string | null;
  lastDurationMs: number | null;
  lastStatus: TaskState | null;
  nextExecutionAt: string | null;
}

export interface TaskWorkerRow {
  queue: string;
  queueLabel: string;
  name: string;
  description: string;
  status: "running" | "idle" | "not_loaded";
  running: boolean;
  queued: number;
  scheduled: number;
  processing: number;
  failed: number;
  nextRunAt: string | null;
  lastRunAt: string | null;
}

export interface TaskSummary {
  healthy: boolean;
  activeCount: number;
  staleCount: number;
  failedCount: number;
  workersFailedCount: number;
  completedCount: number;
}

export interface TaskStatusReport {
  timestamp: string;
  summary: TaskSummary;
  scheduled: TaskScheduledRow[];
  workers: TaskWorkerRow[];
  queue: TaskQueueRow[];
}

const queueInfo = new Map(QUEUES.map((entry) => [entry.queue, entry]));

const titleize = (value: unknown) =>
  String(value || "")
    .replace(/[-_:]+/g, " ")
    .trim()
    .replace(/^\w/, (letter) => letter.toUpperCase());

const queueLabel = (queue: string) => queueInfo.get(queue)?.label || titleize(queue) || "Task";

function systemTask(kind: string) {
  return isOwnKey(SYSTEM_TASK_LABELS, kind)
    ? SYSTEM_TASK_LABELS[kind]
    : {
        label: titleize(kind) || "System task",
        description: queueInfo.get("system-task")?.description ?? "",
      };
}

function describe(queue: string, payload: JsonObject | null) {
  const base = { label: queueLabel(queue), description: queueInfo.get(queue)?.description ?? "" };
  if (SYSTEM_TASK_QUEUES.has(queue)) return systemTask(String(payload?.kind ?? ""));
  if (queue === "discovery-refresh") {
    const reason = String(payload?.reason ?? "");
    return isOwnKey(DISCOVERY_REASONS, reason) ? DISCOVERY_REASONS[reason] : base;
  }
  if (queue === "notifications" && payload?.event) {
    return { ...base, label: `Notification: ${titleize(payload.event)}` };
  }
  if (queue === "download-pipeline" && payload?.phase) {
    return {
      label: `${base.label}: ${titleize(payload.phase)}`,
      description: `${base.description} Current phase: ${titleize(payload.phase)}.`,
    };
  }
  if (queue === "playlist-operation" || queue === "flow-run") {
    const label = titleize(payload?.label || payload?.kind);
    return label ? { ...base, label: `${base.label}: ${label}` } : base;
  }
  if (queue === "playlist-mbid-enrichment") {
    return payload?.playlistId
      ? {
          label: `${base.label}: ${titleize(payload.playlistId)}`,
          description: `Finds missing MusicBrainz IDs for ${titleize(payload.playlistId)}.`,
        }
      : {
          ...base,
          description:
            "Scans playlists for tracks missing MusicBrainz IDs and queues enrichment jobs.",
        };
  }
  if (queue === "library-scan" && payload?.force) {
    return {
      label: `${base.label}: Manual`,
      description: "Refreshes Aurral's library view after a requested refresh.",
    };
  }
  return base;
}

function summarizePayload(queue: string, payload: JsonObject | null) {
  if (!payload || SYSTEM_TASK_QUEUES.has(queue)) return "";
  if (queue === "discovery-refresh" && payload.reason) return "";
  const parts = SUMMARY_KEYS.flatMap((key) => {
    const value = payload[key];
    return value == null || value === "" ? [] : [`${titleize(key)}: ${String(value)}`];
  });
  if (Array.isArray(payload.mbids)) parts.push(`MBIDs: ${payload.mbids.length}`);
  return parts.slice(0, 4).join(" · ");
}

const iso = (ms: number | null | undefined) =>
  ms && Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;

function taskState(row: JobRow, now: number): TaskState {
  if (row.state === "pending") return row.run_at > now ? "scheduled" : "queued";
  if (row.state === "done") return "completed";
  return row.state;
}

function toTaskRow(row: JobRow, now: number): TaskQueueRow {
  const payload = parseJobPayload(row.payload);
  const { label, description } = describe(row.queue, payload);
  const status = taskState(row, now);
  const runningForMs = status === "running" && row.started_at ? now - row.started_at : null;
  return {
    id: `job-${row.id}`,
    jobId: row.id,
    queue: row.queue,
    name: label,
    description,
    payloadSummary: summarizePayload(row.queue, payload),
    attempt: row.attempts,
    maxAttempts: row.max_attempts,
    status,
    queuedAt: iso(row.created_at),
    runAt: iso(row.run_at),
    startedAt: iso(row.started_at),
    endedAt: iso(row.finished_at),
    durationMs: row.finished_at && row.started_at ? row.finished_at - row.started_at : null,
    error: row.state === "done" ? null : row.last_error,
    duplicateCount: 1,
    runningForMs,
    isStale: runningForMs != null && runningForMs > STALE_RUNNING_MS,
  };
}

function groupRepeats(rows: TaskQueueRow[]) {
  const grouped: TaskQueueRow[] = [];
  const byTask = new Map<string, TaskQueueRow>();
  for (const row of rows) {
    if (row.status !== "scheduled" && row.status !== "completed") {
      grouped.push(row);
      continue;
    }
    const key = [row.queue, row.status, row.name, row.payloadSummary].join("|");
    const first = byTask.get(key);
    if (!first) {
      byTask.set(key, row);
      grouped.push(row);
      continue;
    }
    first.duplicateCount += 1;
  }
  return grouped;
}

const ACTIVE_ORDER: Partial<Record<TaskState, number>> = { running: 0, queued: 1, scheduled: 2 };

const statements = {
  active: db.prepare<[number], JobRow>(
    `SELECT * FROM jobs WHERE state IN ('pending', 'running')
     ORDER BY CASE state WHEN 'running' THEN 0 ELSE 1 END, run_at, id LIMIT ?`,
  ),
  finished: db.prepare<[number, number], JobRow>(
    `SELECT * FROM jobs WHERE state IN ('done', 'failed', 'cancelled') AND finished_at >= ?
     ORDER BY finished_at DESC, id DESC LIMIT ?`,
  ),
  stats: db.prepare<
    { now: number; since: number },
    {
      queue: string;
      running: number;
      queued: number;
      scheduled: number;
      failed: number;
      next_run_at: number | null;
      last_run_at: number | null;
    }
  >(`
    SELECT queue,
      SUM(state = 'running') AS running,
      SUM(state = 'pending' AND run_at <= @now) AS queued,
      COUNT(DISTINCT CASE WHEN state = 'pending' AND run_at > @now THEN kind || payload END)
        AS scheduled,
      SUM(state = 'failed' AND finished_at >= @since) AS failed,
      MIN(CASE WHEN state = 'pending' AND run_at > @now THEN run_at END) AS next_run_at,
      MAX(CASE WHEN started_at >= @since THEN started_at END) AS last_run_at
    FROM jobs
    WHERE state IN ('pending', 'running') OR finished_at >= @since
    GROUP BY queue
  `),
  lastRun: db.prepare<[string, string], JobRow>(
    `SELECT * FROM jobs WHERE queue = ? AND kind = ? AND state IN ('done', 'failed', 'cancelled')
     ORDER BY finished_at DESC LIMIT 1`,
  ),
  stale: db.prepare<{ cutoff: number; now: number }>(`
    UPDATE jobs SET state = 'cancelled', finished_at = @now, lease_until = NULL,
      last_error = 'Cleared stuck background job'
    WHERE state = 'running' AND started_at < @cutoff
  `),
};

function formatInterval(ms: number) {
  const units: [number, string][] = [
    [24 * 60 * 60 * 1000, "day"],
    [60 * 60 * 1000, "hour"],
    [60 * 1000, "minute"],
    [1000, "second"],
  ];
  const [size, unit] = units.find(([size]) => ms % size === 0) ?? [1, "millisecond"];
  const value = ms / size;
  return `${value} ${unit}${value === 1 ? "" : "s"}`;
}

async function readWorkerStatuses() {
  const statuses = new Map(getWorkerStatuses().map((worker) => [worker.name, worker]));
  try {
    const { getIsolatedWorkerStatuses } = await import("../appRuntime.ts");
    for (const worker of getIsolatedWorkerStatuses()) statuses.set(worker.name, worker);
  } catch {}
  return statuses;
}

export async function getTaskStatus(now = Date.now()): Promise<TaskStatusReport> {
  const since = now - HISTORY_WINDOW_MS;
  const workerStatuses = await readWorkerStatuses();
  const active = statements.active.all(ROW_LIMIT).map((row) => toTaskRow(row, now));
  const finished = statements.finished.all(since, ROW_LIMIT).map((row) => toTaskRow(row, now));
  const queue = groupRepeats(
    [...active, ...finished].sort(
      (a, b) =>
        (ACTIVE_ORDER[a.status] ?? 10) - (ACTIVE_ORDER[b.status] ?? 10) ||
        (Date.parse(b.endedAt ?? "") || 0) - (Date.parse(a.endedAt ?? "") || 0),
    ),
  );

  const stats = new Map(statements.stats.all({ now, since }).map((row) => [row.queue, row]));
  const workers = [...new Set([...QUEUES.map((entry) => entry.queue), ...stats.keys()])].map(
    (name): TaskWorkerRow => {
      const row = stats.get(name);
      const running = workerStatuses.get(name)?.running === true;
      const processing = row?.running ?? 0;
      return {
        queue: name,
        queueLabel: queueLabel(name),
        name: queueLabel(name),
        description: queueInfo.get(name)?.description ?? "",
        status: processing > 0 ? "running" : running ? "idle" : "not_loaded",
        running,
        queued: row?.queued ?? 0,
        scheduled: row?.scheduled ?? 0,
        processing,
        failed: row?.failed ?? 0,
        nextRunAt: iso(row?.next_run_at),
        lastRunAt: iso(row?.last_run_at),
      };
    },
  );

  const scheduled = listSchedules().map((schedule): TaskScheduledRow => {
    const { label, description } = describe(schedule.queue, parseJobPayload(schedule.payload));
    const last = statements.lastRun.get(schedule.queue, schedule.kind);
    const interval = formatInterval(schedule.interval_ms);
    return {
      id: schedule.name,
      name: label,
      scheduleName: schedule.name,
      queue: schedule.queue,
      description,
      interval,
      schedule: interval,
      lastExecutionAt: iso(last?.started_at),
      lastDurationMs:
        last?.finished_at && last.started_at ? last.finished_at - last.started_at : null,
      lastStatus: last ? taskState(last, now) : null,
      nextExecutionAt: iso(schedule.next_run_at),
    };
  });

  let staleCount = 0;
  let failedCount = 0;
  let completedCount = 0;
  let activeCount = 0;
  for (const row of queue) {
    if (row.isStale) staleCount += 1;
    if (row.status === "failed") failedCount += 1;
    if (row.status === "completed") completedCount += row.duplicateCount;
    if (ACTIVE_ORDER[row.status] != null) activeCount += 1;
  }
  const workersFailedCount = workers.filter((worker) => worker.failed > 0).length;

  return {
    timestamp: new Date(now).toISOString(),
    summary: {
      healthy: staleCount === 0 && failedCount === 0 && workersFailedCount === 0,
      activeCount,
      staleCount,
      failedCount,
      workersFailedCount,
      completedCount,
    },
    scheduled,
    workers,
    queue,
  };
}

export function clearStaleJobs(now = Date.now()) {
  return { cleared: statements.stale.run({ cutoff: now - STALE_RUNNING_MS, now }).changes };
}

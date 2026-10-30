import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import type {
  HonkerTaskStatus,
  TaskQueueRow,
  TaskScheduledRow,
  TaskWorkerRow,
} from "../../../../../../backend/services/honkerTaskStatus.ts";
import {
  Activity,
  AlertCircle,
  Check,
  Circle,
  Clock,
  XCircle,
  type IconComponent,
} from "../../../../components/icons";
import { DotLoader } from "../../../../components/DotLoader";
import Tooltip from "../../../../components/Tooltip";
import type { ApiError } from "../../../../utils/api/core.ts";
import { settingsClient } from "../../../../utils/api/clients/settings.ts";
import { formatRelativeTime } from "../../../../utils/dateTime.ts";
import { queryClient, queryKeys } from "../../../../queryClient.ts";
import { readApiError } from "../../utils/apiError.ts";
import { useServerSettings } from "../../SettingsProviders";
import {
  SettingsGroup,
  SettingsNote,
  SettingsPage,
  SettingsRow,
  type ServiceStatus,
} from "../../SettingsLayout";
import { StatusLine } from "./StatusLine";

const POLL_INTERVAL_MS = 5000;

type StatusMeta = { label: string; tone: string; icon: IconComponent; hint?: string };

const STATUS_META: Partial<Record<string, StatusMeta>> = {
  interrupted: {
    label: "Interrupted",
    tone: "subtle",
    icon: Clock,
    hint: "Unfinished work was returned to the queue",
  },
  completed: { label: "Completed", tone: "muted", icon: Check },
  failed: { label: "Failed", tone: "danger", icon: XCircle },
  running: { label: "Running", tone: "default", icon: Activity },
  queued: { label: "Queued", tone: "subtle", icon: Clock },
  scheduled: { label: "Scheduled", tone: "subtle", icon: Clock },
  idle: { label: "Idle", tone: "subtle", icon: Check, hint: "Waiting for work." },
  not_loaded: { label: "Standby", tone: "subtle", icon: Circle, hint: "Starts when work arrives." },
};

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

function parseDate(value: string | null | undefined) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function formatRelative(value: string | null | undefined, empty: string | null = "Never") {
  const date = parseDate(value);
  return date ? formatRelativeTime(date) : empty;
}

function formatDuration(ms: number | null | undefined) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return "<1s";
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours) return `${hours}h ${minutes}m`;
  return minutes ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

const count = (value: number | null | undefined) => (Number.isFinite(value) ? Number(value) : 0);

const joinParts = (parts: (string | null | false)[]) => parts.filter(Boolean).join(" · ");

const isIdleWorker = (worker: TaskWorkerRow) =>
  worker.status === "not_loaded" &&
  !count(worker.processing) &&
  !count(worker.queued) &&
  !count(worker.scheduled) &&
  !count(worker.failed) &&
  !worker.lastRunAt;

function TaskStatus({ status }: { status: string }) {
  const meta = STATUS_META[status];
  const Icon = meta?.icon ?? AlertCircle;
  const badge = (
    <span className={`status-badge status-tone--${meta?.tone ?? "subtle"}`}>
      <Icon aria-hidden="true" />
      {meta?.label ?? (status || "Unknown")}
    </span>
  );
  return meta?.hint ? <Tooltip content={meta.hint}>{badge}</Tooltip> : badge;
}

function scheduledMeta(task: TaskScheduledRow) {
  const interval = task.interval || task.schedule;
  const next = formatRelative(task.nextExecutionAt, null);
  return joinParts([
    /^\d/.test(interval) ? `Every ${interval}` : interval,
    next ? `next ${next}` : "Not scheduled",
  ]);
}

function ScheduledRow({ task }: { task: TaskScheduledRow }) {
  const duration = formatDuration(task.lastDurationMs);
  return (
    <StatusLine
      name={task.name}
      sub={task.description}
      meta={scheduledMeta(task)}
      metaSub={
        task.lastStatus ? (
          <>
            {joinParts([
              `Ran ${formatRelative(task.lastExecutionAt)}`,
              duration && `took ${duration}`,
            ])}
            {" · "}
            <TaskStatus status={task.lastStatus} />
          </>
        ) : (
          <span className="status-tone--subtle">No runs yet</span>
        )
      }
    />
  );
}

function WorkerRow({ worker }: { worker: TaskWorkerRow }) {
  const work = joinParts([
    count(worker.processing) > 0 && `${count(worker.processing)} active`,
    count(worker.queued) > 0 && `${count(worker.queued)} queued`,
    count(worker.scheduled) > 0 && `${count(worker.scheduled)} scheduled`,
  ]);
  const failed = count(worker.failed);
  return (
    <StatusLine
      name={worker.name || worker.queueLabel}
      sub={worker.description}
      meta={
        <>
          {work || (failed ? null : <span className="status-tone--subtle">No work</span>)}
          {work && failed ? " · " : null}
          {failed ? <span className="status-tone--danger">{failed} failed</span> : null}
        </>
      }
      metaSub={
        <>
          <TaskStatus status={worker.status} />
          {worker.lastRunAt ? ` · Last run ${formatRelative(worker.lastRunAt)}` : null}
        </>
      }
    />
  );
}

function queueTiming(task: TaskQueueRow) {
  const runAt = task.status === "scheduled" ? parseDate(task.runAt) : null;
  if (runAt && runAt.getTime() > Date.now()) return `Runs ${formatRelativeTime(runAt)}`;
  if (task.status === "running") {
    const runningFor = formatDuration(task.runningForMs);
    return joinParts([
      task.startedAt && `Started ${formatRelative(task.startedAt)}`,
      runningFor && `running for ${runningFor}`,
    ]);
  }
  if (task.endedAt) {
    const duration = formatDuration(task.durationMs);
    return joinParts([`Ended ${formatRelative(task.endedAt)}`, duration && `took ${duration}`]);
  }
  return task.queuedAt ? `Queued ${formatRelative(task.queuedAt)}` : null;
}

function QueueRow({ task }: { task: TaskQueueRow }) {
  const attempt = count(task.attempt);
  const duplicates = count(task.duplicateCount);
  return (
    <StatusLine
      name={task.name}
      sub={
        <>
          {task.description || task.payloadSummary}
          {task.error ? <span className="status-tone--danger">{task.error}</span> : null}
          {task.isStale ? (
            <span className="status-tone--warning">Running longer than expected</span>
          ) : null}
          {duplicates > 1 ? (
            <span>
              {duplicates} {task.status === "scheduled" ? "delayed copies" : "recent runs"} grouped
            </span>
          ) : null}
        </>
      }
      meta={
        <>
          <TaskStatus status={task.status} />
          {attempt > 1
            ? ` · Attempt ${attempt}${task.maxAttempts ? ` of ${count(task.maxAttempts)}` : ""}`
            : null}
        </>
      }
      metaSub={queueTiming(task)}
    />
  );
}

function TasksSummary({ summary }: { summary: HonkerTaskStatus["summary"] }) {
  const { staleCount, failedCount, workersFailedCount, activeCount } = summary;
  return (
    <SettingsNote tone="warning">
      {[
        staleCount > 0 ? `${plural(staleCount, "job")} running longer than expected.` : null,
        failedCount > 0 ? `${plural(failedCount, "failed job")} in the last hour.` : null,
        workersFailedCount > 0
          ? `${plural(workersFailedCount, "worker")} reported failures.`
          : null,
        activeCount > 0 ? `${plural(activeCount, "active job")} in progress.` : null,
      ]
        .filter(Boolean)
        .join(" ")}
    </SettingsNote>
  );
}

export function useTasksStatus() {
  return useQuery<HonkerTaskStatus, ApiError>({
    queryKey: queryKeys.settingsTasks,
    queryFn: ({ signal }) => parseResponse(settingsClient.tasks.$get({}, { init: { signal } })),
    staleTime: 0,
    refetchInterval: POLL_INTERVAL_MS,
    refetchIntervalInBackground: false,
  });
}

export function tasksServiceStatus(tasks: HonkerTaskStatus | undefined): ServiceStatus | null {
  if (!tasks) return null;
  const { healthy, staleCount, failedCount, workersFailedCount, completedCount } = tasks.summary;
  if (healthy) {
    return {
      label:
        completedCount > 0
          ? `Healthy, ${plural(completedCount, "job")} in the last hour`
          : "Healthy",
    };
  }
  if (staleCount > 0) return { label: plural(staleCount, "stuck job"), tone: "error" };
  if (failedCount > 0) return { label: plural(failedCount, "failed job"), tone: "error" };
  return { label: `${plural(workersFailedCount, "worker")} failing`, tone: "error" };
}

export function TasksPage() {
  const { showSuccess, showError } = useServerSettings();
  const [showAllWorkers, setShowAllWorkers] = useState(false);
  const tasksQuery = useTasksStatus();
  const clearStale = useMutation({
    mutationFn: () => parseResponse(settingsClient.tasks["clear-stale"].$post()),
    onSuccess: (result) => {
      queryClient.setQueryData(queryKeys.settingsTasks, result.tasks || null);
      const cleared = Number(result.cleared || 0);
      showSuccess(cleared > 0 ? `Cleared ${plural(cleared, "stuck job")}.` : "No stuck jobs.");
    },
    onError: (error) => {
      const failure = readApiError(error);
      showError(failure.message || failure.error || failure.text || "Failed to clear stuck jobs");
    },
  });
  const tasks = tasksQuery.data;
  const failure = tasksQuery.error ? readApiError(tasksQuery.error) : null;
  const loadError = failure ? failure.message || failure.error || failure.text : null;
  const workers = tasks?.workers ?? [];
  const idleWorkers = workers.filter(isIdleWorker).length;
  const visibleWorkers = showAllWorkers
    ? workers
    : workers.filter((worker) => !isIdleWorker(worker));
  const scheduled = tasks?.scheduled ?? [];
  const queue = tasks?.queue ?? [];

  return (
    <SettingsPage title="Tasks" back="Status">
      {loadError ? (
        <SettingsGroup>
          <SettingsNote tone="error">{loadError}</SettingsNote>
        </SettingsGroup>
      ) : null}
      {tasks ? (
        <>
          {tasks.summary.healthy ? null : (
            <SettingsGroup>
              <TasksSummary summary={tasks.summary} />
              {tasks.summary.staleCount > 0 ? (
                <SettingsRow
                  label={plural(tasks.summary.staleCount, "stuck job")}
                  help="Clearing resets the queue. Startup tasks queue again if needed."
                >
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => clearStale.mutate()}
                    disabled={clearStale.isPending}
                  >
                    {clearStale.isPending ? <DotLoader size="xs" label={null} /> : null}
                    Clear
                  </button>
                </SettingsRow>
              ) : null}
            </SettingsGroup>
          )}
          <SettingsGroup title="Scheduled">
            {scheduled.length ? (
              scheduled.map((task) => (
                <ScheduledRow key={task.id || task.scheduleName || task.name} task={task} />
              ))
            ) : (
              <p className="settings-group__note">No scheduled tasks.</p>
            )}
          </SettingsGroup>
          <SettingsGroup
            title="Workers"
            actions={
              idleWorkers > 0 ? (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setShowAllWorkers((value) => !value)}
                >
                  {showAllWorkers ? "Hide idle" : `Show all (${workers.length})`}
                </button>
              ) : null
            }
          >
            {visibleWorkers.length ? (
              visibleWorkers.map((worker) => <WorkerRow key={worker.queue} worker={worker} />)
            ) : (
              <p className="settings-group__note">No active workers.</p>
            )}
          </SettingsGroup>
          <SettingsGroup title="Queue">
            {queue.length ? (
              queue.map((task) => <QueueRow key={task.id} task={task} />)
            ) : (
              <p className="settings-group__note">Queue is empty.</p>
            )}
          </SettingsGroup>
        </>
      ) : tasksQuery.isPending ? (
        <p className="settings-loading">
          <DotLoader size="sm" label={null} /> Loading tasks…
        </p>
      ) : null}
    </SettingsPage>
  );
}

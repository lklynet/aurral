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
import { SettingsGroup, SettingsNote, SettingsRow } from "../../SettingsLayout";

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
  return [
    Math.floor(totalSeconds / 3600),
    Math.floor((totalSeconds % 3600) / 60),
    totalSeconds % 60,
  ]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

const count = (value: number | null | undefined) => (Number.isFinite(value) ? Number(value) : 0);

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

function EmptyRow({ colSpan, children }: { colSpan: number; children: string }) {
  return (
    <tr>
      <td colSpan={colSpan} className="settings-table__empty">
        {children}
      </td>
    </tr>
  );
}

function NameCell({ name, description }: { name: string | null; description?: string | null }) {
  return (
    <>
      <span className="status-cell__name">{name}</span>
      {description ? <span className="status-cell__sub">{description}</span> : null}
    </>
  );
}

function ScheduledTable({ rows }: { rows: TaskScheduledRow[] }) {
  return (
    <div className="settings-table-wrap">
      <table className="settings-table status-table">
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Interval</th>
            <th scope="col">Last run</th>
            <th scope="col">Duration</th>
            <th scope="col">Next run</th>
            <th scope="col">Result</th>
          </tr>
        </thead>
        <tbody>
          {rows.length ? (
            rows.map((task) => (
              <tr key={task.id || task.scheduleName || task.name}>
                <td>
                  <NameCell name={task.name} description={task.description} />
                </td>
                <td>{task.interval || task.schedule}</td>
                <td>{formatRelative(task.lastExecutionAt)}</td>
                <td>{formatDuration(task.lastDurationMs)}</td>
                <td>{formatRelative(task.nextExecutionAt, "Not scheduled")}</td>
                <td>
                  {task.lastStatus ? (
                    <TaskStatus status={task.lastStatus} />
                  ) : (
                    <span className="status-tone--subtle">No runs yet</span>
                  )}
                </td>
              </tr>
            ))
          ) : (
            <EmptyRow colSpan={6}>No scheduled tasks.</EmptyRow>
          )}
        </tbody>
      </table>
    </div>
  );
}

function WorkersTable({ rows }: { rows: TaskWorkerRow[] }) {
  return (
    <div className="settings-table-wrap">
      <table className="settings-table status-table">
        <thead>
          <tr>
            <th scope="col">Worker</th>
            <th scope="col">Status</th>
            <th scope="col">Active</th>
            <th scope="col">Queued</th>
            <th scope="col">Scheduled</th>
            <th scope="col">Failed</th>
            <th scope="col">Last run</th>
          </tr>
        </thead>
        <tbody>
          {rows.length ? (
            rows.map((worker) => (
              <tr key={worker.queue}>
                <td>
                  <NameCell
                    name={worker.name || worker.queueLabel}
                    description={worker.description}
                  />
                </td>
                <td>
                  <TaskStatus status={worker.status} />
                </td>
                <td>{count(worker.processing)}</td>
                <td>{count(worker.queued)}</td>
                <td>{count(worker.scheduled)}</td>
                <td className={count(worker.failed) ? "status-tone--danger" : undefined}>
                  {count(worker.failed)}
                </td>
                <td>{formatRelative(worker.lastRunAt)}</td>
              </tr>
            ))
          ) : (
            <EmptyRow colSpan={7}>No active workers.</EmptyRow>
          )}
        </tbody>
      </table>
    </div>
  );
}

function QueueStarted({ task }: { task: TaskQueueRow }) {
  const runAt = task.status === "scheduled" ? parseDate(task.runAt) : null;
  if (runAt && runAt.getTime() > Date.now()) {
    return <span className="status-tone--subtle">Runs {formatRelativeTime(runAt)}</span>;
  }
  return formatRelative(task.startedAt, null);
}

function QueueTable({ rows }: { rows: TaskQueueRow[] }) {
  return (
    <div className="settings-table-wrap">
      <table className="settings-table status-table">
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Status</th>
            <th scope="col">Created</th>
            <th scope="col">Started</th>
            <th scope="col">Ended</th>
            <th scope="col">
              {rows.some((task) => task.status === "running") ? "Running for" : "Duration"}
            </th>
            <Tooltip content="Retry count for jobs that can fail and re-run">
              <th scope="col">Attempt</th>
            </Tooltip>
          </tr>
        </thead>
        <tbody>
          {rows.length ? (
            rows.map((task) => (
              <tr key={task.id}>
                <td>
                  <NameCell
                    name={task.name}
                    description={task.description || task.payloadSummary}
                  />
                  {task.error ? (
                    <span className="status-cell__sub status-tone--danger">{task.error}</span>
                  ) : null}
                  {task.isStale ? (
                    <span className="status-cell__sub status-tone--warning">
                      Running longer than expected
                    </span>
                  ) : null}
                  {count(task.duplicateCount) > 1 ? (
                    <span className="status-cell__sub">
                      {task.duplicateCount}{" "}
                      {task.status === "scheduled" ? "delayed copies" : "recent runs"} grouped
                    </span>
                  ) : null}
                </td>
                <td>
                  <TaskStatus status={task.status} />
                </td>
                <td>{formatRelative(task.queuedAt, null)}</td>
                <td>
                  <QueueStarted task={task} />
                </td>
                <td>{formatRelative(task.endedAt, null)}</td>
                <td>
                  {formatDuration(task.status === "running" ? task.runningForMs : task.durationMs)}
                </td>
                <td>
                  {task.maxAttempts
                    ? `${count(task.attempt)} / ${count(task.maxAttempts)}`
                    : count(task.attempt)}
                </td>
              </tr>
            ))
          ) : (
            <EmptyRow colSpan={7}>Queue is empty.</EmptyRow>
          )}
        </tbody>
      </table>
    </div>
  );
}

function TasksSummary({ summary }: { summary: HonkerTaskStatus["summary"] }) {
  const { healthy, activeCount, staleCount, failedCount, workersFailedCount, completedCount } =
    summary;
  if (healthy) {
    return (
      <p className="settings-group__note">
        Healthy.
        {completedCount > 0 ? ` ${plural(completedCount, "job")} completed in the last hour.` : ""}
      </p>
    );
  }
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

export function TasksGroup() {
  const { showSuccess, showError } = useServerSettings();
  const [showAllWorkers, setShowAllWorkers] = useState(false);
  const tasksQuery = useQuery<HonkerTaskStatus, ApiError>({
    queryKey: queryKeys.settingsTasks,
    queryFn: ({ signal }) => parseResponse(settingsClient.tasks.$get({}, { init: { signal } })),
    staleTime: 0,
    refetchInterval: POLL_INTERVAL_MS,
    refetchIntervalInBackground: false,
  });
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

  return (
    <SettingsGroup title="Tasks">
      {loadError ? <SettingsNote tone="error">{loadError}</SettingsNote> : null}
      {tasks ? (
        <>
          <TasksSummary summary={tasks.summary} />
          {!tasks.summary.healthy && tasks.summary.staleCount > 0 ? (
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
          <h4 className="status-subhead">Scheduled</h4>
          <ScheduledTable rows={tasks.scheduled ?? []} />
          <div className="status-subhead">
            <h4>Workers</h4>
            {idleWorkers > 0 ? (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setShowAllWorkers((value) => !value)}
              >
                {showAllWorkers ? "Hide idle" : `Show all (${workers.length})`}
              </button>
            ) : null}
          </div>
          <WorkersTable rows={visibleWorkers} />
          <h4 className="status-subhead">Queue</h4>
          <QueueTable rows={tasks.queue ?? []} />
        </>
      ) : tasksQuery.isPending ? (
        <p className="settings-loading">
          <DotLoader size="sm" label={null} /> Loading tasks…
        </p>
      ) : null}
    </SettingsGroup>
  );
}

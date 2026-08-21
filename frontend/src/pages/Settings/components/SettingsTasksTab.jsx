import { useCallback, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { getSettingsTasks, clearSettingsStaleTasks } from "../../../utils/api/endpoints/settings.js";
import { queryClient, queryKeys } from "../../../queryClient.js";
import { SettingsArrFieldSet } from "./arr/SettingsArrLayout";

import { AlertCircle, Check, Clock, Loader2, XCircle } from "lucide-react";
const POLL_INTERVAL_MS = 5000;

const relativeFormatter = new Intl.RelativeTimeFormat(undefined, {
  numeric: "auto",
});

const STATUS_META = {
  completed: {
    label: "Completed",
    tone: "ok",
    icon: Check,
    title: null,
  },
  failed: {
    label: "Failed",
    tone: "danger",
    icon: XCircle,
    title: null,
  },
  running: {
    label: "Running",
    tone: "active",
    icon: Loader2,
    title: null,
  },
  queued: {
    label: "Queued",
    tone: "queued",
    icon: Clock,
    title: null,
  },
  scheduled: {
    label: "Scheduled",
    tone: "queued",
    icon: Clock,
    title: null,
  },
  idle: {
    label: "Idle",
    tone: "muted",
    icon: Check,
    title: "Processor is loaded and waiting for work",
  },
  not_loaded: {
    label: "Standby",
    tone: "muted",
    icon: AlertCircle,
    title: "Processor is stopped until new work arrives",
  },
};

function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function formatRelative(value, empty = "Never") {
  const date = parseDate(value);
  if (!date) return empty;
  const diffSeconds = Math.round((date.getTime() - Date.now()) / 1000);
  const units = [
    ["year", 31536000],
    ["month", 2592000],
    ["week", 604800],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
    ["second", 1],
  ];
  const [unit, seconds] =
    units.find(([, unitSeconds]) => Math.abs(diffSeconds) >= unitSeconds) ||
    units[units.length - 1];
  return relativeFormatter.format(Math.round(diffSeconds / seconds), unit);
}

function formatDuration(ms) {
  if (ms == null || ms === "") return "—";
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return "—";
  if (value < 1000) return "<1s";
  const totalSeconds = Math.floor(value / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":");
}

function formatCount(value) {
  const count = Number(value || 0);
  return Number.isFinite(count) ? count : 0;
}

function isFutureRunAt(task) {
  if (task.status !== "scheduled") return false;
  const runAt = parseDate(task.runAt);
  return runAt ? runAt.getTime() > Date.now() : false;
}

function formatQueueDuration(task) {
  if (task.status === "running") {
    return formatDuration(task.runningForMs);
  }
  return formatDuration(task.durationMs);
}

function StatusBadge({ status }) {
  const meta = STATUS_META[status] || {
    label: status || "Unknown",
    tone: "muted",
    icon: AlertCircle,
    title: null,
  };
  const Icon = meta.icon;
  return (
    <span
      className={`arr-task-status arr-task-status--${meta.tone}`}
      title={meta.title || undefined}
    >
      <Icon
        className={`arr-task-status__icon${status === "running" ? " animate-spin" : ""}`}
        aria-hidden
      />
      {meta.label}
    </span>
  );
}

function EmptyRows({ colSpan }) {
  return (
    <tr className="arr-table__empty-row">
      <td colSpan={colSpan}>No task data available.</td>
    </tr>
  );
}

function LoadingRows({ colSpan }) {
  return (
    <tr className="arr-table__empty-row">
      <td colSpan={colSpan}>Loading task data...</td>
    </tr>
  );
}

function TasksHealthSummary({ summary, loading, clearing = false, onClearStale }) {
  if (loading || !summary) {
    return <div className="arr-info arr-info--tasks">Loading background task status...</div>;
  }

  const { healthy, activeCount, staleCount, failedCount, workersFailedCount, completedCount } =
    summary;
  const needsAttention = !healthy;

  return (
    <div className={`arr-info arr-info--tasks${healthy ? "" : " arr-info--tasks-warning"}`}>
      {healthy ? (
        <p className="arr-info__lead">
          Background tasks are healthy.
          {completedCount > 0
            ? ` ${completedCount} job${completedCount === 1 ? "" : "s"} completed in the last hour.`
            : ""}
        </p>
      ) : (
        <>
          <p className="arr-info__lead">
            {staleCount > 0
              ? `${staleCount} job${staleCount === 1 ? "" : "s"} running longer than expected. `
              : ""}
            {failedCount > 0
              ? `${failedCount} failed job${failedCount === 1 ? "" : "s"} in the last hour. `
              : ""}
            {workersFailedCount > 0
              ? `${workersFailedCount} worker${workersFailedCount === 1 ? "" : "s"} reported failures. `
              : ""}
            {activeCount > 0
              ? `${activeCount} active job${activeCount === 1 ? "" : "s"} in progress.`
              : ""}
          </p>
          {staleCount > 0 ? (
            <p className="arr-info__help">
              These are usually leftover job records from an earlier run, not active workers. Clear
              them to reset the queue. Aurral will re-enqueue normal startup work if needed.
            </p>
          ) : null}
        </>
      )}
      {needsAttention && staleCount > 0 && onClearStale ? (
        <div className="arr-info__actions">
          <button
            type="button"
            className="arr-btn arr-btn--primary"
            onClick={onClearStale}
            disabled={clearing}
          >
            {clearing ? "Clearing stuck jobs…" : "Clear stuck jobs"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function ScheduledTable({ scheduled = [], loading = false }) {
  return (
    <div className="arr-table-wrap">
      <table className="arr-table arr-table--tasks" aria-busy={loading}>
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
          {loading ? (
            <LoadingRows colSpan={6} />
          ) : scheduled.length === 0 ? (
            <EmptyRows colSpan={6} />
          ) : (
            scheduled.map((task) => (
              <tr key={task.id || task.scheduleName || task.name}>
                <td>
                  <span className="arr-table__primary">{task.name}</span>
                  {task.description ? (
                    <span className="arr-table__subtle">{task.description}</span>
                  ) : null}
                </td>
                <td>{task.interval || task.schedule || "—"}</td>
                <td>{formatRelative(task.lastExecutionAt)}</td>
                <td>{formatDuration(task.lastDurationMs)}</td>
                <td>{formatRelative(task.nextExecutionAt, "Not scheduled")}</td>
                <td>
                  {task.lastStatus ? (
                    <StatusBadge status={task.lastStatus} />
                  ) : (
                    <span className="arr-table__subtle">No runs yet</span>
                  )}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function isIdleWorker(worker) {
  return (
    worker.status === "not_loaded" &&
    formatCount(worker.processing) === 0 &&
    formatCount(worker.queued) === 0 &&
    formatCount(worker.scheduled) === 0 &&
    formatCount(worker.failed) === 0 &&
    !worker.lastRunAt
  );
}

function WorkersTable({ workers = [], loading = false, showAllWorkers = false }) {
  const visibleWorkers = useMemo(() => {
    if (showAllWorkers) return workers;
    return workers.filter((worker) => !isIdleWorker(worker));
  }, [showAllWorkers, workers]);

  return (
    <div className="arr-table-wrap">
      <table className="arr-table arr-table--tasks" aria-busy={loading}>
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
          {loading ? (
            <LoadingRows colSpan={7} />
          ) : visibleWorkers.length === 0 ? (
            <EmptyRows colSpan={7} />
          ) : (
            visibleWorkers.map((worker) => (
              <tr key={worker.queue}>
                <td>
                  <span className="arr-table__primary">{worker.name || worker.queueLabel}</span>
                  {worker.description ? (
                    <span className="arr-table__subtle">{worker.description}</span>
                  ) : null}
                </td>
                <td>
                  <StatusBadge status={worker.status} />
                </td>
                <td>{formatCount(worker.processing)}</td>
                <td>{formatCount(worker.queued)}</td>
                <td>{formatCount(worker.scheduled)}</td>
                <td>
                  <span
                    className={
                      formatCount(worker.failed) > 0
                        ? "arr-task-count arr-task-count--danger"
                        : "arr-task-count"
                    }
                  >
                    {formatCount(worker.failed)}
                  </span>
                </td>
                <td>{formatRelative(worker.lastRunAt)}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function QueueTable({ queue = [], loading = false }) {
  return (
    <div className="arr-table-wrap">
      <table className="arr-table arr-table--tasks arr-table--task-queue" aria-busy={loading}>
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Status</th>
            <th scope="col">Created</th>
            <th scope="col">Started</th>
            <th scope="col">Ended</th>
            <th scope="col">
              {queue.some((task) => task.status === "running") ? "Running for" : "Duration"}
            </th>
            <th scope="col" title="Retry count for jobs that can fail and re-run">
              Attempt
            </th>
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <LoadingRows colSpan={7} />
          ) : queue.length === 0 ? (
            <EmptyRows colSpan={7} />
          ) : (
            queue.map((task) => (
              <tr key={task.id} className={task.isStale ? "arr-table__row--warning" : undefined}>
                <td>
                  <span className="arr-table__primary">{task.name}</span>
                  {task.description || task.payloadSummary ? (
                    <span className="arr-table__subtle">
                      {task.description || task.payloadSummary}
                    </span>
                  ) : null}
                  {task.error ? (
                    <span className="arr-table__subtle arr-table__subtle--danger">
                      {task.error}
                    </span>
                  ) : null}
                  {task.isStale ? (
                    <span className="arr-table__subtle arr-table__subtle--warning">
                      Running longer than expected
                    </span>
                  ) : null}
                  {Number(task.duplicateCount || 1) > 1 ? (
                    <span className="arr-table__subtle">
                      {task.duplicateCount}{" "}
                      {task.status === "scheduled" ? "delayed copies" : "recent runs"} grouped
                    </span>
                  ) : null}
                </td>
                <td>
                  <StatusBadge status={task.status} />
                </td>
                <td>{formatRelative(task.queuedAt, "—")}</td>
                <td>
                  {isFutureRunAt(task) ? (
                    <span title="Runs at">
                      <span className="arr-table__subtle">Runs at </span>
                      {formatRelative(task.runAt, "—")}
                    </span>
                  ) : task.startedAt ? (
                    formatRelative(task.startedAt)
                  ) : (
                    "—"
                  )}
                </td>
                <td>{formatRelative(task.endedAt, "—")}</td>
                <td>{formatQueueDuration(task)}</td>
                <td>
                  {task.maxAttempts
                    ? `${formatCount(task.attempt)} / ${formatCount(task.maxAttempts)}`
                    : formatCount(task.attempt)}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

export function SettingsTasksTab({ showError, showSuccess }) {
  const [clearing, setClearing] = useState(false);
  const [showAllWorkers, setShowAllWorkers] = useState(false);
  const tasksQuery = useQuery({
    queryKey: queryKeys.settingsTasks,
    queryFn: ({ signal }) => getSettingsTasks({ signal }),
    staleTime: 0,
    refetchInterval: POLL_INTERVAL_MS,
    refetchIntervalInBackground: false,
  });
  const tasks = tasksQuery.data;
  const loading = tasksQuery.isPending;
  const loadError =
    tasksQuery.error?.response?.data?.message ||
    tasksQuery.error?.response?.data?.error ||
    tasksQuery.error?.message ||
    null;
  const clearMutation = useMutation({
    mutationFn: clearSettingsStaleTasks,
    onSuccess: (result) => queryClient.setQueryData(queryKeys.settingsTasks, result.tasks || null),
  });

  const clearStaleJobs = useCallback(async () => {
    setClearing(true);
    try {
      const result = await clearMutation.mutateAsync();
      const cleared = Number(result.cleared || 0);
      if (cleared > 0) {
        showSuccess?.(`Cleared ${cleared} stuck job${cleared === 1 ? "" : "s"}.`);
      } else {
        showSuccess?.("No stuck jobs needed clearing.");
      }
    } catch (error) {
      const message =
        error.response?.data?.message ||
        error.response?.data?.error ||
        error.message ||
        "Failed to clear stuck jobs";
      showError(message);
    } finally {
      setClearing(false);
    }
  }, [clearMutation, showError, showSuccess]);

  const idleWorkerCount = useMemo(() => {
    const workerRows = tasks?.workers || [];
    return workerRows.filter((worker) => isIdleWorker(worker)).length;
  }, [tasks?.workers]);
  const workers = tasks?.workers || [];

  return (
    <div className="arr-page">
      {loadError ? (
        <p className="arr-form-help arr-form-help--error" role="alert">
          {loadError}
        </p>
      ) : null}

      <TasksHealthSummary
        summary={tasks?.summary}
        loading={loading}
        clearing={clearing}
        onClearStale={clearStaleJobs}
      />

      <SettingsArrFieldSet legend="Scheduled">
        <ScheduledTable scheduled={tasks?.scheduled || []} loading={loading} />
      </SettingsArrFieldSet>

      <SettingsArrFieldSet
        legend="Workers"
        actions={
          idleWorkerCount > 0 ? (
            <button
              type="button"
              className="arr-btn arr-btn--ghost"
              onClick={() => setShowAllWorkers((value) => !value)}
            >
              {showAllWorkers ? "Hide idle workers" : `Show all workers (${workers.length})`}
            </button>
          ) : null
        }
      >
        <WorkersTable workers={workers} loading={loading} showAllWorkers={showAllWorkers} />
      </SettingsArrFieldSet>

      <SettingsArrFieldSet legend="Queue">
        <QueueTable queue={tasks?.queue || []} loading={loading} />
      </SettingsArrFieldSet>
    </div>
  );
}

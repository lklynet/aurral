import { useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Circle,
  RefreshCw,
  XCircle,
} from "../../../../components/icons";
import { DotLoader } from "../../../../components/DotLoader";
import { refreshStorageHealth, useStorageHealth } from "../../../../hooks/useStorageHealth";
import { formatDateTime } from "../../../../utils/dateTime.ts";
import type { HealthResponse } from "../../../../utils/appHealth.ts";
import { readApiError } from "../../utils/apiError.ts";
import { formatBytes } from "../../utils/formatBytes";
import { runStorageHealthAction } from "../../utils/runStorageHealthAction";
import { useServerSettings } from "../../SettingsProviders";
import {
  SettingsGroup,
  SettingsNote,
  SettingsPage,
  type ServiceStatus,
} from "../../SettingsLayout";
import { StatusLine } from "./StatusLine";

type StorageResult = NonNullable<ReturnType<typeof useStorageHealth>["result"]>;
type StorageCheck = StorageResult["sections"][number];
type DiskEntry = NonNullable<HealthResponse["system"]>["diskSpace"][number];

const CHECK_STATUS = {
  fail: { label: "Failed", tone: "danger", icon: XCircle, rank: 0 },
  warn: { label: "Warning", tone: "warning", icon: AlertTriangle, rank: 1 },
  pass: { label: "Passed", tone: "muted", icon: Check, rank: 2 },
  skip: { label: "Skipped", tone: "subtle", icon: Circle, rank: 3 },
} as const;

const isCheckStatus = (status: string): status is keyof typeof CHECK_STATUS =>
  Object.hasOwn(CHECK_STATUS, status);

const checkStatus = (status: string) =>
  isCheckStatus(status) ? CHECK_STATUS[status] : CHECK_STATUS.skip;

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

function formatCheckedAt(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : formatDateTime(date);
}

function CheckIcon({ status }: { status: string }) {
  const meta = checkStatus(status);
  const Icon = meta.icon;
  return (
    <span className={`status-icon status-tone--${meta.tone}`}>
      <Icon aria-hidden="true" />
      <span className="sr-only">{meta.label}</span>
    </span>
  );
}

function summarizeChecks(result: StorageResult) {
  const active = result.sections.filter((section) => section.status !== "skip");
  return {
    total: active.length,
    failed: active.filter((section) => section.status === "fail").length,
    warnings: active.filter((section) => section.status === "warn").length,
  };
}

export function storageServiceStatus(result: StorageResult | null): ServiceStatus {
  if (!result?.sections.length) return { label: "Not checked", tone: "muted" };
  const { total, failed, warnings } = summarizeChecks(result);
  if (failed) return { label: `${failed} of ${plural(total, "check")} failed`, tone: "error" };
  if (warnings) return { label: plural(warnings, "warning") };
  return { label: "All checks passed" };
}

function StorageSummary({ result, loading }: { result: StorageResult | null; loading: boolean }) {
  if (!result?.sections.length) {
    return loading ? (
      <p className="settings-loading">
        <DotLoader size="sm" label={null} /> Checking storage…
      </p>
    ) : (
      <p className="settings-group__note">
        Run checks to test library, download, and playback paths.
      </p>
    );
  }

  const { total, failed, warnings } = summarizeChecks(result);
  const checkedAt = formatCheckedAt(result.checkedAt);
  const checked = checkedAt ? ` · Checked ${checkedAt}` : "";

  if (failed) {
    return (
      <SettingsNote tone="error">
        {failed} of {plural(total, "check")} failed
        {warnings ? `, ${plural(warnings, "warning")}` : ""}
        {checked}
      </SettingsNote>
    );
  }
  if (warnings) {
    return (
      <SettingsNote tone="warning">
        {plural(warnings, "warning")} in {plural(total, "check")}
        {checked}
      </SettingsNote>
    );
  }
  return (
    <p className="settings-group__note">
      All {plural(total, "check")} passed{checked}
    </p>
  );
}

function StepDetail({ detail }: { detail: string }) {
  const text = detail.trim();
  if (text.length <= 180) return <code className="settings-code">{text}</code>;
  const summary = /ENOENT|no such file/i.test(text)
    ? "Some configured paths could not be found."
    : /EACCES|permission denied/i.test(text)
      ? "A configured path could not be accessed."
      : "Show technical details";
  return (
    <details className="status-step__technical">
      <summary>{summary}</summary>
      <code className="settings-code">{text}</code>
    </details>
  );
}

function CheckRow({ check }: { check: StorageCheck }) {
  const head = (
    <>
      <CheckIcon status={check.status} />
      <span className="status-check__title">{check.title}</span>
      {check.status === "skip" && check.skipReason ? (
        <span className="status-check__meta">{check.skipReason}</span>
      ) : null}
    </>
  );

  if (check.status === "skip" || !check.steps.length) {
    return <div className="status-check__head">{head}</div>;
  }

  return (
    <details className="status-check" open={check.status === "fail" || check.status === "warn"}>
      <summary className="status-check__head">
        {head}
        <ChevronDown className="status-check__chevron" aria-hidden="true" />
      </summary>
      <ul className="status-steps">
        {check.steps.map((step) => (
          <li key={step.id} className="status-step">
            <CheckIcon status={step.status} />
            <div className="status-step__body">
              <span>{step.label}</span>
              {step.detail ? <StepDetail detail={step.detail} /> : null}
              {step.fix ? <p className="status-step__fix">{step.fix}</p> : null}
            </div>
          </li>
        ))}
      </ul>
    </details>
  );
}

function DiskRow({ entry }: { entry: DiskEntry }) {
  const usage = "usedPercent" in entry && entry.available ? entry : null;
  const statTarget = "statTarget" in entry ? entry.statTarget : null;
  return (
    <StatusLine
      name={<code className="settings-code">{entry.location}</code>}
      sub={
        <>
          {entry.role}
          {statTarget && statTarget !== entry.location ? (
            <span>Stats from {statTarget}</span>
          ) : null}
        </>
      }
      meta={
        usage ? `${formatBytes(usage.freeBytes)} free of ${formatBytes(usage.totalBytes)}` : null
      }
      metaSub={
        usage ? (
          <span className="status-meter">
            <span className="status-meter__bar" aria-hidden="true">
              <span className="status-meter__fill" style={{ width: `${usage.usedPercent}%` }} />
            </span>
            {usage.usedPercent}% used
          </span>
        ) : (
          ("error" in entry && entry.error) || "Unavailable"
        )
      }
    />
  );
}

export function StoragePage() {
  const { health, hasUnsavedChanges, handleSaveSettings, showSuccess, showError } =
    useServerSettings();
  const storageHealth = useStorageHealth({ enabled: true, pollMs: 120000 });
  const [checking, setChecking] = useState(false);
  const result = storageHealth.result;
  const checks = result
    ? [...result.sections].sort((a, b) => checkStatus(a.status).rank - checkStatus(b.status).rank)
    : [];

  const runChecks = async () => {
    setChecking(true);
    try {
      const outcome = await runStorageHealthAction({
        hasUnsavedChanges,
        saveSettings: () => handleSaveSettings(),
        refreshStorageHealth: () => refreshStorageHealth({ force: true }),
      });
      if (!outcome.saved) return;
      if (!outcome.result.ok) showError("Storage checks found problems.");
      else if (outcome.result.partial) showSuccess("Storage checks finished with warnings");
      else showSuccess("Storage checks passed");
    } catch (error) {
      const failure = readApiError(error);
      showError(failure.message || failure.error || failure.text || "Storage health check failed");
    } finally {
      setChecking(false);
    }
  };

  const diskSpace = health?.system?.diskSpace ?? [];

  return (
    <SettingsPage title="Storage" back="Status">
      <SettingsGroup
        title="Checks"
        actions={
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={runChecks}
            disabled={checking}
          >
            {checking ? <DotLoader size="xs" label={null} /> : <RefreshCw aria-hidden="true" />}
            {checking ? "Checking…" : "Run checks"}
          </button>
        }
      >
        <StorageSummary result={result} loading={checking || storageHealth.loading} />
        {checks.map((check) => (
          <CheckRow key={`${result?.checkedAt}-${check.id}`} check={check} />
        ))}
      </SettingsGroup>
      <SettingsGroup title="Disk space">
        {diskSpace.length ? (
          diskSpace.map((entry) => (
            <DiskRow key={`${entry.role}-${entry.location}`} entry={entry} />
          ))
        ) : (
          <p className="settings-group__note">Disk space isn&apos;t available.</p>
        )}
      </SettingsGroup>
    </SettingsPage>
  );
}

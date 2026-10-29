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
import { SettingsGroup, SettingsNote } from "../../SettingsLayout";

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

  const active = result.sections.filter((section) => section.status !== "skip");
  const failed = active.filter((section) => section.status === "fail").length;
  const warnings = active.filter((section) => section.status === "warn").length;
  const checkedAt = formatCheckedAt(result.checkedAt);
  const checked = checkedAt ? ` · Checked ${checkedAt}` : "";

  if (failed) {
    return (
      <SettingsNote tone="error">
        {failed} of {plural(active.length, "check")} failed
        {warnings ? `, ${plural(warnings, "warning")}` : ""}
        {checked}
      </SettingsNote>
    );
  }
  if (warnings) {
    return (
      <SettingsNote tone="warning">
        {plural(warnings, "warning")} in {plural(active.length, "check")}
        {checked}
      </SettingsNote>
    );
  }
  return (
    <p className="settings-group__note">
      All {plural(active.length, "check")} passed{checked}
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
    return <li className="status-check__head">{head}</li>;
  }

  return (
    <li>
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
    </li>
  );
}

function DiskSpace({ entries }: { entries: DiskEntry[] }) {
  if (!entries.length) {
    return <p className="settings-group__note">Disk space isn&apos;t available.</p>;
  }
  return (
    <div className="settings-table-wrap">
      <table className="settings-table status-table">
        <thead>
          <tr>
            <th scope="col">Location</th>
            <th scope="col">Role</th>
            <th scope="col">Free</th>
            <th scope="col">Total</th>
            <th scope="col">Used</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => {
            const usage = "usedPercent" in entry && entry.available ? entry : null;
            const statTarget = "statTarget" in entry ? entry.statTarget : null;
            return (
              <tr key={`${entry.role}-${entry.location}`}>
                <td>
                  <code className="settings-code">{entry.location}</code>
                  {statTarget && statTarget !== entry.location ? (
                    <span className="status-cell__sub">Stats from {statTarget}</span>
                  ) : null}
                </td>
                <td>{entry.role}</td>
                <td>{usage ? formatBytes(usage.freeBytes) : null}</td>
                <td>{usage ? formatBytes(usage.totalBytes) : null}</td>
                <td>
                  {usage ? (
                    <span className="status-meter">
                      <span className="status-meter__bar" aria-hidden="true">
                        <span
                          className="status-meter__fill"
                          style={{ width: `${usage.usedPercent}%` }}
                        />
                      </span>
                      {usage.usedPercent}%
                    </span>
                  ) : (
                    <span className="status-tone--subtle">
                      {("error" in entry && entry.error) || "Unavailable"}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function StorageGroup() {
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

  return (
    <SettingsGroup
      title="Storage"
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
      {checks.length ? (
        <ul className="status-checks">
          {checks.map((check) => (
            <CheckRow key={`${result?.checkedAt}-${check.id}`} check={check} />
          ))}
        </ul>
      ) : null}
      <h4 className="status-subhead">Disk space</h4>
      <DiskSpace entries={health?.system?.diskSpace ?? []} />
    </SettingsGroup>
  );
}

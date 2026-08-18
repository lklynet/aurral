import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { StorageHealthDashboard, StorageHealthSummary } from "./StorageHealthDashboard";
import {
  getStorageHealthCache,
  refreshStorageHealth,
  subscribeStorageHealth,
} from "../../../hooks/useStorageHealth";
import { SettingsArrFieldSet } from "./arr/SettingsArrLayout";
import { runStorageHealthAction } from "../utils/runStorageHealthAction";

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  const decimals = size >= 10 || unitIndex === 0 ? 0 : 1;
  return `${size.toFixed(decimals)} ${units[unitIndex]}`;
}

function formatUptime(seconds) {
  if (!Number.isFinite(Number(seconds))) return null;
  const total = Math.max(0, Math.floor(Number(seconds || 0)));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours || days) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  return parts.join(" ");
}

function DiskSpaceTable({ entries = [] }) {
  if (!entries.length) {
    return <p className="arr-form-help">Disk space data is not available.</p>;
  }

  return (
    <div className="arr-table-wrap">
      <table className="arr-table arr-table--disk">
        <thead>
          <tr>
            <th scope="col">Location</th>
            <th scope="col">Role</th>
            <th scope="col">Free space</th>
            <th scope="col">Total space</th>
            <th scope="col">Used</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => {
            const usedPercent = Number(entry.usedPercent || 0);
            return (
              <tr key={`${entry.role || "disk"}-${entry.location}`}>
                <td>
                  <code className="arr-table__path">{entry.location}</code>
                  {entry.statTarget && entry.statTarget !== entry.location ? (
                    <span className="arr-table__subtle">Stats from {entry.statTarget}</span>
                  ) : null}
                </td>
                <td>{entry.role || "—"}</td>
                <td>{entry.available ? formatBytes(entry.freeBytes) : "—"}</td>
                <td>{entry.available ? formatBytes(entry.totalBytes) : "—"}</td>
                <td>
                  {entry.available ? (
                    <div className="arr-disk-meter">
                      <div className="arr-disk-meter__bar" aria-hidden>
                        <span
                          className="arr-disk-meter__fill"
                          style={{ width: `${usedPercent}%` }}
                        />
                      </div>
                      <span className="arr-disk-meter__label">{usedPercent}%</span>
                    </div>
                  ) : (
                    <span className="arr-table__subtle">{entry.error || "Unavailable"}</span>
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

function SystemSection({ title, children }) {
  return (
    <section className="settings-system__section">
      <div className="settings-system__section-header">
        <h2 className="settings-system__section-title">{title}</h2>
      </div>
      <div className="settings-system__rows">{children}</div>
    </section>
  );
}

function SystemRow({ label, children }) {
  return (
    <div className="settings-system__row">
      <div className="settings-system__copy">
        <div className="settings-system__label">{label}</div>
      </div>
      <div className="settings-system__value">{children ?? "—"}</div>
    </div>
  );
}

export function SettingsStorageHealthSection({
  hasUnsavedChanges,
  handleSaveSettings,
  health,
  showSuccess,
  showError,
}) {
  const [healthResult, setHealthResult] = useState(() => getStorageHealthCache().result);
  const [checkingHealth, setCheckingHealth] = useState(false);

  useEffect(
    () =>
      subscribeStorageHealth((cache) => {
        setHealthResult(cache.result);
      }),
    [],
  );

  const runHealthCheck = useCallback(
    async ({ notify = true } = {}) => {
      setCheckingHealth(true);
      try {
        const outcome = await runStorageHealthAction({
          hasUnsavedChanges,
          saveSettings: handleSaveSettings,
          refreshStorageHealth: () => refreshStorageHealth({ force: true }),
        });
        if (!outcome.saved) return null;
        const result = outcome.result;
        if (notify) {
          if (result.ok && !result.partial) {
            showSuccess("Storage checks passed");
          } else if (result.ok) {
            showSuccess("Storage checks finished with warnings");
          } else {
            showError("Storage checks found problems. Review the results below.");
          }
        }
        return result;
      } catch (error) {
        const message =
          error.response?.data?.message ||
          error.response?.data?.error ||
          error.message ||
          "Storage health check failed";
        if (notify) {
          showError(message);
        }
        return null;
      } finally {
        setCheckingHealth(false);
      }
    },
    [hasUnsavedChanges, handleSaveSettings, showError, showSuccess],
  );

  useEffect(() => {
    if (getStorageHealthCache().result) return undefined;
    let cancelled = false;
    setCheckingHealth(true);
    refreshStorageHealth()
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setCheckingHealth(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const system = health?.system || {};

  return (
    <>
      <SettingsArrFieldSet
        legend="Storage health"
      >
        <div className="settings-storage-health__toolbar">
          <p className="arr-form-help">Checks configured library, download, and playback paths.</p>
          <button
            type="button"
            className="arr-btn"
            onClick={() => runHealthCheck({ notify: true })}
            disabled={checkingHealth}
          >
            <RefreshCw className={`artist-icon-sm${checkingHealth ? " animate-spin" : ""}`} />
            {checkingHealth ? "Checking…" : "Run checks"}
          </button>
        </div>
        <StorageHealthSummary result={healthResult} loading={checkingHealth} />
        <StorageHealthDashboard result={healthResult} loading={checkingHealth} showSummary={false} />
      </SettingsArrFieldSet>

      <SettingsArrFieldSet legend="Disk space">
        <DiskSpaceTable entries={system.diskSpace || []} />
      </SettingsArrFieldSet>
    </>
  );
}

export function SettingsSystemSection({ health }) {
  const system = health?.system || {};
  const runtimeReady = !!health?.system;

  return (
    <div className="settings-system__body">
      <div className="settings-system__intro">
        <div>
          <h1 className="settings-system__title">System</h1>
        </div>
        <div className={`settings-system__status${runtimeReady ? " is-ready" : ""}`}>
          <span className="settings-system__status-dot" aria-hidden />
          {runtimeReady ? "Running" : "Loading"}
        </div>
      </div>

      <SystemSection title="Runtime">
        <SystemRow label="Version">
          {system.version || health?.appVersion}
        </SystemRow>
        <SystemRow label="Uptime">
          {formatUptime(system.uptimeSeconds)}
        </SystemRow>
        <SystemRow label="Environment">
          {system.mode && system.hostname ? `${system.mode} · ${system.hostname}` : null}
        </SystemRow>
        <SystemRow label="Platform">
          {system.nodeVersion && system.platform && system.arch
            ? `Node ${system.nodeVersion} · ${system.platform} ${system.arch}`
            : null}
        </SystemRow>
        <SystemRow label="Container">
          {system.docker == null ? null : system.docker ? "Docker" : "Host process"}
        </SystemRow>
      </SystemSection>

      <SystemSection title="Data">
        <SystemRow label="Database">
          {system.database?.label}
        </SystemRow>
        <SystemRow label="App data">
          <code>{system.dataDir}</code>
        </SystemRow>
        <SystemRow label="Database path">
          <code>{system.databasePath}</code>
        </SystemRow>
        <SystemRow label="Startup directory">
          <code>{system.startupDirectory}</code>
        </SystemRow>
      </SystemSection>

      <SystemSection title="More info">
        {(system.links || []).map((link) => (
          <SystemRow key={link.label} label={link.label}>
            <a href={link.url} target="_blank" rel="noopener noreferrer" className="arr-link">
              {link.value || link.url}
            </a>
          </SystemRow>
        ))}
      </SystemSection>
    </div>
  );
}

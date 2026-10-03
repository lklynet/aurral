import { useCallback, useEffect, useState } from "react";
import { AlertCircle, AlertTriangle, CheckCircle2 } from "lucide-react";
import { DotLoader } from "../../../components/DotLoader";
import {
  getUpgradeReadiness,
  recheckUpgradeReadiness,
} from "../../../utils/api/endpoints/settings.js";
import { formatDateTime } from "../../../utils/dateTime.js";

const BLOCKER_TITLES = {
  schema: "Database upgrade",
  "stored-data": "Stored settings",
  "identity-markers": "Track identity tags",
  "download-folder": "Downloads Folder layout",
  "download-folder-review": "Files to review",
  "single-password": "Admin account",
};

function ReviewItems({ blocker }) {
  const items = blocker.items || [];
  const remaining = Math.max(0, (blocker.totalItems || items.length) - items.length);
  return (
    <details className="settings-system__review">
      <summary>
        Show {blocker.totalItems || items.length} {blocker.totalItems === 1 ? "file" : "files"}
      </summary>
      <ul>
        {items.map((item) => (
          <li key={item.path}>
            <code>{item.path}</code>
            {item.reason ? <span>{item.reason}</span> : null}
          </li>
        ))}
        {remaining > 0 ? <li>and {remaining} more</li> : null}
      </ul>
    </details>
  );
}

export function SettingsUpgradeReadiness({ showSuccess, showError }) {
  const [readiness, setReadiness] = useState(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [rechecking, setRechecking] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setReadiness(await getUpgradeReadiness());
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleRecheck = async () => {
    setRechecking(true);
    try {
      await recheckUpgradeReadiness();
      showSuccess("Aurral 3.0 check queued. The results update when the background tasks finish.");
      await load();
    } catch {
      showError("Could not queue the Aurral 3.0 check. Try again.");
    } finally {
      setRechecking(false);
    }
  };

  const blockers = readiness?.blockers || [];
  const warnings = readiness?.warnings || [];

  let status;
  if (loading && !readiness) {
    status = (
      <div className="settings-system__value" role="status">
        <DotLoader size="xs" label={null} /> Checking…
      </div>
    );
  } else if (failed) {
    status = (
      <div className="settings-system__value settings-system__value--error" role="alert">
        <AlertCircle className="artist-icon-xs" aria-hidden />
        Could not check readiness.
        <button type="button" className="arr-btn" onClick={load}>
          Retry
        </button>
      </div>
    );
  } else if (readiness?.ready) {
    status = (
      <div className="settings-system__value settings-system__value--ready">
        <CheckCircle2 className="artist-icon-xs" aria-hidden />
        Ready for Aurral 3.0
      </div>
    );
  } else {
    status = (
      <div className="settings-system__value settings-system__value--warning">
        <AlertTriangle className="artist-icon-xs" aria-hidden />
        Needs attention
        <button type="button" className="arr-btn" onClick={handleRecheck} disabled={rechecking}>
          {rechecking ? <DotLoader size="xs" label={null} /> : null}
          Check again
        </button>
      </div>
    );
  }

  return (
    <section className="settings-system__section" aria-labelledby="settings-aurral-3-title">
      <div className="settings-system__section-header">
        <h2 className="settings-system__section-title" id="settings-aurral-3-title">
          Aurral 3.0
        </h2>
        <p className="settings-system__section-description">
          Aurral 3.0 removes support for data and settings from older versions. Update to 3.0 only
          after this check passes.
        </p>
      </div>
      <div className="settings-system__rows">
        <div className="settings-system__row">
          <div className="settings-system__copy">
            <div className="settings-system__label">Readiness</div>
          </div>
          {status}
        </div>
        {blockers.map((blocker) => (
          <div className="settings-system__row" key={blocker.kind}>
            <div className="settings-system__copy">
              <div className="settings-system__label">{BLOCKER_TITLES[blocker.kind] || blocker.kind}</div>
              <p className="settings-system__description">{blocker.message}</p>
              {blocker.kind === "download-folder-review" ? <ReviewItems blocker={blocker} /> : null}
            </div>
            <div className="settings-system__value">Blocks the update</div>
          </div>
        ))}
        {warnings.map((warning) => (
          <div className="settings-system__row" key={warning.kind}>
            <div className="settings-system__copy">
              <div className="settings-system__label">Still in use</div>
              <p className="settings-system__description">{warning.message}</p>
            </div>
            <div className="settings-system__value">
              {warning.lastSeenAt
                ? `Last seen ${formatDateTime(new Date(warning.lastSeenAt))}`
                : "Set now"}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

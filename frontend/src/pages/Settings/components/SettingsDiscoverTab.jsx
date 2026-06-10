import { useState } from "react";
import { RefreshCw, Trash2, Compass, X } from "lucide-react";
import FlipSaveButton from "../../../components/FlipSaveButton";
import { SettingsSelect } from "./SettingsField";

const AUTO_REFRESH_OPTIONS = [
  { value: 24, label: "Daily" },
  { value: 168, label: "Weekly" },
  { value: 720, label: "Monthly" },
];

const DISCOVERY_MODE_OPTIONS = [
  { value: "safer", label: "Safer" },
  { value: "balanced", label: "Balanced" },
  { value: "deeper", label: "Deeper" },
];

const LASTFM_DISCOVER_BANNER_KEY = "aurral:lastfm-discover-settings-banner";

const readLastfmDiscoverBannerDismissed = () => {
  try {
    return localStorage.getItem(LASTFM_DISCOVER_BANNER_KEY) === "1";
  } catch {
    return false;
  }
};

const formatBytes = (value) => {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = bytes / 1024;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size >= 10 ? size.toFixed(0) : size.toFixed(1)} ${units[unitIndex]}`;
};

export function SettingsDiscoverTab({
  settings,
  updateSettings,
  health,
  hasUnsavedChanges,
  saving,
  handleSaveSettings,
  refreshingDiscovery,
  discoveryProgressMessage,
  clearingCache,
  handleRefreshDiscovery,
  handleClearCache,
}) {
  const [lastfmBannerDismissed, setLastfmBannerDismissed] = useState(
    readLastfmDiscoverBannerDismissed,
  );
  const autoRefreshHours =
    settings.integrations?.lastfm?.discoveryAutoRefreshHours || 168;
  const discoveryMode =
    settings.integrations?.lastfm?.discoveryMode || "balanced";
  const discoveryProvider =
    health?.discovery?.provider === "listenbrainz-fallback"
      ? "ListenBrainz fallback"
      : "Last.fm";
  const isListenBrainzFallback =
    health?.discovery?.provider === "listenbrainz-fallback";
  const showLastfmDiscoverBanner =
    isListenBrainzFallback && !lastfmBannerDismissed;

  return (
    <div className="settings-page__panel">
      <div className="settings-page__panel-header">
        <h2 className="settings-page__panel-title">
          <Compass className="settings-page__panel-title-icon" />
          Discover
        </h2>
        <FlipSaveButton
          saving={saving}
          disabled={!hasUnsavedChanges}
          onClick={handleSaveSettings}
        />
      </div>

      <form
        onSubmit={handleSaveSettings}
        className="settings-page__form"
        autoComplete="off"
      >
        {showLastfmDiscoverBanner && (
          <div className="settings-page__banner">
            <div className="settings-page__banner-copy">
              <p className="settings-page__banner-title">
                Optional Last.fm upgrade
              </p>
              <p className="settings-page__banner-text">
                Add a free Last.fm API key in Integrations to unlock personalized
                recommendations, similar artists, tag and genre search, and custom
                weekly flows.
              </p>
            </div>
            <button
              type="button"
              className="btn btn-ghost btn-icon-square"
              onClick={() => {
                setLastfmBannerDismissed(true);
                try {
                  localStorage.setItem(LASTFM_DISCOVER_BANNER_KEY, "1");
                } catch {}
              }}
              aria-label="Dismiss Last.fm upgrade reminder"
            >
              <X className="settings-page__tab-icon" />
            </button>
          </div>
        )}

        <div className="settings-page__section">
          <h3 className="settings-page__section-title">Discovery behavior</h3>
          <fieldset className="settings-page__fields">
            <div className="settings-page__field">
              <label className="artist-field-label" htmlFor="discover-refresh">
                Auto-refresh frequency
              </label>
              <SettingsSelect
                id="discover-refresh"
                value={String(autoRefreshHours)}
                onChange={(e) =>
                  updateSettings({
                    ...settings,
                    integrations: {
                      ...settings.integrations,
                      lastfm: {
                        ...(settings.integrations?.lastfm || {}),
                        discoveryAutoRefreshHours: parseInt(
                          e.target.value,
                          10,
                        ),
                      },
                    },
                  })
                }
              >
                {AUTO_REFRESH_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </SettingsSelect>
            </div>
            {!isListenBrainzFallback && (
              <div className="settings-page__field">
                <label className="artist-field-label" htmlFor="discover-mode">
                  Discovery mode
                </label>
                <SettingsSelect
                  id="discover-mode"
                  value={discoveryMode}
                  onChange={(e) =>
                    updateSettings({
                      ...settings,
                      integrations: {
                        ...settings.integrations,
                        lastfm: {
                          ...(settings.integrations?.lastfm || {}),
                          discoveryMode: e.target.value,
                        },
                      },
                    })
                  }
                >
                  {DISCOVERY_MODE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </SettingsSelect>
                <div className="settings-page__hint-list">
                  <p>
                    <strong>Safer:</strong> favors more obvious,
                    high-confidence recommendations.
                  </p>
                  <p>
                    <strong>Balanced:</strong> mixes familiar artists with some
                    exploration.
                  </p>
                  <p>
                    <strong>Deeper:</strong> pushes further beyond the most obvious
                    similar artists.
                  </p>
                </div>
              </div>
            )}
          </fieldset>
        </div>

        <div className="settings-page__section">
          <h3 className="settings-page__section-title">Cache status</h3>
          <div className="settings-page__cache-layout">
            <div className="settings-page__meta-grid">
              <dl className="settings-page__meta-grid settings-page__meta-grid--two-col">
                <div className="settings-page__meta-item">
                  <dt className="settings-page__meta-term">Provider</dt>
                  <dd className="settings-page__meta-value">{discoveryProvider}</dd>
                </div>
                <div className="settings-page__meta-item">
                  <dt className="settings-page__meta-term">Last updated</dt>
                  <dd className="settings-page__meta-value">
                    {health?.discovery?.lastUpdated
                      ? new Date(health.discovery.lastUpdated).toLocaleString()
                      : "—"}
                  </dd>
                </div>
                <div className="settings-page__meta-item">
                  <dt className="settings-page__meta-term">Image cache size</dt>
                  <dd className="settings-page__meta-value">
                    {formatBytes(health?.discovery?.cachedImagesSizeBytes)}
                  </dd>
                </div>
                <div className="settings-page__meta-item">
                  <dt className="settings-page__meta-term">Cached images</dt>
                  <dd className="settings-page__meta-value">
                    {health?.discovery?.cachedImagesCount ?? "—"}
                  </dd>
                </div>
              </dl>
              {(health?.discovery?.isUpdating || refreshingDiscovery) && (
                <p className="settings-page__progress-line">
                  <RefreshCw className="artist-icon-xs animate-spin" />
                  {discoveryProgressMessage || "Refreshing discovery"}
                </p>
              )}
              {!refreshingDiscovery &&
                !health?.discovery?.isUpdating &&
                discoveryProgressMessage && (
                  <p className="settings-page__success-line">
                    {discoveryProgressMessage}
                  </p>
                )}
            </div>
            <div className="settings-page__cache-actions">
              <div className="settings-page__action-card">
                <p className="settings-page__action-card-label">Discovery data</p>
                <button
                  type="button"
                  onClick={handleRefreshDiscovery}
                  disabled={refreshingDiscovery}
                  className="btn btn-primary btn--full"
                >
                  <RefreshCw
                    className={`artist-icon-xs${refreshingDiscovery ? " animate-spin" : ""}`}
                  />
                  {refreshingDiscovery ? "Refreshing..." : "Refresh Discovery"}
                </button>
              </div>
              <div className="settings-page__action-card">
                <p className="settings-page__action-card-label">Image cache</p>
                <button
                  type="button"
                  onClick={handleClearCache}
                  disabled={clearingCache}
                  className="btn btn-secondary btn--full"
                >
                  <Trash2
                    className={`artist-icon-xs${clearingCache ? " animate-spin" : ""}`}
                  />
                  {clearingCache ? "Clearing..." : "Clear Image Cache"}
                </button>
              </div>
            </div>
          </div>
        </div>
      </form>
    </div>
  );
}

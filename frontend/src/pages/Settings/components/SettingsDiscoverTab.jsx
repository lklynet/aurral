import { useState } from "react";
import { Link } from "react-router-dom";
import { RefreshCw, Trash2, X } from "lucide-react";
import PillToggle from "../../../components/PillToggle";
import { DotLoader } from "../../../components/DotLoader";
import { SettingsInput, SettingsSelect } from "./SettingsField";
import { SettingsArrFieldSet, SettingsArrFormGroup } from "./arr/SettingsArrLayout";
import { formatDateTime } from "../../../utils/dateTime.js";

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
  handleSaveSettings,
  refreshingDiscovery,
  discoveryProgress,
  discoveryProgressMessage,
  clearingCache,
  handleRefreshDiscovery,
  handleClearCache,
}) {
  const [lastfmBannerDismissed, setLastfmBannerDismissed] = useState(
    readLastfmDiscoverBannerDismissed,
  );

  const autoRefreshHours = settings.integrations?.lastfm?.discoveryAutoRefreshHours || 168;
  const discoveryMode = settings.integrations?.lastfm?.discoveryMode || "balanced";
  const discoveryRecommendationsPerRefresh =
    settings.integrations?.lastfm?.discoveryRecommendationsPerRefresh ?? 200;
  const discoveryPersonalizedEnabled = settings.integrations?.lastfm?.discoveryPersonalizedEnabled !== false;
  const discoveryProvider =
    health?.discovery?.provider === "listenbrainz-fallback" ? "ListenBrainz fallback" : "Last.fm";
  const isListenBrainzFallback = health?.discovery?.provider === "listenbrainz-fallback";
  const showLastfmDiscoverBanner = isListenBrainzFallback && !lastfmBannerDismissed;
  const activeProgress = discoveryProgress ?? health?.discovery?.updateProgress;
  const showProgress = health?.discovery?.isUpdating || refreshingDiscovery;
  const progressMessage =
    discoveryProgressMessage || health?.discovery?.updateProgressMessage || "Refreshing discovery";

  const updateLastfmDiscovery = (patch) =>
    updateSettings({
      ...settings,
      integrations: {
        ...settings.integrations,
        lastfm: {
          ...(settings.integrations?.lastfm || {}),
          ...patch,
        },
      },
    });

  return (
    <div className="arr-page">
      <form onSubmit={handleSaveSettings} className="arr-form" autoComplete="off">
        {showLastfmDiscoverBanner && (
          <div className="settings-page__banner">
            <div className="settings-page__banner-copy">
              <p className="settings-page__banner-title">Last.fm recommendations</p>
              <p className="settings-page__banner-text">
                Add a Last.fm API key in{" "}
                <Link to="/settings/connect" className="arr-link">
                  Connect
                </Link>{" "}
                  for personalized recommendations, tags, and weekly flows.
              </p>
            </div>
            <button
              type="button"
              className="arr-btn arr-btn--ghost arr-btn--icon"
              onClick={() => {
                setLastfmBannerDismissed(true);
                try {
                  localStorage.setItem(LASTFM_DISCOVER_BANNER_KEY, "1");
                } catch {}
              }}
              aria-label="Dismiss Last.fm recommendations"
            >
              <X className="artist-icon-sm" />
            </button>
          </div>
        )}

        <SettingsArrFieldSet legend="Discovery behavior">
          <div className="arr-info">
            Use{" "}
            <Link to="/settings/connect" className="arr-link">
              Connect
            </Link>
            {" "}for API keys and{" "}
            <Link to="/profile" className="arr-link">
              Profile
            </Link>
            {" "}for personal accounts.
          </div>

          <SettingsArrFormGroup label="Auto-refresh frequency" labelFor="discover-refresh">
            <SettingsSelect
              id="discover-refresh"
              value={String(autoRefreshHours)}
              onChange={(e) =>
                updateLastfmDiscovery({
                  discoveryAutoRefreshHours: parseInt(e.target.value, 10),
                })
              }
            >
              {AUTO_REFRESH_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </SettingsSelect>
          </SettingsArrFormGroup>

          {!isListenBrainzFallback ? (
            <SettingsArrFormGroup
              label="Discovery mode"
              labelFor="discover-mode"
              help={
                <>
                  Safer favors familiar recommendations. Balanced mixes familiarity and exploration.
                  Deeper goes further beyond similar artists.
                </>
              }
            >
              <SettingsSelect
                id="discover-mode"
                value={discoveryMode}
                onChange={(e) => updateLastfmDiscovery({ discoveryMode: e.target.value })}
              >
                {DISCOVERY_MODE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </SettingsSelect>
            </SettingsArrFormGroup>
          ) : null}

          {!isListenBrainzFallback ? (
            <>
              <SettingsArrFormGroup
                label="Recommended artists"
                labelFor="discover-recommendations"
                help="Artists generated per refresh."
              >
                <SettingsInput
                  id="discover-recommendations"
                  type="number"
                  min={50}
                  max={500}
                  step={10}
                  value={discoveryRecommendationsPerRefresh}
                  onChange={(e) => {
                    const raw = Number(e.target.value);
                    const value = Number.isFinite(raw)
                      ? Math.max(50, Math.min(500, Math.floor(raw)))
                      : 200;
                    updateLastfmDiscovery({
                      discoveryRecommendationsPerRefresh: value,
                    });
                  }}
                />
              </SettingsArrFormGroup>
              <SettingsArrFormGroup
                label="Recommended playlists"
                help="Personalized playlists; off shows editorial playlists only."
              >
                <PillToggle
                  className="settings-toggle"
                  checked={discoveryPersonalizedEnabled}
                  onChange={(e) =>
                    updateLastfmDiscovery({
                      discoveryPersonalizedEnabled: e.target.checked,
                    })
                  }
                  aria-label="Recommended playlists"
                />
              </SettingsArrFormGroup>
            </>
          ) : null}
        </SettingsArrFieldSet>

        <SettingsArrFieldSet
          legend="Cache status"
          actions={
            <>
              <button
                type="button"
                className="arr-btn arr-btn--primary"
                onClick={handleRefreshDiscovery}
                disabled={refreshingDiscovery}
              >
                {refreshingDiscovery ? (
                  <DotLoader size="xs" label={null} />
                ) : (
                  <RefreshCw className="artist-icon-xs" aria-hidden />
                )}
                {refreshingDiscovery ? "Refreshing…" : "Refresh discovery"}
              </button>
              <button
                type="button"
                className="arr-btn"
                onClick={handleClearCache}
                disabled={clearingCache}
              >
                {clearingCache ? (
                  <DotLoader size="xs" label={null} />
                ) : (
                  <Trash2 className="artist-icon-xs" aria-hidden />
                )}
                {clearingCache ? "Clearing…" : "Clear image cache"}
              </button>
            </>
          }
        >
          <dl className="arr-meta-grid arr-meta-grid--two-col">
            <div>
              <dt className="arr-meta-term">Provider</dt>
              <dd className="arr-meta-value">{discoveryProvider}</dd>
            </div>
            <div>
              <dt className="arr-meta-term">Last updated</dt>
              <dd className="arr-meta-value">
                {health?.discovery?.lastUpdated
                  ? formatDateTime(new Date(health.discovery.lastUpdated))
                  : "—"}
              </dd>
            </div>
            <div>
              <dt className="arr-meta-term">Image cache size</dt>
              <dd className="arr-meta-value">
                {formatBytes(health?.discovery?.cachedImagesSizeBytes)}
              </dd>
            </div>
            <div>
              <dt className="arr-meta-term">Cached images</dt>
              <dd className="arr-meta-value">{health?.discovery?.cachedImagesCount ?? "—"}</dd>
            </div>
          </dl>

          {showProgress ? (
            <div className="arr-progress">
              <p className="arr-progress__line">
                <DotLoader size="xs" label={null} />
                <span>{progressMessage}</span>
                {typeof activeProgress === "number" ? (
                  <span className="arr-progress__pct">{activeProgress}%</span>
                ) : null}
              </p>
              {typeof activeProgress === "number" ? (
                <div className="arr-progress__bar">
                  <div className="arr-progress__fill" style={{ width: `${activeProgress}%` }} />
                </div>
              ) : null}
            </div>
          ) : null}

          {!showProgress && discoveryProgressMessage ? (
            <p className="arr-form-help arr-form-help--success">{discoveryProgressMessage}</p>
          ) : null}
        </SettingsArrFieldSet>
      </form>
    </div>
  );
}

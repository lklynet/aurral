import { DotLoader } from "../../../components/DotLoader";
import { useDiscoveryStatus } from "../../../hooks/useDiscoveryStatus";
import { formatDateTime } from "../../../utils/dateTime.ts";
import { SettingsInput } from "../components/SettingsField";
import { useServerSettings } from "../SettingsProviders";
import type { SettingsState } from "../utils";
import { formatBytes } from "../utils/formatBytes";
import { configuredStatus, providerStatus } from "../utils/serviceStatus";
import {
  SettingsActions,
  SettingsGroup,
  SettingsNote,
  SettingsPage,
  SettingsRow,
  SettingsServiceRow,
  useSettingsItem,
} from "../SettingsLayout";
import { NewsDetail } from "./discovery/NewsDetail";

type Integrations = SettingsState["integrations"];

const clamp = (raw: string, min: number, max: number, fallback: number) => {
  const value = Number(raw);
  return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value))) : fallback;
};

function useIntegration<K extends "ticketmaster">(key: K) {
  const { settings, updateSettings } = useServerSettings();
  const config = settings.integrations[key];
  const update = (patch: Partial<Integrations[K]>) =>
    updateSettings({
      ...settings,
      integrations: { ...settings.integrations, [key]: { ...config, ...patch } },
    });
  return [config, update] as const;
}

function TicketmasterDetail() {
  const [ticketmaster, update] = useIntegration("ticketmaster");
  return (
    <SettingsPage title="Ticketmaster" back="Discovery">
      <SettingsGroup
        title="API"
        note={
          <>
            Finds shows near you.{" "}
            <a
              href="https://developer-acct.ticketmaster.com/user/login"
              target="_blank"
              rel="noopener noreferrer"
              className="settings-link"
            >
              Get a consumer key
            </a>
          </>
        }
      >
        <SettingsRow label="Consumer key" htmlFor="ticketmaster-api-key">
          <SettingsInput
            id="ticketmaster-api-key"
            type="password"
            autoComplete="off"
            value={ticketmaster.apiKey || ""}
            onChange={(event) => update({ apiKey: event.target.value })}
          />
        </SettingsRow>
        <SettingsRow label="Search radius" htmlFor="ticketmaster-radius" help="Miles, 5 to 250.">
          <SettingsInput
            id="ticketmaster-radius"
            type="number"
            min={5}
            max={250}
            step={5}
            value={ticketmaster.searchRadiusMiles ?? 250}
            onChange={(event) =>
              update({ searchRadiusMiles: clamp(event.target.value, 5, 250, 250) })
            }
          />
        </SettingsRow>
      </SettingsGroup>
    </SettingsPage>
  );
}

function CacheGroup() {
  const {
    health,
    requestingDiscoveryRefresh,
    clearingCache,
    handleRefreshDiscovery,
    handleClearCache,
  } = useServerSettings();
  const { status } = useDiscoveryStatus();
  const updating = Boolean(status?.isUpdating);
  const progress = status?.updateProgress;
  const cacheSize = health?.discovery
    ? formatBytes(health.discovery.nativeImageCacheSizeBytes)
    : null;

  return (
    <SettingsGroup title="Status">
      <SettingsRow label="Last updated">
        <span className="settings-row__value">
          {updating
            ? `${status?.updateProgressMessage || "Refreshing"}${typeof progress === "number" ? ` ${progress}%` : ""}`
            : status?.lastUpdated
              ? formatDateTime(new Date(status.lastUpdated))
              : "Never"}
        </span>
      </SettingsRow>
      <SettingsRow label="Artwork cache">
        <span className="settings-row__value">
          {cacheSize ?? "Unknown"}
          {health?.discovery ? `, ${health.discovery.artworkLinkCount} links` : ""}
        </span>
      </SettingsRow>
      {!updating && status?.error ? (
        <SettingsNote tone="error">Last refresh failed: {status.error}</SettingsNote>
      ) : null}
      <SettingsActions>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={handleRefreshDiscovery}
          disabled={updating || requestingDiscoveryRefresh}
        >
          {updating || requestingDiscoveryRefresh ? <DotLoader size="xs" label={null} /> : null}
          Refresh now
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={handleClearCache}
          disabled={clearingCache}
        >
          {clearingCache ? <DotLoader size="xs" label={null} /> : null}
          Clear artwork cache
        </button>
      </SettingsActions>
    </SettingsGroup>
  );
}

export function DiscoverySection() {
  const { settings, health } = useServerSettings();
  const item = useSettingsItem();

  if (item === "ticketmaster") return <TicketmasterDetail />;
  if (item === "news") return <NewsDetail />;

  return (
    <SettingsPage title="Discovery">
      <CacheGroup />
      <SettingsGroup title="Sources">
        <SettingsServiceRow
          to="discovery/ticketmaster"
          name="Ticketmaster"
          status={configuredStatus(Boolean(health?.ticketmasterConfigured))}
        />
        <SettingsServiceRow
          to="discovery/news"
          name="News"
          status={providerStatus(settings.integrations.news.enabled, true)}
        />
      </SettingsGroup>
    </SettingsPage>
  );
}

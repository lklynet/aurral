import PillToggle from "../../../components/PillToggle";
import { DotLoader } from "../../../components/DotLoader";
import { useDiscoveryStatus } from "../../../hooks/useDiscoveryStatus";
import { formatDateTime } from "../../../utils/dateTime.ts";
import { SettingsInput } from "../components/SettingsField";
import { useServerSettings } from "../SettingsProviders";
import { SettingsLink } from "../../../navigation/settingsRoute";
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

function useIntegration<K extends "lastfm" | "ticketmaster">(key: K) {
  const { settings, updateSettings } = useServerSettings();
  const config = settings.integrations[key];
  const update = (patch: Partial<Integrations[K]>) =>
    updateSettings({
      ...settings,
      integrations: { ...settings.integrations, [key]: { ...config, ...patch } },
    });
  return [config, update] as const;
}

function LastfmDetail() {
  const [lastfm, update] = useIntegration("lastfm");
  return (
    <SettingsPage title="Last.fm" back="Discovery">
      <SettingsGroup
        title="API"
        note={
          <>
            Recommendations use ListenBrainz until you add an API key. Last.fm gives closer matches.
            Scrobbling also needs the secret.{" "}
            <a
              href="https://www.last.fm/api/account/create"
              target="_blank"
              rel="noopener noreferrer"
              className="settings-link"
            >
              Create an API account
            </a>
          </>
        }
      >
        <SettingsRow label="API key" htmlFor="lastfm-api-key">
          <SettingsInput
            id="lastfm-api-key"
            type="password"
            autoComplete="off"
            value={lastfm.apiKey || ""}
            onChange={(event) => update({ apiKey: event.target.value })}
          />
        </SettingsRow>
        <SettingsRow label="Shared secret" htmlFor="lastfm-api-secret">
          <SettingsInput
            id="lastfm-api-secret"
            type="password"
            autoComplete="off"
            value={lastfm.apiSecret || ""}
            onChange={(event) => update({ apiSecret: event.target.value })}
          />
        </SettingsRow>
      </SettingsGroup>
    </SettingsPage>
  );
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
      <SettingsGroup title="Local shows">
        <SettingsRow label="Recommended artists" htmlFor="ticketmaster-recommended">
          <PillToggle
            id="ticketmaster-recommended"
            checked={ticketmaster.localDiscoveryIncludeRecommendations !== false}
            aria-label="Recommended artists"
            onChange={(event) =>
              update({ localDiscoveryIncludeRecommendations: event.target.checked })
            }
          />
        </SettingsRow>
        <SettingsRow label="Trending artists" htmlFor="ticketmaster-trending">
          <PillToggle
            id="ticketmaster-trending"
            checked={ticketmaster.localDiscoveryIncludeTrending !== false}
            aria-label="Trending artists"
            onChange={(event) => update({ localDiscoveryIncludeTrending: event.target.checked })}
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
  const provider = health?.discovery?.provider;
  const updating = Boolean(status?.isUpdating);
  const progress = status?.updateProgress;
  const cacheSize = health?.discovery
    ? formatBytes(health.discovery.nativeImageCacheSizeBytes)
    : null;

  return (
    <SettingsGroup title="Status">
      <SettingsRow
        label="Source"
        help={
          provider === "listenbrainz" ? (
            <>
              <SettingsLink to="discovery/lastfm" className="settings-link">
                Add a Last.fm API key
              </SettingsLink>{" "}
              for closer matches.
            </>
          ) : null
        }
      >
        <span className="settings-row__value">
          {provider === "lastfm"
            ? "Last.fm"
            : provider === "listenbrainz"
              ? "ListenBrainz"
              : "None"}
        </span>
      </SettingsRow>
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

  if (item === "lastfm") return <LastfmDetail />;
  if (item === "ticketmaster") return <TicketmasterDetail />;
  if (item === "news") return <NewsDetail />;

  return (
    <SettingsPage title="Discovery">
      <CacheGroup />
      <SettingsGroup title="Sources">
        <SettingsServiceRow
          to="discovery/lastfm"
          name="Last.fm"
          status={configuredStatus(Boolean(health?.lastfmConfigured))}
        />
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

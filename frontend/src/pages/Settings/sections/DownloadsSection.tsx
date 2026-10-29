import "./downloads.css";
import { SettingsInput } from "../components/SettingsField";
import { useServerSettings } from "../SettingsProviders";
import { useSettingsRoute } from "../settingsRoute";
import { providerStatus } from "../utils/serviceStatus";
import {
  SettingsGroup,
  SettingsNote,
  SettingsPage,
  SettingsRow,
  SettingsServiceRow,
  useSettingsItem,
} from "../SettingsLayout";
import {
  AddDownloadClient,
  DownloadClientDetail,
  clientConfig,
  clientPriority,
  isClientConfigured,
  isClientEnabled,
  type DownloadClientDefinition,
} from "./downloads/DownloadClients";
import { ProwlarrDetail, prowlarrServiceStatus } from "./downloads/ProwlarrDetail";
import { QualityProfileDetail, qualityServiceStatus } from "./downloads/QualityProfileDetail";
import { PathMappingDetail, PathMappingsTable, resolveMappingItem } from "./downloads/PathMappings";

const MAX_REVIEW_WAIT_HOURS = 720;

export function DownloadsSection() {
  const data = useServerSettings();
  const { settings, downloadClientSettings, health, updateSettings } = data;
  const item = useSettingsItem();
  const route = useSettingsRoute();
  const clients: DownloadClientDefinition[] = downloadClientSettings
    ? Object.values(downloadClientSettings)
    : [];
  const enabledClients = clients.filter((definition) =>
    isClientEnabled(definition, clientConfig(settings, definition)),
  );
  const availableClients = clients.filter((definition) => !enabledClients.includes(definition));
  const activeClient = clients.find((definition) => definition.key === item);
  const mapping = resolveMappingItem(settings, item);

  if (activeClient)
    return <DownloadClientDetail key={activeClient.key} definition={activeClient} />;
  if (item === "add-client") return <AddDownloadClient available={availableClients} />;
  if (item === "prowlarr") return <ProwlarrDetail />;
  if (item === "quality") return <QualityProfileDetail />;
  if (mapping) return <PathMappingDetail key={item} index={mapping.index} />;

  return (
    <SettingsPage title="Downloads">
      <SettingsGroup
        title="Download clients"
        note={
          downloadClientSettings && enabledClients.length === 0 ? "No clients are on." : undefined
        }
        actions={
          availableClients.length > 0 ? (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => route.open("downloads/add-client")}
            >
              Add client
            </button>
          ) : null
        }
      >
        {downloadClientSettings ? null : (
          <SettingsNote tone="warning">
            Couldn&apos;t load download clients. Refresh the page to retry.
          </SettingsNote>
        )}
        {enabledClients.map((definition) => {
          const config = clientConfig(settings, definition);
          const configured = isClientConfigured(definition, config, health);
          const status = providerStatus(true, configured);
          const priority = clientPriority(definition, config);
          return (
            <SettingsServiceRow
              key={definition.key}
              to={`downloads/${definition.key}`}
              name={definition.label}
              status={
                configured && priority ? { ...status, label: `On, priority ${priority}` } : status
              }
            />
          );
        })}
      </SettingsGroup>
      <SettingsGroup title="Indexers">
        <SettingsServiceRow
          to="downloads/prowlarr"
          name="Prowlarr"
          status={prowlarrServiceStatus(data)}
        />
      </SettingsGroup>
      <SettingsGroup title="Quality">
        <SettingsServiceRow
          to="downloads/quality"
          name="Quality profile"
          status={qualityServiceStatus(settings)}
        />
      </SettingsGroup>
      <SettingsGroup title="Review queue">
        <SettingsRow
          label="Maximum wait (hours)"
          htmlFor="downloads-review-timeout"
          help="After this, unreviewed songs are denied and searched again. 0 waits forever."
        >
          <SettingsInput
            id="downloads-review-timeout"
            type="number"
            min={0}
            max={MAX_REVIEW_WAIT_HOURS}
            step={1}
            value={settings.reviewTimeoutHours ?? 0}
            onChange={(event) => {
              const raw = Number(event.target.value);
              updateSettings({
                ...settings,
                reviewTimeoutHours: Number.isFinite(raw)
                  ? Math.max(0, Math.min(MAX_REVIEW_WAIT_HOURS, Math.floor(raw)))
                  : 0,
              });
            }}
          />
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup
        title="Remote path mappings"
        note="Only needed when a download client sees your files at a different path than Aurral."
        actions={
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => route.open("downloads/mapping")}
          >
            Add mapping
          </button>
        }
      >
        <PathMappingsTable />
      </SettingsGroup>
    </SettingsPage>
  );
}

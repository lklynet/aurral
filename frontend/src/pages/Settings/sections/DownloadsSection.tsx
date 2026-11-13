import "./downloads.css";
import { useServerSettings } from "../SettingsProviders";
import { useSettingsRoute } from "../../../navigation/settingsRoute";
import { providerStatus } from "../utils/serviceStatus";
import {
  SettingsGroup,
  SettingsNote,
  SettingsPage,
  SettingsServiceRow,
  useSettingsItem,
} from "../SettingsLayout";
import {
  AddDownloadClient,
  DownloadClientDetail,
  clientConfig,
  isClientConfigured,
  isClientEnabled,
  type DownloadClientDefinition,
} from "./downloads/DownloadClients";
import { ProwlarrDetail, prowlarrServiceStatus } from "./downloads/ProwlarrDetail";
import { QualityProfileDetail, qualityServiceStatus } from "./downloads/QualityProfileDetail";
import { PathMappingDetail, PathMappingsTable, resolveMappingItem } from "./downloads/PathMappings";
import { pluginStatus, usePlugins } from "./PluginsSection";
import { DownloadSourceList, type DownloadSourceRow } from "./downloads/DownloadSources";

const SOURCE_IDS: Partial<Record<string, string>> = { nzbget: "usenet", sabnzbd: "usenet" };
const sourceId = (row: DownloadSourceRow) =>
  "client" in row ? (SOURCE_IDS[row.client.key] ?? row.id) : row.id;

export function DownloadsSection() {
  const data = useServerSettings();
  const { settings, downloadClientSettings, health } = data;
  const item = useSettingsItem();
  const route = useSettingsRoute();
  const clients: DownloadClientDefinition[] = downloadClientSettings
    ? Object.values(downloadClientSettings)
    : [];
  const enabledClients = clients.filter((definition) =>
    isClientEnabled(definition, clientConfig(settings, definition)),
  );
  const availableClients = clients.filter((definition) => !enabledClients.includes(definition));
  const pluginList = usePlugins().data;
  const pluginSources = pluginList?.safeMode
    ? []
    : (pluginList?.plugins ?? []).filter(
        (plugin) => plugin.enabled && plugin.manifest?.downloadSource,
      );
  const sources: DownloadSourceRow[] = [
    ...enabledClients.map((definition) => {
      const config = clientConfig(settings, definition);
      return {
        id: definition.key,
        name: definition.label,
        to: `downloads/${definition.key}`,
        status: providerStatus(true, isClientConfigured(definition, config, health)),
        priority: Number(config.priority ?? definition.defaults?.priority ?? 0),
        client: definition,
      };
    }),
    ...pluginSources.map((plugin) => ({
      id: `plugin:${plugin.id}`,
      name: plugin.manifest?.name ?? plugin.id,
      to: `plugins/${plugin.id}`,
      status: pluginStatus(plugin),
      priority: plugin.priority,
      plugin: plugin.id,
    })),
  ].sort(
    (left, right) =>
      left.priority - right.priority || sourceId(left).localeCompare(sourceId(right)),
  );
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
          downloadClientSettings && sources.length === 0
            ? "No clients are on."
            : sources.length > 1
              ? "Aurral tries them top to bottom."
              : undefined
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
        <DownloadSourceList rows={sources} />
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
          name="Quality"
          status={qualityServiceStatus(settings)}
        />
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

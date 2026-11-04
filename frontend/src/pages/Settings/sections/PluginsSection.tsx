import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { parseResponse, type InferResponseType } from "hono/client";
import PillToggle from "../../../components/PillToggle";
import { useToast } from "../../../contexts/ToastContext";
import { queryKeys } from "../../../queryClient.ts";
import { pluginsClient } from "../../../utils/api/clients/plugins.ts";
import { SettingsCommitInput } from "../components/SettingsField";
import { readApiError } from "../utils/apiError.ts";
import {
  SettingsGroup,
  SettingsNote,
  SettingsPage,
  SettingsRow,
  SettingsServiceRow,
  useSettingsItem,
  type ServiceStatus,
} from "../SettingsLayout";

type PluginList = InferResponseType<typeof pluginsClient.$get, 200>;
type Plugin = PluginList["plugins"][number];
type Manifest = NonNullable<Plugin["manifest"]>;
type Patch = { enabled?: boolean; settings?: Plugin["settings"]; priority?: number };

export function usePlugins(enabled = true) {
  return useQuery({
    queryKey: queryKeys.plugins,
    queryFn: ({ signal }) => parseResponse(pluginsClient.$get({}, { init: { signal } })),
    enabled,
  });
}

function useSavePlugin(id: string) {
  const queryClient = useQueryClient();
  const { showError } = useToast();
  return useMutation({
    mutationFn: (json: Patch) => parseResponse(pluginsClient[":id"].$put({ param: { id }, json })),
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.plugins }),
        queryClient.invalidateQueries({ queryKey: ["plugins", "actions"] }),
      ]),
    onError: (error) => {
      const failure = readApiError(error);
      showError(failure.error || failure.text || "Couldn't save the plugin");
    },
  });
}

export function pluginStatus(plugin: Plugin): ServiceStatus {
  if (plugin.error) return { label: "Can't load", tone: "error" };
  if (!plugin.enabled)
    return plugin.lastError
      ? { label: "Turned off", tone: "error" }
      : { label: "Off", tone: "muted" };
  if (!plugin.ready) return { label: "Needs setup", tone: "error" };
  return { label: plugin.manifest?.downloadSource ? `On, priority ${plugin.priority}` : "On" };
}

function describeAdds(manifest: Manifest) {
  const parts = manifest.actions.map((action) => `${action.label} in playlist menus`);
  if (manifest.downloadSource) parts.push("a download source");
  return parts.join(", ") || null;
}

function SettingField({
  plugin,
  setting,
  save,
}: {
  plugin: Plugin;
  setting: Manifest["settings"][number];
  save: (value: string | number | boolean) => void;
}) {
  const id = `plugin-${plugin.id}-${setting.key}`;
  const value = plugin.settings[setting.key];
  if (setting.type === "boolean")
    return (
      <SettingsRow label={setting.label} htmlFor={id} help={setting.help}>
        <PillToggle
          id={id}
          aria-label={setting.label}
          checked={value === true}
          onChange={(event) => save(event.target.checked)}
        />
      </SettingsRow>
    );
  return (
    <SettingsRow label={setting.label} htmlFor={id} help={setting.help}>
      <SettingsCommitInput
        id={id}
        type={setting.type === "text" ? "text" : setting.type}
        autoComplete="off"
        spellCheck={false}
        value={value === undefined ? "" : String(value)}
        onCommit={(next) =>
          save(setting.type === "number" && next.trim() !== "" ? Number(next) : next.trim())
        }
      />
    </SettingsRow>
  );
}

function PluginDetail({ plugin }: { plugin: Plugin }) {
  const save = useSavePlugin(plugin.id);
  const { manifest } = plugin;
  if (!manifest)
    return (
      <SettingsPage title={plugin.id} back="Plugins">
        <SettingsNote tone="error">{plugin.error}</SettingsNote>
      </SettingsPage>
    );
  const adds = describeAdds(manifest);
  return (
    <SettingsPage title={manifest.name} back="Plugins">
      {plugin.lastError ? (
        <SettingsNote tone="error">
          {plugin.lastError}
          {manifest.repository ? (
            <>
              {" "}
              <a
                className="settings-link"
                href={manifest.repository}
                target="_blank"
                rel="noreferrer"
              >
                Report it to the plugin
              </a>
            </>
          ) : null}
        </SettingsNote>
      ) : null}
      <SettingsGroup note={manifest.description}>
        <SettingsRow label="On" htmlFor={`plugin-${plugin.id}-enabled`}>
          <PillToggle
            id={`plugin-${plugin.id}-enabled`}
            aria-label="On"
            checked={plugin.enabled}
            onChange={(event) => save.mutate({ enabled: event.target.checked })}
          />
        </SettingsRow>
        {adds ? (
          <SettingsRow label="Adds">
            <span className="settings-row__value">{adds}</span>
          </SettingsRow>
        ) : null}
        <SettingsRow label="Version">
          <code className="settings-code">{manifest.version}</code>
        </SettingsRow>
        {manifest.repository ? (
          <SettingsRow label="Source">
            <a
              className="settings-link"
              href={manifest.repository}
              target="_blank"
              rel="noreferrer"
            >
              {manifest.repository.replace(/^https:\/\//, "")}
            </a>
          </SettingsRow>
        ) : null}
      </SettingsGroup>
      {manifest.settings.length ? (
        <SettingsGroup title="Settings">
          {manifest.settings.map((setting) => (
            <SettingField
              key={setting.key}
              plugin={plugin}
              setting={setting}
              save={(value) => save.mutate({ settings: { [setting.key]: value } })}
            />
          ))}
        </SettingsGroup>
      ) : null}
      {manifest.downloadSource ? (
        <SettingsGroup title="Downloads">
          <SettingsRow
            label="Priority"
            htmlFor={`plugin-${plugin.id}-priority`}
            help="Sources with a lower number are searched first."
          >
            <SettingsCommitInput
              id={`plugin-${plugin.id}-priority`}
              type="number"
              min={1}
              max={100}
              value={String(plugin.priority)}
              onCommit={(next) => {
                const priority = Math.round(Number(next));
                if (priority >= 1 && priority <= 100) save.mutate({ priority });
              }}
            />
          </SettingsRow>
        </SettingsGroup>
      ) : null}
    </SettingsPage>
  );
}

function SafeModeGroup({ list }: { list: PluginList }) {
  const queryClient = useQueryClient();
  const { showError } = useToast();
  const toggle = useMutation({
    mutationFn: (enabled: boolean) =>
      parseResponse(pluginsClient["safe-mode"].$put({ json: { enabled } })),
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.plugins }),
        queryClient.invalidateQueries({ queryKey: ["plugins", "actions"] }),
      ]),
    onError: () => showError("Couldn't change safe mode"),
  });
  return (
    <SettingsGroup title="Safe mode">
      <SettingsRow
        label="Safe mode"
        htmlFor="plugins-safe-mode"
        help={
          list.safeModeForced
            ? "AURRAL_SAFE_MODE is set, so no plugin runs."
            : "Runs Aurral with every plugin off. Try it before reporting a bug."
        }
      >
        <PillToggle
          id="plugins-safe-mode"
          aria-label="Safe mode"
          checked={list.safeMode}
          disabled={list.safeModeForced}
          onChange={(event) => toggle.mutate(event.target.checked)}
        />
      </SettingsRow>
    </SettingsGroup>
  );
}

export function PluginsSection() {
  const item = useSettingsItem();
  const plugins = usePlugins();
  const list = plugins.data;
  const active = item ? list?.plugins.find((plugin) => plugin.id === item) : undefined;

  if (active) return <PluginDetail key={active.id} plugin={active} />;

  return (
    <SettingsPage title="Plugins">
      {plugins.isError ? (
        <SettingsNote tone="warning">
          Couldn&apos;t load plugins. Refresh the page to retry.
        </SettingsNote>
      ) : null}
      {list ? (
        <>
          {list.safeMode ? (
            <SettingsNote tone="warning">Safe mode is on. No plugin runs.</SettingsNote>
          ) : null}
          <SettingsGroup
            title="Installed"
            note={
              <>
                Add a plugin by putting its folder in{" "}
                <code className="settings-code">{list.folder}</code>.
              </>
            }
          >
            {list.plugins.map((plugin) => (
              <SettingsServiceRow
                key={plugin.id}
                to={`plugins/${plugin.id}`}
                name={plugin.manifest?.name ?? plugin.id}
                status={pluginStatus(plugin)}
              />
            ))}
          </SettingsGroup>
          <SafeModeGroup list={list} />
        </>
      ) : null}
    </SettingsPage>
  );
}

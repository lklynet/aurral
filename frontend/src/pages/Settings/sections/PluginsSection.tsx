import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { parseResponse, type InferResponseType } from "hono/client";
import { ConfirmModal } from "../../../components/ConfirmModal";
import { DotLoader } from "../../../components/DotLoader";
import PillToggle from "../../../components/PillToggle";
import { useToast } from "../../../contexts/ToastContext";
import { queryKeys } from "../../../queryClient.ts";
import { API_BASE_URL } from "../../../utils/api/core.ts";
import { pluginsClient } from "../../../utils/api/clients/plugins.ts";
import { formatRelativeTime } from "../../../utils/dateTime.ts";
import { copyText } from "../../../utils/shareLink.ts";
import { SettingsCommitInput, SettingsInput, SettingsTextarea } from "../components/SettingsField";
import { useSettingsRoute } from "../../../navigation/settingsRoute.tsx";
import {
  SettingsActions,
  SettingsAdvancedGroup,
  SettingsGroup,
  SettingsNote,
  SettingsPage,
  SettingsRow,
  SettingsServiceRow,
  useSettingsItem,
  type ServiceStatus,
} from "../SettingsLayout";
import { readApiError } from "../../../utils/api/errors.ts";
import { OFFICIAL_PLUGINS_URL } from "../../../../../lib/officialPlugins.ts";

type PluginList = InferResponseType<typeof pluginsClient.$get, 200>;
type Plugin = PluginList["plugins"][number];
type Manifest = NonNullable<Plugin["manifest"]>;
type Patch = {
  enabled?: boolean;
  settings?: Plugin["settings"];
  priority?: number;
  capabilities?: Record<string, boolean>;
};
type Inspected = InferResponseType<(typeof pluginsClient.install.inspect)["$post"], 200>;

const errorText = (error: unknown, fallback: string) => {
  const failure = readApiError(error);
  return failure.error || failure.text || fallback;
};

export function usePlugins(enabled = true) {
  return useQuery({
    queryKey: queryKeys.plugins,
    queryFn: ({ signal }) => parseResponse(pluginsClient.$get({}, { init: { signal } })),
    enabled,
  });
}

function useRefreshPlugins() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.plugins }),
      queryClient.invalidateQueries({ queryKey: ["plugins"] }),
    ]);
}

function useSavePlugin(id: string) {
  const refresh = useRefreshPlugins();
  const { showError } = useToast();
  return useMutation({
    mutationFn: (json: Patch) => parseResponse(pluginsClient[":id"].$put({ param: { id }, json })),
    onSettled: refresh,
    onError: (error) => showError(errorText(error, "Couldn't save the plugin")),
  });
}

export function pluginStatus(plugin: Plugin): ServiceStatus {
  if (plugin.error) return { label: "Can't load", tone: "error" };
  if (!plugin.enabled)
    return plugin.lastError
      ? { label: "Turned off", tone: "error" }
      : { label: "Off", tone: "muted" };
  if (!plugin.ready) return { label: "Needs setup", tone: "error" };
  return { label: "On" };
}

function CapabilityList({ plugin }: { plugin: Inspected["plugins"][number] }) {
  const parts = plugin.capabilities.map((capability) => (
    <span
      key={capability.key}
      className={capability.key === "api" ? "settings-row__warning" : undefined}
    >
      {capability.kind}: {capability.label}
    </span>
  ));
  if (plugin.manifest.uses.length)
    parts.push(<span key="uses">Uses {plugin.manifest.uses.join(", ")}</span>);
  return parts.flatMap((part, index) => (index ? [", ", part] : [part]));
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

function PluginTest({ plugin }: { plugin: Plugin }) {
  const refresh = useRefreshPlugins();
  const test = useMutation({
    mutationFn: () => parseResponse(pluginsClient[":id"].test.$post({ param: { id: plugin.id } })),
    onSettled: refresh,
  });
  const status = test.isSuccess
    ? { tone: "success" as const, message: test.data.message }
    : test.isError
      ? { tone: "error" as const, message: errorText(test.error, "The test failed") }
      : null;
  return (
    <SettingsActions status={status}>
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        onClick={() => test.mutate()}
        disabled={test.isPending}
      >
        {test.isPending ? <DotLoader size="xs" label={null} /> : null}
        Test
      </button>
    </SettingsActions>
  );
}

function UpdateLine({ update }: { update: NonNullable<Plugin["update"]> }) {
  return (
    <>
      Update to {update.version}
      {update.adds.length ? (
        <>
          {" · "}
          <span className="settings-row__warning">
            adds{" "}
            {update.adds.map((capability) => `${capability.kind}: ${capability.label}`).join(", ")}
          </span>
        </>
      ) : null}
    </>
  );
}

function PluginManage({ plugin }: { plugin: Plugin }) {
  const route = useSettingsRoute();
  const refresh = useRefreshPlugins();
  const { showSuccess, showError } = useToast();
  const [removing, setRemoving] = useState(false);
  const update = useMutation({
    mutationFn: () =>
      parseResponse(pluginsClient[":id"].update.$post({ param: { id: plugin.id } })),
    onSuccess: ({ installed: [updated] }) =>
      showSuccess(updated ? `Updated to ${updated.version}` : "Updated"),
    onError: (error) => showError(errorText(error, "Couldn't update the plugin")),
    onSettled: refresh,
  });
  const remove = useMutation({
    mutationFn: () => parseResponse(pluginsClient[":id"].$delete({ param: { id: plugin.id } })),
    onSuccess: async () => {
      setRemoving(false);
      route.back();
      await refresh();
    },
    onError: (error) => showError(errorText(error, "Couldn't remove the plugin")),
  });
  const name = plugin.manifest?.name ?? plugin.id;
  return (
    <SettingsGroup>
      {plugin.sourceUrl ? (
        <SettingsRow
          label="Update"
          help={plugin.update ? <UpdateLine update={plugin.update} /> : plugin.sourceUrl}
        >
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => update.mutate()}
            disabled={update.isPending}
          >
            {update.isPending ? <DotLoader size="xs" label={null} /> : null}
            Update
          </button>
        </SettingsRow>
      ) : null}
      <SettingsRow label="Remove" help="Deletes the plugin, its settings, and its files.">
        <button type="button" className="btn btn-danger btn-sm" onClick={() => setRemoving(true)}>
          Remove
        </button>
      </SettingsRow>
      <ConfirmModal
        open={removing}
        title={`Remove ${name}?`}
        body="Its folder, settings, and files are deleted. Playlists it imported stay."
        confirmLabel="Remove"
        busyLabel="Removing…"
        tone="danger"
        busy={remove.isPending}
        onCancel={() => setRemoving(false)}
        onConfirm={() => remove.mutate()}
      />
    </SettingsGroup>
  );
}

function PluginDetail({ plugin }: { plugin: Plugin }) {
  const save = useSavePlugin(plugin.id);
  const { manifest } = plugin;
  if (!manifest)
    return (
      <SettingsPage title={plugin.id} back="Plugins">
        <SettingsNote tone="error">{plugin.error}</SettingsNote>
        <PluginManage plugin={plugin} />
      </SettingsPage>
    );
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
        {manifest.uses.length ? (
          <SettingsRow label="Uses">
            <span className="settings-row__value">{manifest.uses.join(", ")}</span>
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
      {plugin.capabilities.length ? (
        <SettingsGroup title="Adds">
          {plugin.capabilities.map((capability) => {
            const id = `plugin-${plugin.id}-${capability.key}`;
            return (
              <SettingsRow
                key={capability.key}
                label={capability.label}
                htmlFor={id}
                help={capability.kind}
              >
                <PillToggle
                  id={id}
                  aria-label={capability.label}
                  checked={capability.enabled}
                  onChange={(event) =>
                    save.mutate({ capabilities: { [capability.key]: event.target.checked } })
                  }
                />
              </SettingsRow>
            );
          })}
        </SettingsGroup>
      ) : null}
      {manifest.settings.length || manifest.test ? (
        <SettingsGroup title="Settings">
          {manifest.settings.map((setting) => (
            <SettingField
              key={setting.key}
              plugin={plugin}
              setting={setting}
              save={(value) => save.mutate({ settings: { [setting.key]: value } })}
            />
          ))}
          {manifest.test ? <PluginTest plugin={plugin} /> : null}
        </SettingsGroup>
      ) : null}
      {manifest.downloadSource ? (
        <SettingsAdvancedGroup>
          <SettingsRow
            label="Priority"
            htmlFor={`plugin-${plugin.id}-priority`}
            help="Sources with a lower number are searched first."
          >
            <SettingsCommitInput
              id={`plugin-${plugin.id}-priority`}
              type="number"
              min={1}
              max={1000}
              value={String(plugin.priority)}
              onCommit={(next) => {
                const priority = Math.round(Number(next));
                if (priority >= 1 && priority <= 1000) save.mutate({ priority });
              }}
            />
          </SettingsRow>
        </SettingsAdvancedGroup>
      ) : null}
      <PluginManage plugin={plugin} />
    </SettingsPage>
  );
}

function InstallGroup({ list }: { list: PluginList }) {
  const refresh = useRefreshPlugins();
  const { showSuccess } = useToast();
  const [url, setUrl] = useState("");
  const [checked, setChecked] = useState<Inspected | null>(null);
  const [installed, setInstalled] = useState<string[]>([]);
  const inspect = useMutation({
    mutationFn: (link: string) =>
      parseResponse(pluginsClient.install.inspect.$post({ json: { url: link } })),
    onSuccess: (result) => {
      setChecked(result);
      setInstalled([]);
    },
  });
  const install = useMutation({
    mutationFn: ({ token, id }: { token: string; id: string }) =>
      parseResponse(pluginsClient.install.$post({ json: { token, ids: [id] } })),
    onSuccess: async ({ installed: [done] }) => {
      if (!done) return;
      setInstalled((ids) => [...ids, done.id]);
      showSuccess(`Installed ${done.id} ${done.version}. Turn it on to use it.`);
      await refresh();
    },
  });
  const failure = inspect.error ?? install.error;

  if (checked) {
    const close = () => {
      void pluginsClient.install[":token"].$delete({ param: { token: checked.token } });
      setChecked(null);
      setUrl("");
      install.reset();
    };
    return (
      <SettingsGroup title="Install from a link" note={url.replace(/^https:\/\//, "")}>
        {checked.plugins.map((found) => {
          const { manifest } = found;
          const busy = install.isPending && install.variables.id === manifest.id;
          return (
            <SettingsRow
              key={manifest.id}
              label={`${manifest.name} ${manifest.version}`}
              help={<CapabilityList plugin={found} />}
            >
              {installed.includes(manifest.id) ? (
                <span className="settings-row__value">Installed</span>
              ) : (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => install.mutate({ token: checked.token, id: manifest.id })}
                  disabled={install.isPending}
                >
                  {busy ? <DotLoader size="xs" label={null} /> : null}
                  {found.installedVersion ? `Update from ${found.installedVersion}` : "Install"}
                </button>
              )}
            </SettingsRow>
          );
        })}
        {checked.problems.map((problem) => (
          <SettingsRow
            key={problem.folder}
            label={problem.folder}
            help={`Can't load: ${problem.error}`}
            tone="error"
          />
        ))}
        <SettingsActions
          status={
            install.error
              ? { tone: "error", message: errorText(install.error, "Couldn't install it") }
              : null
          }
        >
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={close}
            disabled={install.isPending}
          >
            Done
          </button>
        </SettingsActions>
      </SettingsGroup>
    );
  }

  return (
    <SettingsGroup
      title="Install from a link"
      note={
        <>
          Paste a link to a plugin&apos;s GitHub repo, or{" "}
          <button
            type="button"
            className="settings-link"
            disabled={inspect.isPending}
            onClick={() => {
              setUrl(OFFICIAL_PLUGINS_URL);
              inspect.mutate(OFFICIAL_PLUGINS_URL);
            }}
          >
            use the official plugins
          </button>
          . You can also put its folder in <code className="settings-code">{list.folder}</code>.
        </>
      }
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (url.trim()) inspect.mutate(url);
        }}
      >
        <SettingsRow
          label="Link"
          htmlFor="plugin-install-url"
          help={failure ? errorText(failure, "Couldn't read the plugin") : undefined}
          tone={failure ? "error" : "default"}
        >
          <SettingsInput
            id="plugin-install-url"
            type="url"
            placeholder="https://github.com/you/aurral-plugins"
            autoComplete="off"
            spellCheck={false}
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
          <button
            type="submit"
            className="btn btn-secondary btn-sm"
            disabled={inspect.isPending || !url.trim()}
          >
            {inspect.isPending ? <DotLoader size="xs" label={null} /> : null}
            Check
          </button>
        </SettingsRow>
      </form>
    </SettingsGroup>
  );
}

const mcpUrl = () => new URL(`${API_BASE_URL}/mcp`, window.location.href).href;

const agentPrompt = (key: string) => `Build an Aurral plugin that ___.
Connect to the MCP server at ${mcpUrl()}
with the header Authorization: Bearer ${key}
Read plugin_docs first. Test with test_plugin until it passes.`;

function AgentGroup() {
  const queryClient = useQueryClient();
  const { showSuccess, showError } = useToast();
  const keys = useQuery({
    queryKey: queryKeys.pluginDevKeys,
    queryFn: ({ signal }) =>
      parseResponse(pluginsClient["dev-keys"].$get({}, { init: { signal } })),
  });
  const refreshKeys = () => queryClient.invalidateQueries({ queryKey: queryKeys.pluginDevKeys });
  const [prompt, setPrompt] = useState<string | null>(null);
  const copy = useMutation({
    mutationFn: async () => {
      const { key } = await parseResponse(pluginsClient["dev-keys"].$post());
      const text = agentPrompt(key);
      const copied = await copyText(text);
      setPrompt(copied ? null : text);
      return copied;
    },
    onSuccess: (copied) => {
      if (copied) showSuccess("Prompt copied. Paste it into your agent.");
    },
    onError: (error) => showError(errorText(error, "Couldn't create a developer key")),
    onSettled: refreshKeys,
  });
  const revoke = useMutation({
    mutationFn: (keyId: number) =>
      parseResponse(
        pluginsClient["dev-keys"][":keyId"].$delete({ param: { keyId: String(keyId) } }),
      ),
    onSettled: refreshKeys,
  });
  return (
    <SettingsGroup
      title="Build with an agent"
      note="Tell your agent what you want. It builds and tests the plugin in this Aurral, and you turn it on when it's ready."
    >
      <SettingsRow label="Developer key" help="Expires in 24 hours.">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => copy.mutate()}
          disabled={copy.isPending}
        >
          {copy.isPending ? <DotLoader size="xs" label={null} /> : null}
          Copy prompt
        </button>
      </SettingsRow>
      {prompt ? (
        <SettingsRow
          label="Prompt"
          help="Your browser didn't allow copying. Copy this into your agent."
          stack
        >
          <SettingsTextarea
            readOnly
            rows={4}
            value={prompt}
            aria-label="Agent prompt"
            onFocus={(event) => event.currentTarget.select()}
          />
        </SettingsRow>
      ) : null}
      {(keys.data?.keys ?? []).map((key) => (
        <SettingsRow
          key={key.id}
          label={<code className="settings-code">aurral_dev_…{key.hint}</code>}
          help={
            key.lastUsedAt
              ? `Used ${formatRelativeTime(new Date(key.lastUsedAt))}`
              : `Expires ${formatRelativeTime(new Date(key.expiresAt))}`
          }
        >
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => revoke.mutate(key.id)}
            disabled={revoke.isPending}
          >
            Revoke
          </button>
        </SettingsRow>
      ))}
    </SettingsGroup>
  );
}

function SafeModeGroup({ list }: { list: PluginList }) {
  const refresh = useRefreshPlugins();
  const { showError } = useToast();
  const toggle = useMutation({
    mutationFn: (enabled: boolean) =>
      parseResponse(pluginsClient["safe-mode"].$put({ json: { enabled } })),
    onSettled: refresh,
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

function InstalledGroup({ list }: { list: PluginList }) {
  const refresh = useRefreshPlugins();
  const { showSuccess, showError } = useToast();
  const pending = list.plugins.filter((plugin) => plugin.update).length;
  const updateAll = useMutation({
    mutationFn: () => parseResponse(pluginsClient.updates.$post()),
    onSuccess: ({ installed }) =>
      showSuccess(
        installed.length === 1 ? "Updated 1 plugin" : `Updated ${installed.length} plugins`,
      ),
    onError: (error) => showError(errorText(error, "Couldn't update the plugins")),
    onSettled: refresh,
  });
  return (
    <SettingsGroup
      title="Installed"
      note={
        list.updatesCheckedAt && list.plugins.some((plugin) => plugin.sourceUrl)
          ? `Checked for updates ${formatRelativeTime(new Date(list.updatesCheckedAt))}.`
          : undefined
      }
      actions={
        pending ? (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => updateAll.mutate()}
            disabled={updateAll.isPending}
          >
            {updateAll.isPending ? <DotLoader size="xs" label={null} /> : null}
            Update {pending}
          </button>
        ) : null
      }
    >
      {list.plugins.map((plugin) => (
        <SettingsServiceRow
          key={plugin.id}
          to={`plugins/${plugin.id}`}
          name={plugin.manifest?.name ?? plugin.id}
          detail={plugin.update ? <UpdateLine update={plugin.update} /> : null}
          status={pluginStatus(plugin)}
        />
      ))}
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
    <SettingsPage
      title={
        <>
          Plugins <span className="settings-beta">Beta</span>
        </>
      }
    >
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
          {list.plugins.length ? <InstalledGroup list={list} /> : null}
          <InstallGroup list={list} />
          <AgentGroup />
          <SafeModeGroup list={list} />
        </>
      ) : null}
    </SettingsPage>
  );
}

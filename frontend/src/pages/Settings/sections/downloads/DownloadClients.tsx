import { useState } from "react";
import { parseResponse } from "hono/client";
import { downloadClientSettingsClient } from "../../../../utils/api/clients/downloadClientSettings.ts";
import { DotLoader } from "../../../../components/DotLoader";
import { SettingsAdapterFields } from "../../components/SettingsAdapterFields";
import { readApiError } from "../../utils/apiError.ts";
import { useServerSettings } from "../../SettingsProviders";
import { useSettingsRoute } from "../../settingsRoute";
import {
  SettingsActions,
  SettingsGroup,
  SettingsNote,
  SettingsPage,
  SettingsRow,
} from "../../SettingsLayout";

type ServerSettings = ReturnType<typeof useServerSettings>;
type DownloadClientSettings = NonNullable<ServerSettings["downloadClientSettings"]>;
export type DownloadClientDefinition = DownloadClientSettings[keyof DownloadClientSettings] & {
  key: keyof DownloadClientSettings;
  healthKey?: keyof NonNullable<ServerSettings["health"]>;
};
type TestStatus =
  | { tone: "success" | "error"; message: string }
  | { tone: "warning"; message: string };

export const clientConfig = (
  settings: ServerSettings["settings"],
  definition: DownloadClientDefinition,
): Record<string, unknown> => settings.integrations?.[definition.key] || {};

export function isClientEnabled(
  definition: DownloadClientDefinition,
  config: Record<string, unknown>,
) {
  return definition.enabledDefault === true ? config.enabled !== false : config.enabled === true;
}

export function isClientConfigured(
  definition: DownloadClientDefinition,
  config: Record<string, unknown>,
  health: ServerSettings["health"],
) {
  if (definition.healthKey) return health?.[definition.healthKey] === true;
  return (definition.validation?.required || []).every((key) => String(config[key] || "").trim());
}

export function clientPriority(
  definition: DownloadClientDefinition,
  config: Record<string, unknown>,
) {
  if (!definition.fields.some((field) => field.key === "priority")) return null;
  const priority = config.priority ?? definition.defaults?.priority;
  return priority == null ? null : String(priority);
}

function missingRequiredFields(
  definition: DownloadClientDefinition,
  config: Record<string, unknown>,
) {
  return (definition.validation?.required || [])
    .filter((key) => !String(config[key] || "").trim())
    .map((key) => definition.fields.find((field) => field.key === key)?.label || key);
}

export function DownloadClientDetail({ definition }: { definition: DownloadClientDefinition }) {
  const { settings, updateSettings, handleSaveSettings, showSuccess, showError, showInfo } =
    useServerSettings();
  const [testing, setTesting] = useState(false);
  const [testStatus, setTestStatus] = useState<TestStatus | null>(null);
  const config = clientConfig(settings, definition);

  const update = (patch: Record<string, unknown>) => {
    setTestStatus(null);
    updateSettings({
      ...settings,
      integrations: {
        ...settings.integrations,
        [definition.key]: { ...config, ...patch },
      },
    });
  };

  const fail = (message: string) => {
    setTestStatus({ tone: "error", message });
    showError(message);
  };

  const test = async () => {
    const missing = missingRequiredFields(definition, config);
    if (definition.testRequiresEnabled && !isClientEnabled(definition, config)) {
      fail(`Enable ${definition.label} and enter its required settings first.`);
      return;
    }
    if (missing.length > 0) {
      fail(`Enter ${missing.join(" and ")} first.`);
      return;
    }

    setTestStatus(null);
    setTesting(true);
    try {
      if ((await handleSaveSettings()) === false) return;
      const result = await parseResponse(
        downloadClientSettingsClient["download-clients"][":key"].test.$post({
          param: { key: encodeURIComponent(definition.key) },
          json: config,
        }),
      );
      if (!(result.success || result.ok)) {
        fail(result.message || `${definition.label} connection failed`);
      } else if (
        result.warning ||
        ("soulseekConnected" in result && result.soulseekConnected === false)
      ) {
        const warning =
          result.message || `${definition.label} is reachable, but its service is not connected`;
        setTestStatus({ tone: "warning", message: warning });
        showInfo(warning);
      } else {
        setTestStatus({ tone: "success", message: "Connected." });
        showSuccess(result.message || `${definition.label} connection OK`);
      }
    } catch (error) {
      const failure = readApiError(error);
      fail(
        failure.message || failure.error || failure.text || `${definition.label} connection failed`,
      );
    } finally {
      setTesting(false);
    }
  };

  return (
    <SettingsPage title={definition.label} back="Downloads">
      <SettingsAdapterFields definition={definition} settings={config} onChange={update} />
      <SettingsGroup>
        <SettingsActions status={testStatus?.tone === "warning" ? null : testStatus}>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={testing}
            onClick={test}
          >
            {testing ? <DotLoader size="xs" label={null} /> : null}
            {testing ? "Testing…" : "Test connection"}
          </button>
        </SettingsActions>
        {testStatus?.tone === "warning" ? (
          <SettingsNote tone="warning">{testStatus.message}</SettingsNote>
        ) : null}
      </SettingsGroup>
    </SettingsPage>
  );
}

export function AddDownloadClient({ available }: { available: DownloadClientDefinition[] }) {
  const { settings, updateSettings } = useServerSettings();
  const route = useSettingsRoute();

  const add = (definition: DownloadClientDefinition) => {
    updateSettings({
      ...settings,
      integrations: {
        ...settings.integrations,
        [definition.key]: { ...clientConfig(settings, definition), enabled: true },
      },
    });
    route.open(`downloads/${definition.key}`);
  };

  return (
    <SettingsPage title="Add client" back="Downloads">
      <SettingsGroup>
        {available.length === 0 ? (
          <p className="settings-group__note">Every download client is already on.</p>
        ) : (
          available.map((definition) => (
            <SettingsRow key={definition.key} label={definition.label} help={definition.subtitle}>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => add(definition)}
              >
                Add
              </button>
            </SettingsRow>
          ))
        )}
      </SettingsGroup>
    </SettingsPage>
  );
}

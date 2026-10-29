import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { parseResponse, type InferResponseType } from "hono/client";
import { downloadClientSettingsClient } from "../../../../utils/api/clients/downloadClientSettings.ts";
import { queryClient, queryKeys } from "../../../../queryClient.ts";
import type { AppSettings } from "../../../../../../backend/db/helpers/settings.ts";
import { DotLoader } from "../../../../components/DotLoader";
import PillToggle from "../../../../components/PillToggle";
import { SettingsInput } from "../../components/SettingsField";
import { readApiError } from "../../utils/apiError.ts";
import { providerStatus } from "../../utils/serviceStatus";
import { useServerSettings } from "../../SettingsProviders";
import { SettingsActions, SettingsGroup, SettingsPage, SettingsRow } from "../../SettingsLayout";

type ServerSettings = ReturnType<typeof useServerSettings>;
type ProwlarrDraft = NonNullable<AppSettings["integrations"]["prowlarr"]>;
type ProwlarrIndexerOverride = NonNullable<ProwlarrDraft["indexers"]>[string];
type ProwlarrIndexer = InferResponseType<
  typeof downloadClientSettingsClient.prowlarr.indexers.$get,
  200
>["indexers"][number];
type TestStatus = { tone: "success" | "error"; message: string };

function toNumber(value: string, fallback: number) {
  const next = parseInt(value, 10);
  return Number.isFinite(next) ? next : fallback;
}

const readProwlarr = (settings: ServerSettings["settings"]): ProwlarrDraft =>
  settings.integrations?.prowlarr || {};

export function prowlarrServiceStatus({ settings, health }: ServerSettings) {
  const prowlarr = readProwlarr(settings);
  return providerStatus(
    prowlarr.enabled === true,
    health?.prowlarrConfigured || Boolean(prowlarr.url && prowlarr.apiKey),
  );
}

export function ProwlarrDetail() {
  const { settings, updateSettings, health, handleSaveSettings, showSuccess, showError, showInfo } =
    useServerSettings();
  const [testing, setTesting] = useState(false);
  const [testStatus, setTestStatus] = useState<TestStatus | null>(null);
  const prowlarr = readProwlarr(settings);
  const [categories, setCategories] = useState(() => (prowlarr.categories || [3000]).join(","));
  const connected = health?.prowlarrConfigured === true;
  const indexersQuery = useQuery({
    queryKey: queryKeys.prowlarrIndexers,
    queryFn: ({ signal }) =>
      parseResponse(downloadClientSettingsClient.prowlarr.indexers.$get({}, { init: { signal } })),
    enabled: connected,
    staleTime: 60_000,
  });
  const indexers: ProwlarrIndexer[] = connected ? indexersQuery.data?.indexers || [] : [];
  const loadingIndexers = indexersQuery.isFetching;

  const update = (patch: ProwlarrDraft) => {
    setTestStatus(null);
    updateSettings({
      ...settings,
      integrations: {
        ...settings.integrations,
        prowlarr: { ...settings.integrations.prowlarr, ...patch },
      },
    });
  };

  const updateIndexer = (id: number, patch: ProwlarrIndexerOverride) => {
    const key = String(id);
    update({
      indexers: {
        ...(prowlarr.indexers || {}),
        [key]: { ...(prowlarr.indexers?.[key] || {}), ...patch },
      },
    });
  };

  const indexerState = (indexer: ProwlarrIndexer) => {
    const override: Partial<ProwlarrIndexerOverride> =
      prowlarr.indexers?.[String(indexer.id)] || {};
    return {
      enabled: override.enabled !== false,
      priority: override.priority ?? indexer.priority ?? 25,
    };
  };

  const refreshIndexers = async () => {
    try {
      const { data } = await indexersQuery.refetch({ throwOnError: true });
      const count = data?.indexers?.length || 0;
      if (count > 0) showSuccess(`Loaded ${count} Usenet indexer(s)`);
      else showInfo("No usable Usenet indexers found in Prowlarr");
    } catch (error) {
      const failure = readApiError(error);
      showError(
        failure.message || failure.error || failure.text || "Failed to load Prowlarr indexers",
      );
    }
  };

  const test = async () => {
    setTestStatus(null);
    if (prowlarr.enabled !== true || !prowlarr.url || !prowlarr.apiKey) {
      setTestStatus({ tone: "error", message: "Enable Prowlarr and enter the URL and API key." });
      showError("Enable Prowlarr and enter URL and API key first");
      return;
    }
    setTesting(true);
    try {
      if ((await handleSaveSettings()) === false) return;
      const result = await parseResponse(downloadClientSettingsClient.prowlarr.test.$post());
      queryClient.setQueryData(queryKeys.prowlarrIndexers, {
        indexers: Array.isArray(result.indexers) ? result.indexers : [],
      });
      setTestStatus({ tone: "success", message: "Connected." });
      showSuccess(result.message || "Prowlarr connection OK");
    } catch (error) {
      setTestStatus({
        tone: "error",
        message: "Connection failed. Check the URL and API key, then retry.",
      });
      const failure = readApiError(error);
      showError(failure.message || failure.error || failure.text || "Prowlarr connection failed");
    } finally {
      setTesting(false);
    }
  };

  return (
    <SettingsPage title="Prowlarr" back="Downloads">
      <SettingsGroup>
        <SettingsRow label="Enable Prowlarr" htmlFor="prowlarr-enabled">
          <PillToggle
            id="prowlarr-enabled"
            checked={prowlarr.enabled === true}
            aria-label="Enable Prowlarr"
            onChange={(event) => update({ enabled: event.target.checked })}
          />
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup title="Connection">
        <SettingsRow label="Server URL" htmlFor="prowlarr-url">
          <SettingsInput
            id="prowlarr-url"
            type="url"
            placeholder="http://localhost:9696"
            autoComplete="off"
            value={prowlarr.url || ""}
            onChange={(event) => update({ url: event.target.value })}
          />
        </SettingsRow>
        <SettingsRow label="API key" htmlFor="prowlarr-api-key">
          <SettingsInput
            id="prowlarr-api-key"
            type="password"
            autoComplete="off"
            value={prowlarr.apiKey || ""}
            onChange={(event) => update({ apiKey: event.target.value })}
          />
        </SettingsRow>
        <SettingsActions status={testStatus}>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={testing || loadingIndexers}
            onClick={test}
          >
            {testing ? <DotLoader size="xs" label={null} /> : null}
            {testing ? "Testing…" : "Test connection"}
          </button>
        </SettingsActions>
      </SettingsGroup>
      <SettingsGroup title="Search">
        <SettingsRow
          label="Music categories"
          htmlFor="prowlarr-categories"
          help="Category IDs, separated by commas."
        >
          <SettingsInput
            id="prowlarr-categories"
            type="text"
            value={categories}
            onChange={(event) => {
              setCategories(event.target.value);
              update({
                categories: event.target.value
                  .split(",")
                  .map((entry) => parseInt(entry.trim(), 10))
                  .filter((entry) => Number.isFinite(entry)),
              });
            }}
          />
        </SettingsRow>
        <SettingsRow label="Result limit" htmlFor="prowlarr-max-results">
          <SettingsInput
            id="prowlarr-max-results"
            type="number"
            min="10"
            max="200"
            value={prowlarr.maxResults ?? 60}
            onChange={(event) => update({ maxResults: toNumber(event.target.value, 60) })}
          />
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup
        title="Usenet indexers"
        actions={
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={loadingIndexers || !connected}
            onClick={refreshIndexers}
          >
            {loadingIndexers ? <DotLoader size="xs" label={null} /> : null}
            {loadingIndexers ? "Refreshing…" : "Refresh"}
          </button>
        }
      >
        {!connected ? (
          <p className="settings-group__note">Connect Prowlarr to load its indexers.</p>
        ) : indexers.length === 0 ? (
          loadingIndexers ? null : (
            <p className="settings-group__note">Prowlarr returned no Usenet audio indexers.</p>
          )
        ) : (
          <div className="settings-table-wrap">
            <table className="settings-table">
              <thead>
                <tr>
                  <th scope="col">Indexer</th>
                  <th scope="col">Priority</th>
                  <th scope="col" className="settings-table__actions">
                    Use
                  </th>
                </tr>
              </thead>
              <tbody>
                {indexers.map((indexer) => {
                  const state = indexerState(indexer);
                  return (
                    <tr key={indexer.id}>
                      <td>
                        {indexer.name}
                        {indexer.enabledInProwlarr === false ? (
                          <span className="downloads-muted"> Off in Prowlarr</span>
                        ) : null}
                      </td>
                      <td>
                        <SettingsInput
                          className="downloads-priority"
                          type="number"
                          min="1"
                          max="1000"
                          aria-label={`${indexer.name} priority`}
                          value={state.priority}
                          onChange={(event) =>
                            updateIndexer(indexer.id, {
                              enabled: state.enabled,
                              priority: toNumber(event.target.value, indexer.priority || 25),
                            })
                          }
                        />
                      </td>
                      <td className="settings-table__actions">
                        <PillToggle
                          checked={state.enabled}
                          aria-label={`Use ${indexer.name} in Aurral`}
                          onChange={(event) =>
                            updateIndexer(indexer.id, {
                              enabled: event.target.checked,
                              priority: state.priority,
                            })
                          }
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </SettingsGroup>
    </SettingsPage>
  );
}

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getProwlarrIndexers, testProwlarrConnection } from "../../../utils/api/endpoints/settings.js";
import { queryClient, queryKeys } from "../../../queryClient.js";

import { RefreshCw } from "lucide-react";
import { DotLoader } from "../../../components/DotLoader";
import { SettingsInput } from "./SettingsField";
import { IntegrationCard, SettingsIntegrationModal } from "./SettingsIntegrationCards";
import {
  SettingsModalActions,
  SettingsModalField,
  SettingsModalSection,
  SettingsModalToggle,
} from "./SettingsModalLayout";
import { getIndexerStatus, getProviderStatus } from "../utils/integrationStatus";
function toNumber(value, fallback) {
  const next = parseInt(value, 10);
  return Number.isFinite(next) ? next : fallback;
}

export function SettingsIndexersSection({
  settings,
  updateSettings,
  health,
  handleSaveSettings,
  showSuccess,
  showError,
  showInfo,
}) {
  const [activeModal, setActiveModal] = useState(null);
  const [testingProwlarr, setTestingProwlarr] = useState(false);
  const [testStatus, setTestStatus] = useState(null);

  const prowlarr = settings.integrations?.prowlarr || {};
  const prowlarrConfigured = Boolean(prowlarr.url && prowlarr.apiKey);
  const prowlarrEnabled = prowlarr.enabled === true;
  const indexersQuery = useQuery({
    queryKey: queryKeys.prowlarrIndexers,
    queryFn: ({ signal }) => getProwlarrIndexers({ signal }),
    enabled: health?.prowlarrConfigured === true,
    staleTime: 60_000,
  });
  const prowlarrIndexers = health?.prowlarrConfigured
    ? Array.isArray(indexersQuery.data?.indexers)
      ? indexersQuery.data.indexers
      : []
    : [];
  const loadingProwlarrIndexers = indexersQuery.isFetching;

  useEffect(() => {
    setTestStatus(null);
  }, [activeModal]);

  const updateIntegration = (key, patch) => {
    setTestStatus(null);
    updateSettings({
      ...settings,
      integrations: {
        ...settings.integrations,
        [key]: {
          ...(settings.integrations?.[key] || {}),
          ...patch,
        },
      },
    });
  };

  const loadProwlarrIndexers = async ({ quiet = false } = {}) => {
    try {
      const { data: result } = await indexersQuery.refetch({ throwOnError: true });
      const indexers = Array.isArray(result?.indexers) ? result.indexers : [];
      if (!quiet && indexers.length > 0) {
        showSuccess(`Loaded ${indexers.length} Usenet indexer(s)`);
      }
      if (!quiet && indexers.length === 0) {
        showInfo("No usable Usenet indexers found in Prowlarr");
      }
    } catch (error) {
      if (!quiet) {
        showError(
          error.response?.data?.message ||
            error.response?.data?.error ||
            error.message ||
            "Failed to load Prowlarr indexers",
        );
      }
    }
  };

  const updateProwlarrIndexer = (id, patch) => {
    const key = String(id);
    updateIntegration("prowlarr", {
      indexers: {
        ...(prowlarr.indexers || {}),
        [key]: {
          ...(prowlarr.indexers?.[key] || {}),
          ...patch,
        },
      },
    });
  };

  const getIndexerState = (indexer) => {
    const override = prowlarr.indexers?.[String(indexer.id)] || {};
    const aurralEnabled = override.enabled !== false;
    const effectiveEnabled = indexer.enabledInProwlarr !== false && aurralEnabled;
    return {
      aurralEnabled,
      effectiveEnabled,
      priority: override.priority ?? indexer.priority ?? 25,
    };
  };

  const handleTestProwlarr = async () => {
    setTestStatus(null);
    if (!prowlarrEnabled || !prowlarr.url || !prowlarr.apiKey) {
      setTestStatus({ tone: "error", message: "Enable Prowlarr and enter the URL and API key." });
      showError("Enable Prowlarr and enter URL and API key first");
      return;
    }
    setTestingProwlarr(true);
    try {
      await handleSaveSettings();
      const result = await testProwlarrConnection();
      queryClient.setQueryData(queryKeys.prowlarrIndexers, {
        indexers: Array.isArray(result.indexers) ? result.indexers : [],
      });
      setTestStatus({ tone: "success", message: "Connected." });
      showSuccess(result.message || "Prowlarr connection OK");
    } catch (error) {
      setTestStatus({ tone: "error", message: "Connection failed. Check the URL and API key, then retry." });
      showError(
        error.response?.data?.message ||
          error.response?.data?.error ||
          error.message ||
          "Prowlarr connection failed",
      );
    } finally {
      setTestingProwlarr(false);
    }
  };

  const activeIndexer = activeModal?.startsWith("indexer:")
    ? prowlarrIndexers.find(
        (indexer) => String(indexer.id) === activeModal.slice("indexer:".length),
      )
    : null;

  return (
    <>
      <div className="settings-page__section">
        <div className="settings-page__section-header">
          {loadingProwlarrIndexers && (
            <span className="settings-page__status">
              <DotLoader size="sm" label={null} className="settings-page__status-icon" />
              Loading
            </span>
          )}
        </div>
        <div className="settings-page__integration-card-grid">
          <IntegrationCard
            title="Prowlarr"
            subtitle="Indexer manager"
            status={getProviderStatus(
              prowlarrEnabled,
              health?.prowlarrConfigured || prowlarrConfigured,
            )}
            meta={
              prowlarr.maxResults ? `Audio search · ${prowlarr.maxResults} results` : "Audio search"
            }
            onClick={() => setActiveModal("prowlarr")}
          />
          {prowlarrIndexers.map((indexer) => {
            const state = getIndexerState(indexer);
            return (
              <IntegrationCard
                key={indexer.id}
                title={indexer.name}
                subtitle="Usenet indexer"
                status={getIndexerStatus(indexer, state.effectiveEnabled)}
                meta={`Priority ${state.priority}`}
                onClick={() => setActiveModal(`indexer:${indexer.id}`)}
              />
            );
          })}
        </div>
        {health?.prowlarrConfigured &&
          !loadingProwlarrIndexers &&
          prowlarrIndexers.length === 0 && (
            <p className="settings-page__muted-copy">
              No Usenet audio indexers were returned by Prowlarr.
            </p>
          )}
      </div>

      {activeModal === "prowlarr" && (
        <SettingsIntegrationModal
          title="Prowlarr"
          onClose={() => setActiveModal(null)}
          testStatus={testStatus}
          footerActions={
            <button
              type="button"
              className="btn btn-secondary"
              disabled={testingProwlarr || loadingProwlarrIndexers}
              onClick={handleTestProwlarr}
            >
              {testingProwlarr ? (
                <DotLoader size="sm" label={null} />
              ) : (
                <RefreshCw className="artist-icon-sm" aria-hidden />
              )}
              {testingProwlarr ? "Testing..." : "Test connection"}
            </button>
          }
        >
          <SettingsModalToggle
            label="Enable Prowlarr"
            checked={prowlarrEnabled}
            onChange={(event) => updateIntegration("prowlarr", { enabled: event.target.checked })}
          />

          <SettingsModalSection title="Connection">
            <SettingsModalField label="Server URL">
              <SettingsInput
                type="url"
                placeholder="http://localhost:9696"
                autoComplete="off"
                value={prowlarr.url || ""}
                onChange={(event) => updateIntegration("prowlarr", { url: event.target.value })}
              />
            </SettingsModalField>
            <SettingsModalField label="API key">
              <SettingsInput
                type="password"
                autoComplete="off"
                value={prowlarr.apiKey || ""}
                onChange={(event) => updateIntegration("prowlarr", { apiKey: event.target.value })}
              />
            </SettingsModalField>
          </SettingsModalSection>

          <SettingsModalSection title="Indexing">
            <SettingsModalField label="Music categories">
              <SettingsInput
                type="text"
                value={(prowlarr.categories || [3000]).join(",")}
                onChange={(event) =>
                  updateIntegration("prowlarr", {
                    categories: event.target.value
                      .split(",")
                      .map((entry) => parseInt(entry.trim(), 10))
                      .filter((entry) => Number.isFinite(entry)),
                  })
                }
              />
            </SettingsModalField>
            <SettingsModalField label="Result limit">
              <SettingsInput
                type="number"
                min="10"
                max="200"
                value={prowlarr.maxResults ?? 60}
                onChange={(event) =>
                  updateIntegration("prowlarr", {
                    maxResults: toNumber(event.target.value, 60),
                  })
                }
              />
            </SettingsModalField>
            <SettingsModalActions>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={loadingProwlarrIndexers || !health?.prowlarrConfigured}
                onClick={() => loadProwlarrIndexers()}
              >
                {loadingProwlarrIndexers ? (
                  <DotLoader size="sm" label={null} />
                ) : (
                  <RefreshCw className="artist-icon-sm" aria-hidden />
                )}
                {loadingProwlarrIndexers ? "Refreshing..." : "Refresh indexers"}
              </button>
            </SettingsModalActions>
          </SettingsModalSection>
        </SettingsIntegrationModal>
      )}

      {activeIndexer && (
        <SettingsIntegrationModal title={activeIndexer.name} onClose={() => setActiveModal(null)}>
          {(() => {
            const state = getIndexerState(activeIndexer);
            return (
              <>
                <SettingsModalToggle
                  label="Enable in Aurral"
                  checked={state.aurralEnabled}
                  onChange={(event) =>
                    updateProwlarrIndexer(activeIndexer.id, {
                      enabled: event.target.checked,
                      priority: state.priority,
                    })
                  }
                />
                <SettingsModalSection title="Priority">
                  <SettingsModalField label="Priority">
                    <SettingsInput
                      type="number"
                      min="1"
                      max="1000"
                      value={state.priority}
                      onChange={(event) =>
                        updateProwlarrIndexer(activeIndexer.id, {
                          enabled: state.aurralEnabled,
                          priority: toNumber(event.target.value, activeIndexer.priority || 25),
                        })
                      }
                    />
                  </SettingsModalField>
                </SettingsModalSection>
                <SettingsModalSection title="Details">
                  <SettingsModalField label="Protocol">
                    <SettingsInput value={activeIndexer.protocol || "usenet"} readOnly />
                  </SettingsModalField>
                  <SettingsModalField label="Prowlarr status">
                    <SettingsInput
                      value={activeIndexer.enabledInProwlarr === false ? "Disabled" : "Enabled"}
                      readOnly
                    />
                  </SettingsModalField>
                </SettingsModalSection>
              </>
            );
          })()}
        </SettingsIntegrationModal>
      )}
    </>
  );
}

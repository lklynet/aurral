import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { testLyricsProviderConnection } from "../../../utils/api/endpoints/settings.js";
import { DotLoader } from "../../../components/DotLoader";
import { IntegrationCard, SettingsIntegrationModal } from "./SettingsIntegrationCards";
import { SettingsAdapterFields } from "./SettingsAdapterFields";
import { SettingsArrFieldSet } from "./arr/SettingsArrLayout";
import { getProviderStatus } from "../utils/integrationStatus";

function isProviderEnabled(definition, config) {
  return definition.enabledDefault === true ? config.enabled !== false : config.enabled === true;
}

function missingRequiredFields(definition, config) {
  return (definition.validation?.required || [])
    .filter((key) => !String(config[key] || "").trim())
    .map((key) => definition.fields.find((field) => field.key === key)?.label || key);
}

function providerMeta(definition, config) {
  const priority = config.priority ?? definition.defaults?.priority;
  return priority == null ? null : `Priority ${priority}`;
}

export function SettingsLyricsSection({
  settings,
  lyricsProviderSettings,
  updateSettings,
  handleSaveSettings,
  showSuccess,
  showError,
}) {
  const [activeModal, setActiveModal] = useState(null);
  const [testingProvider, setTestingProvider] = useState(null);
  const [testStatus, setTestStatus] = useState(null);

  useEffect(() => {
    setTestStatus(null);
  }, [activeModal]);

  const integrations = settings.integrations || {};
  const providerDefinitions = lyricsProviderSettings ? Object.values(lyricsProviderSettings) : [];
  const activeProvider = lyricsProviderSettings?.[activeModal] || null;

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

  const handleTestProvider = async (definition) => {
    const config = integrations[definition.key] || {};
    if (!isProviderEnabled(definition, config)) {
      const message = `Enable ${definition.label} first.`;
      setTestStatus({ tone: "error", message });
      showError(message);
      return;
    }
    const missing = missingRequiredFields(definition, config);
    if (missing.length > 0) {
      const message = `Enter ${missing.join(" and ")} first.`;
      setTestStatus({ tone: "error", message });
      showError(message);
      return;
    }

    setTestStatus(null);
    setTestingProvider(definition.key);
    try {
      const saved = await handleSaveSettings();
      if (saved === false) return;
      const result = await testLyricsProviderConnection(definition.key, config);
      if (result.success || result.ok) {
        setTestStatus({ tone: "success", message: "Connected." });
        showSuccess(result.message || `${definition.label} connection OK`);
      } else {
        const message = result.message || `${definition.label} connection failed`;
        setTestStatus({ tone: "error", message });
        showError(message);
      }
    } catch (error) {
      const message =
        error.response?.data?.message ||
        error.response?.data?.error ||
        error.message ||
        `${definition.label} connection failed`;
      setTestStatus({ tone: "error", message });
      showError(message);
    } finally {
      setTestingProvider(null);
    }
  };

  return (
    <>
      <SettingsArrFieldSet legend="Lyrics providers">
        <div className="arr-info">
          Providers are searched in priority order until one returns lyrics. Every provider is off
          until you enable it.
        </div>

        <div className="settings-page__integration-card-grid">
          {providerDefinitions.length > 0 ? (
            providerDefinitions.map((definition) => {
              const config = integrations[definition.key] || {};
              return (
                <IntegrationCard
                  key={definition.key}
                  title={definition.label}
                  subtitle={definition.subtitle}
                  status={getProviderStatus(
                    isProviderEnabled(definition, config),
                    missingRequiredFields(definition, config).length === 0,
                  )}
                  meta={providerMeta(definition, config)}
                  onClick={() => setActiveModal(definition.key)}
                />
              );
            })
          ) : (
            <div className="arr-info">
              {lyricsProviderSettings
                ? "No lyrics providers are available."
                : "Lyrics provider settings are unavailable. Refresh the page to retry."}
            </div>
          )}
        </div>
      </SettingsArrFieldSet>

      {activeProvider ? (
        <SettingsIntegrationModal
          title={activeProvider.label}
          onClose={() => setActiveModal(null)}
          testStatus={testStatus}
          footerActions={
            <button
              type="button"
              className="btn btn-secondary"
              disabled={testingProvider === activeProvider.key}
              onClick={() => handleTestProvider(activeProvider)}
            >
              {testingProvider === activeProvider.key ? (
                <DotLoader size="sm" label={null} />
              ) : (
                <RefreshCw className="artist-icon-sm" aria-hidden />
              )}
              {testingProvider === activeProvider.key ? "Testing..." : "Test connection"}
            </button>
          }
        >
          <SettingsAdapterFields
            key={activeProvider.key}
            definition={activeProvider}
            settings={integrations[activeProvider.key] || {}}
            onChange={(patch) => updateIntegration(activeProvider.key, patch)}
          />
        </SettingsIntegrationModal>
      ) : null}
    </>
  );
}

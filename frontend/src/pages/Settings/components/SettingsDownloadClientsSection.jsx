import { useEffect, useState } from "react";
import { testDownloadClientConnection } from "../../../utils/api/endpoints/settings.js";

import { Plus, RefreshCw, Trash2, Wrench } from "lucide-react";
import { DotLoader } from "../../../components/DotLoader";
import DownloadFolderField from "../../../components/DownloadFolderField";
import { IntegrationCard, SettingsIntegrationModal } from "./SettingsIntegrationCards";
import { SettingsAdapterFields } from "./SettingsAdapterFields";
import { SettingsArrFieldSet, SettingsArrFormGroup } from "./arr/SettingsArrLayout";
import { getProviderStatus } from "../utils/integrationStatus";
import { PATH_MAPPING_SOURCE_OPTIONS, PathMappingModal } from "./PathMappingModal";
import { QUALITY_TIER_LABELS, QualityProfileModal } from "./QualityProfileModal";

const PATH_MAPPING_SOURCE_VALUES = new Set(
  PATH_MAPPING_SOURCE_OPTIONS.map((option) => option.value),
);

function normalizePathMappingSource(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return PATH_MAPPING_SOURCE_VALUES.has(normalized) ? normalized : "all";
}

function coercePathMappings(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => ({
    source: normalizePathMappingSource(entry?.source),
    remote: String(entry?.remote || "").trim(),
    local: String(entry?.local || "").trim(),
  }));
}

function sourceLabel(source) {
  return PATH_MAPPING_SOURCE_OPTIONS.find((option) => option.value === source)?.label || source;
}

function isClientEnabled(definition, config) {
  return definition.enabledDefault === true ? config.enabled !== false : config.enabled === true;
}

function isClientConfigured(definition, config, health) {
  if (definition.healthKey) return health?.[definition.healthKey] === true;
  return (definition.validation?.required || []).every((key) => String(config[key] || "").trim());
}

function missingRequiredFields(definition, config) {
  return (definition.validation?.required || [])
    .filter((key) => !String(config[key] || "").trim())
    .map((key) => definition.fields.find((field) => field.key === key)?.label || key);
}

function clientMeta(definition, config) {
  const priorityField = definition.fields.find((field) => field.key === "priority");
  if (!priorityField) return null;
  const priority = config.priority ?? definition.defaults?.priority;
  return priority == null ? null : `Priority ${priority}`;
}

const QUALITY_PROFILE_MODAL = "quality-profile";

export function SettingsDownloadClientsSection({
  settings,
  downloadClientSettings,
  updateSettings,
  health,
  handleSaveSettings,
  showSuccess,
  showError,
  showInfo,
}) {
  const [activeModal, setActiveModal] = useState(null);
  const [testingClient, setTestingClient] = useState(null);
  const [testStatus, setTestStatus] = useState(null);
  const [mappingModal, setMappingModal] = useState(null);

  useEffect(() => {
    setTestStatus(null);
  }, [activeModal]);

  const integrations = settings.integrations || {};
  const pathMappings = coercePathMappings(settings.pathMappings).filter(
    (entry) => entry.remote || entry.local,
  );
  const qualityProfile = settings.qualityProfile || {};
  const qualityOrder = Array.isArray(qualityProfile.order)
    ? qualityProfile.order
    : Object.keys(QUALITY_TIER_LABELS);
  const qualityEnabled = new Set(
    Array.isArray(qualityProfile.enabled) ? qualityProfile.enabled : qualityOrder,
  );
  const clientDefinitions = downloadClientSettings
    ? Object.values(downloadClientSettings)
    : [];
  const activeClient = downloadClientSettings?.[activeModal] || null;

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

  const updatePathMappings = (nextMappings) => {
    updateSettings({
      ...settings,
      pathMappings: coercePathMappings(nextMappings),
    });
  };

  const updateQualityProfile = (patch) => {
    updateSettings({
      ...settings,
      qualityProfile: { ...qualityProfile, ...patch },
    });
  };

  const openAddMapping = () => {
    setMappingModal({ mode: "add", index: null });
  };

  const openEditMapping = (index) => {
    setMappingModal({ mode: "edit", index });
  };

  const closeMappingModal = () => {
    setMappingModal(null);
  };

  const saveMapping = (mapping) => {
    if (mappingModal?.mode === "edit" && mappingModal.index != null) {
      const nextMappings = [...pathMappings];
      nextMappings[mappingModal.index] = mapping;
      updatePathMappings(nextMappings);
    } else {
      updatePathMappings([...pathMappings, mapping]);
    }
    closeMappingModal();
  };

  const deleteMapping = (index) => {
    updatePathMappings(pathMappings.filter((_entry, entryIndex) => entryIndex !== index));
  };

  const handleTestClient = async (definition) => {
    const config = integrations[definition.key] || {};
    const missing = missingRequiredFields(definition, config);
    if (definition.testRequiresEnabled && !isClientEnabled(definition, config)) {
      const message = `Enable ${definition.label} and enter its required settings first.`;
      setTestStatus({ tone: "error", message });
      showError(message);
      return;
    }
    if (missing.length > 0) {
      const message = `Enter ${missing.join(" and ")} first.`;
      setTestStatus({ tone: "error", message });
      showError(message);
      return;
    }

    setTestStatus(null);
    setTestingClient(definition.key);
    try {
      const saved = await handleSaveSettings();
      if (saved === false) return;
      const result = await testDownloadClientConnection(definition.key, config);
      if (result.success || result.ok) {
        if (result.warning || result.soulseekConnected === false) {
          const warning =
            result.message || `${definition.label} is reachable, but its service is not connected`;
          setTestStatus({ tone: "warning", message: warning });
          showInfo(warning);
        } else {
          setTestStatus({ tone: "success", message: "Connected." });
          showSuccess(result.message || `${definition.label} connection OK`);
        }
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
      setTestingClient(null);
    }
  };

  return (
    <>
      <div className="settings-page__section">
        <div className="settings-page__integration-card-grid">
          {clientDefinitions.length > 0 ? (
            clientDefinitions.map((definition) => {
              const config = integrations[definition.key] || {};
              return (
                <IntegrationCard
                  key={definition.key}
                  title={definition.label}
                  subtitle={definition.subtitle}
                  status={getProviderStatus(
                    isClientEnabled(definition, config),
                    isClientConfigured(definition, config, health),
                  )}
                  meta={clientMeta(definition, config)}
                  onClick={() => setActiveModal(definition.key)}
                />
              );
            })
          ) : (
            <div className="arr-info">
              {downloadClientSettings
                ? "No download clients are available."
                : "Download client settings are unavailable. Refresh the page to retry."}
            </div>
          )}
        </div>
      </div>

      <SettingsArrFieldSet legend="Quality profile">
        <div className="arr-info">
          Choose formats, order, and upgrade cutoff.
        </div>
        <IntegrationCard
          title="Default"
          subtitle={`${qualityEnabled.size} qualities allowed`}
          status={{ label: "Configured", className: "is-enabled" }}
          meta={`Cutoff ${QUALITY_TIER_LABELS[qualityProfile.cutoff] || "not set"}`}
          onClick={() => setActiveModal(QUALITY_PROFILE_MODAL)}
        />
      </SettingsArrFieldSet>

      <SettingsArrFieldSet legend="Downloads folder">
        <SettingsArrFormGroup
          label="Path"
          labelFor="download-clients-download-folder"
          help="Example: /data/media/aurral_flow or /data/downloads/aurral"
        >
          <DownloadFolderField
            id="download-clients-download-folder"
            value={settings.downloadFolderPath || ""}
            autoApplySuggestion={false}
            onChange={(nextPath) =>
              updateSettings({
                ...settings,
                downloadFolderPath: nextPath,
              })
            }
          />
        </SettingsArrFormGroup>
      </SettingsArrFieldSet>

      <SettingsArrFieldSet legend="Remote path mappings">
        <div className="arr-info">
          Only needed when client and Aurral paths differ. Shared mounts need no mapping.
        </div>

        <div className="arr-table-wrap">
          <table className="arr-table">
            <thead>
              <tr>
                <th scope="col">Source</th>
                <th scope="col">Remote path</th>
                <th scope="col">Local path</th>
                <th scope="col" className="arr-table__actions-head">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {pathMappings.length === 0 ? (
                <tr className="arr-table__empty-row">
                  <td colSpan={4}>No path mappings configured.</td>
                </tr>
              ) : (
                pathMappings.map((mapping, index) => (
                  <tr key={`path-mapping-${index}`}>
                    <td>{sourceLabel(mapping.source)}</td>
                    <td>
                      <code className="arr-table__path">{mapping.remote}</code>
                    </td>
                    <td>
                      <code className="arr-table__path">{mapping.local}</code>
                    </td>
                    <td className="arr-table__actions">
                      <div className="arr-table__actions-inner">
                        <button
                          type="button"
                          className="arr-btn arr-btn--ghost arr-btn--icon"
                          aria-label={`Edit path mapping ${index + 1}`}
                          onClick={() => openEditMapping(index)}
                        >
                          <Wrench className="artist-icon-sm" aria-hidden />
                        </button>
                        <button
                          type="button"
                          className="arr-btn arr-btn--ghost arr-btn--icon"
                          aria-label={`Delete path mapping ${index + 1}`}
                          onClick={() => deleteMapping(index)}
                        >
                          <Trash2 className="artist-icon-sm" aria-hidden />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="arr-table-footer">
          <button
            type="button"
            className="arr-btn arr-btn--ghost arr-btn--icon"
            aria-label="Add path mapping"
            onClick={openAddMapping}
          >
            <Plus className="artist-icon-sm" aria-hidden />
          </button>
        </div>
      </SettingsArrFieldSet>

      {mappingModal ? (
        <PathMappingModal
          title={
            mappingModal.mode === "edit" ? "Edit remote path mapping" : "Add remote path mapping"
          }
          initialValue={
            mappingModal.mode === "edit" && mappingModal.index != null
              ? pathMappings[mappingModal.index]
              : undefined
          }
          onClose={closeMappingModal}
          onSave={saveMapping}
        />
      ) : null}

      {activeModal === QUALITY_PROFILE_MODAL && (
        <QualityProfileModal
          profile={{ ...qualityProfile, order: qualityOrder, enabled: [...qualityEnabled] }}
          onChange={updateQualityProfile}
          onClose={() => setActiveModal(null)}
        />
      )}

      {activeClient ? (
        <SettingsIntegrationModal
          title={activeClient.label}
          onClose={() => setActiveModal(null)}
          testStatus={testStatus}
          footerActions={
            <button
              type="button"
              className="btn btn-secondary"
              disabled={testingClient === activeClient.key}
              onClick={() => handleTestClient(activeClient)}
            >
              {testingClient === activeClient.key ? (
                <DotLoader size="sm" label={null} />
              ) : (
                <RefreshCw className="artist-icon-sm" aria-hidden />
              )}
              {testingClient === activeClient.key ? "Testing..." : "Test connection"}
            </button>
          }
        >
          <SettingsAdapterFields
            key={activeClient.key}
            definition={activeClient}
            settings={integrations[activeClient.key] || {}}
            onChange={(patch) => updateIntegration(activeClient.key, patch)}
          />
        </SettingsIntegrationModal>
      ) : null}
    </>
  );
}

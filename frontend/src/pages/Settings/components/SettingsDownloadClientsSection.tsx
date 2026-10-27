import { useEffect, useState } from "react";
import { testDownloadClientConnection } from "../../../utils/api/endpoints/settings.ts";

import { Plus, RefreshCw, Trash2, Wrench } from "../../../components/icons";
import { DotLoader } from "../../../components/DotLoader";
import DownloadFolderField from "../../../components/DownloadFolderField";
import { IntegrationCard, SettingsIntegrationModal } from "./SettingsIntegrationCards";
import { SettingsAdapterFields } from "./SettingsAdapterFields";
import { SettingsArrFieldSet, SettingsArrFormGroup } from "./arr/SettingsArrLayout";
import { SettingsInput } from "./SettingsField";
import { RootOverlapWarning } from "./RootOverlapWarning";
import { getProviderStatus } from "../utils/integrationStatus";
import { readApiError } from "../utils/apiError.ts";
import { PATH_MAPPING_SOURCE_OPTIONS, PathMappingModal } from "./PathMappingModal";
import { QUALITY_TIER_LABELS, QualityProfileModal } from "./QualityProfileModal";
import type { useSettingsData } from "../hooks/useSettingsData";
import type { QualityProfile } from "../../../../../backend/db/helpers/settings.ts";

type SettingsData = ReturnType<typeof useSettingsData>;
type DownloadClientSettings = NonNullable<SettingsData["downloadClientSettings"]>;
type DownloadClientDefinition = DownloadClientSettings[keyof DownloadClientSettings] & {
  key: keyof DownloadClientSettings;
  healthKey?: keyof NonNullable<SettingsData["health"]>;
};
type PathMapping = ReturnType<typeof coercePathMappings>[number];
type TestStatus = { tone: "success" | "warning" | "error"; message: string };
type MappingModal = { mode: "add" | "edit"; index: number | null };
type SettingsDownloadClientsSectionProps = Pick<
  SettingsData,
  "settings" | "downloadClientSettings" | "updateSettings" | "health" | "handleSaveSettings"
> & {
  showSuccess: (message: string) => void;
  showError: (message: string) => void;
  showInfo: (message: string) => void;
};

const PATH_MAPPING_SOURCE_VALUES = new Set(
  PATH_MAPPING_SOURCE_OPTIONS.map((option) => option.value),
);

function normalizePathMappingSource(value: unknown) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return PATH_MAPPING_SOURCE_VALUES.has(normalized) ? normalized : "all";
}

function coercePathMappings(value: SettingsData["settings"]["pathMappings"]) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => ({
    source: normalizePathMappingSource(entry?.source),
    remote: String(entry?.remote || "").trim(),
    local: String(entry?.local || "").trim(),
  }));
}

function sourceLabel(source: string) {
  return PATH_MAPPING_SOURCE_OPTIONS.find((option) => option.value === source)?.label || source;
}

function isClientEnabled(definition: DownloadClientDefinition, config: Record<string, unknown>) {
  return definition.enabledDefault === true ? config.enabled !== false : config.enabled === true;
}

function isClientConfigured(
  definition: DownloadClientDefinition,
  config: Record<string, unknown>,
  health: SettingsData["health"],
) {
  if (definition.healthKey) return health?.[definition.healthKey] === true;
  return (definition.validation?.required || []).every((key) => String(config[key] || "").trim());
}

function missingRequiredFields(
  definition: DownloadClientDefinition,
  config: Record<string, unknown>,
) {
  return (definition.validation?.required || [])
    .filter((key) => !String(config[key] || "").trim())
    .map((key) => definition.fields.find((field) => field.key === key)?.label || key);
}

function clientMeta(definition: DownloadClientDefinition, config: Record<string, unknown>) {
  const priorityField = definition.fields.find((field) => field.key === "priority");
  if (!priorityField) return null;
  const priority = config.priority ?? definition.defaults?.priority;
  return priority == null ? null : `Priority ${priority}`;
}

const QUALITY_PROFILE_MODAL = "quality-profile";
const ADD_CLIENT_MODAL = "add-client";

export function SettingsDownloadClientsSection({
  settings,
  downloadClientSettings,
  updateSettings,
  health,
  handleSaveSettings,
  showSuccess,
  showError,
  showInfo,
}: SettingsDownloadClientsSectionProps) {
  const [activeModal, setActiveModal] = useState<
    keyof DownloadClientSettings | typeof ADD_CLIENT_MODAL | typeof QUALITY_PROFILE_MODAL | null
  >(null);
  const [testingClient, setTestingClient] = useState<string | null>(null);
  const [testStatus, setTestStatus] = useState<TestStatus | null>(null);
  const [mappingModal, setMappingModal] = useState<MappingModal | null>(null);

  useEffect(() => {
    setTestStatus(null);
  }, [activeModal]);

  const integrations = settings.integrations || {};
  const pathMappings = coercePathMappings(settings.pathMappings).filter(
    (entry) => entry.remote || entry.local,
  );
  const qualityProfile: Partial<QualityProfile> = settings.qualityProfile || {};
  const qualityOrder = Array.isArray(qualityProfile.order)
    ? qualityProfile.order
    : Object.keys(QUALITY_TIER_LABELS);
  const qualityEnabled = new Set(
    Array.isArray(qualityProfile.enabled) ? qualityProfile.enabled : qualityOrder,
  );
  const clientDefinitions: DownloadClientDefinition[] = downloadClientSettings
    ? Object.values(downloadClientSettings)
    : [];
  const enabledClientDefinitions = clientDefinitions.filter((definition) =>
    isClientEnabled(definition, integrations[definition.key] || {}),
  );
  const availableClientDefinitions = clientDefinitions.filter(
    (definition) => !isClientEnabled(definition, integrations[definition.key] || {}),
  );
  const activeClient: DownloadClientDefinition | null =
    (activeModal !== null &&
    activeModal !== ADD_CLIENT_MODAL &&
    activeModal !== QUALITY_PROFILE_MODAL
      ? downloadClientSettings?.[activeModal]
      : undefined) || null;

  const updateIntegration = (
    key: DownloadClientDefinition["key"],
    patch: Record<string, unknown>,
  ) => {
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

  const addClient = (definition: DownloadClientDefinition) => {
    updateIntegration(definition.key, { enabled: true });
    setActiveModal(definition.key);
  };

  const updatePathMappings = (nextMappings: PathMapping[]) => {
    updateSettings({
      ...settings,
      pathMappings: coercePathMappings(nextMappings),
    });
  };

  const updateQualityProfile = (patch: Partial<QualityProfile>) => {
    updateSettings({
      ...settings,
      qualityProfile: { ...qualityProfile, ...patch },
    });
  };

  const openAddMapping = () => {
    setMappingModal({ mode: "add", index: null });
  };

  const openEditMapping = (index: number) => {
    setMappingModal({ mode: "edit", index });
  };

  const closeMappingModal = () => {
    setMappingModal(null);
  };

  const saveMapping = (mapping: PathMapping) => {
    if (mappingModal?.mode === "edit" && mappingModal.index != null) {
      const nextMappings = [...pathMappings];
      nextMappings[mappingModal.index] = mapping;
      updatePathMappings(nextMappings);
    } else {
      updatePathMappings([...pathMappings, mapping]);
    }
    closeMappingModal();
  };

  const deleteMapping = (index: number) => {
    updatePathMappings(pathMappings.filter((_entry, entryIndex) => entryIndex !== index));
  };

  const handleTestClient = async (definition: DownloadClientDefinition) => {
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
      const failure = readApiError(error);
      const message =
        failure.message || failure.error || failure.text || `${definition.label} connection failed`;
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
            enabledClientDefinitions.map((definition) => {
              const config = integrations[definition.key] || {};
              return (
                <IntegrationCard
                  key={definition.key}
                  title={definition.label}
                  subtitle={definition.subtitle}
                  status={getProviderStatus(true, isClientConfigured(definition, config, health))}
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
          {availableClientDefinitions.length > 0 ? (
            <button
              type="button"
              className="download-client-add"
              aria-label="Add download client"
              onClick={() => setActiveModal(ADD_CLIENT_MODAL)}
            >
              <Plus aria-hidden />
            </button>
          ) : null}
        </div>
      </div>

      <SettingsArrFieldSet legend="Quality profile">
        <IntegrationCard
          title="Default"
          subtitle={`${qualityEnabled.size} qualities allowed`}
          status={{ label: "Configured", className: "is-enabled" }}
          meta={`Cutoff ${(qualityProfile.cutoff !== undefined ? QUALITY_TIER_LABELS[qualityProfile.cutoff] : undefined) || "not set"}`}
          onClick={() => setActiveModal(QUALITY_PROFILE_MODAL)}
        />
      </SettingsArrFieldSet>

      <SettingsArrFieldSet legend="Downloads folder">
        <RootOverlapWarning rootWarnings={settings.rootWarnings} />
        <SettingsArrFormGroup
          label="Path"
          labelFor="download-clients-download-folder"
          help="Stores downloaded music, including flow tracks."
        >
          <DownloadFolderField
            id="download-clients-download-folder"
            value={settings.downloadFolderPath || ""}
            autoApplySuggestion={false}
            onChange={(nextPath: string) =>
              updateSettings({
                ...settings,
                downloadFolderPath: nextPath,
              })
            }
          />
        </SettingsArrFormGroup>
      </SettingsArrFieldSet>

      <SettingsArrFieldSet legend="Review queue">
        <SettingsArrFormGroup
          label="Maximum wait (hours)"
          labelFor="download-clients-review-timeout"
          help="Hours before unreviewed songs are denied and searched again. Set 0 to wait indefinitely."
        >
          <SettingsInput
            id="download-clients-review-timeout"
            type="number"
            min={0}
            max={720}
            step={1}
            value={settings.reviewTimeoutHours ?? 0}
            onChange={(event) => {
              const raw = Number(event.target.value);
              updateSettings({
                ...settings,
                reviewTimeoutHours: Number.isFinite(raw)
                  ? Math.max(0, Math.min(720, Math.floor(raw)))
                  : 0,
              });
            }}
          />
        </SettingsArrFormGroup>
      </SettingsArrFieldSet>

      <SettingsArrFieldSet legend="Remote path mappings">
        <div className="arr-info">
          Map paths only when the download client and Aurral see different locations.
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

      {activeModal === ADD_CLIENT_MODAL ? (
        <SettingsIntegrationModal
          title="Add download client"
          wide={false}
          onClose={() => setActiveModal(null)}
        >
          <div className="download-client-picker">
            <div className="download-client-picker__list">
              {availableClientDefinitions.map((definition) => (
                <button
                  key={definition.key}
                  type="button"
                  className="download-client-picker__option"
                  onClick={() => addClient(definition)}
                >
                  <span className="download-client-picker__copy">
                    <span className="download-client-picker__name">{definition.label}</span>
                    {definition.subtitle ? (
                      <span className="download-client-picker__subtitle">
                        {definition.subtitle}
                      </span>
                    ) : null}
                  </span>
                  <Plus className="artist-icon-sm" aria-hidden />
                </button>
              ))}
            </div>
          </div>
        </SettingsIntegrationModal>
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
            onChange={(patch: Record<string, unknown>) =>
              updateIntegration(activeClient.key, patch)
            }
          />
        </SettingsIntegrationModal>
      ) : null}
    </>
  );
}

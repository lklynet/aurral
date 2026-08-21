import { useEffect, useState } from "react";
import { testNzbgetConnection, testSabnzbdConnection, testSlskdConnection, testYtdlpConnection } from "../../../utils/api/endpoints/settings.js";

import { Plus, RefreshCw, Trash2, Wrench } from "lucide-react";
import { DotLoader } from "../../../components/DotLoader";
import DownloadFolderField from "../../../components/DownloadFolderField";
import { SettingsInput } from "./SettingsField";
import { IntegrationCard, SettingsIntegrationModal } from "./SettingsIntegrationCards";
import {
  SettingsModalField,
  SettingsModalSection,
  SettingsModalToggle,
} from "./SettingsModalLayout";
import { SettingsArrFieldSet, SettingsArrFormGroup } from "./arr/SettingsArrLayout";
import { getProviderStatus } from "../utils/integrationStatus";
import { PATH_MAPPING_SOURCE_OPTIONS, PathMappingModal } from "./PathMappingModal";
import { QUALITY_TIER_LABELS, QualityProfileModal } from "./QualityProfileModal";
const PATH_MAPPING_SOURCE_VALUES = new Set(
  PATH_MAPPING_SOURCE_OPTIONS.map((option) => option.value),
);

function toNumber(value, fallback) {
  const next = parseInt(value, 10);
  return Number.isFinite(next) ? next : fallback;
}

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

const CLIENT_MODALS = {
  qualityProfile: "quality-profile",
  slskd: "slskd",
  ytdlp: "ytdlp",
  nzbget: "nzbget",
  sabnzbd: "sabnzbd",
};

export function SettingsDownloadClientsSection({
  settings,
  updateSettings,
  health,
  handleSaveSettings,
  showSuccess,
  showError,
  showInfo,
}) {
  const [activeModal, setActiveModal] = useState(null);
  const [testingSlskd, setTestingSlskd] = useState(false);
  const [testingYtdlp, setTestingYtdlp] = useState(false);
  const [testingNzbget, setTestingNzbget] = useState(false);
  const [testingSabnzbd, setTestingSabnzbd] = useState(false);
  const [testStatus, setTestStatus] = useState(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [mappingModal, setMappingModal] = useState(null);

  useEffect(() => {
    setTestStatus(null);
  }, [activeModal]);

  const integrations = settings.integrations || {};
  const slskd = integrations.slskd || {};
  const ytdlp = integrations.ytdlp || {};
  const nzbget = integrations.nzbget || {};
  const sabnzbd = integrations.sabnzbd || {};
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

  const slskdConfigured = Boolean(slskd.url && slskd.apiKey);
  const ytdlpConfigured = health?.ytdlpConfigured === true;
  const nzbgetConfigured = Boolean(nzbget.url);
  const sabnzbdConfigured = Boolean(sabnzbd.url && sabnzbd.apiKey);
  const slskdEnabled = slskd.enabled === true;
  const ytdlpEnabled = ytdlp.enabled !== false;
  const nzbgetEnabled = nzbget.enabled === true;
  const sabnzbdEnabled = sabnzbd.enabled === true;

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

  const handleTestNzbget = async () => {
    setTestStatus(null);
    if (!nzbgetEnabled || !nzbget.url) {
      setTestStatus({ tone: "error", message: "Enable NZBGet and enter the server URL." });
      showError("Enable NZBGet and enter the server URL first");
      return;
    }
    setTestingNzbget(true);
    try {
      await handleSaveSettings();
      const result = await testNzbgetConnection();
      setTestStatus({ tone: "success", message: "Connected." });
      showSuccess(result.message || "NZBGet connection OK");
    } catch (error) {
      setTestStatus({ tone: "error", message: "Connection failed. Check the settings and retry." });
      showError(
        error.response?.data?.message ||
          error.response?.data?.error ||
          error.message ||
          "NZBGet connection failed",
      );
    } finally {
      setTestingNzbget(false);
    }
  };

  const handleTestSabnzbd = async () => {
    setTestStatus(null);
    if (!sabnzbdEnabled || !sabnzbd.url || !sabnzbd.apiKey) {
      setTestStatus({ tone: "error", message: "Enable SABnzbd and enter the URL and API key." });
      showError("Enable SABnzbd and enter the server URL and API key first");
      return;
    }
    setTestingSabnzbd(true);
    try {
      await handleSaveSettings();
      const result = await testSabnzbdConnection();
      setTestStatus({ tone: "success", message: "Connected." });
      showSuccess(result.message || "SABnzbd connection OK");
    } catch (error) {
      setTestStatus({ tone: "error", message: "Connection failed. Check the settings and retry." });
      showError(
        error.response?.data?.message ||
          error.response?.data?.error ||
          error.message ||
          "SABnzbd connection failed",
      );
    } finally {
      setTestingSabnzbd(false);
    }
  };

  const handleTestSlskd = async () => {
    setTestStatus(null);
    if (!slskd.url || !slskd.apiKey) {
      setTestStatus({ tone: "error", message: "Enter the slskd URL and API key." });
      showError("Enter slskd URL and API key first");
      return;
    }
    setTestingSlskd(true);
    try {
      await handleSaveSettings();
      const result = await testSlskdConnection();
      if (result.success || result.ok) {
        if (result.warning || result.soulseekConnected === false) {
          setTestStatus({ tone: "warning", message: "API reachable, but Soulseek is not connected." });
          showInfo(result.message || "slskd API is reachable, but Soulseek is not connected");
        } else {
          setTestStatus({ tone: "success", message: "Connected." });
          showSuccess(result.message || "slskd connection OK");
        }
      } else {
        setTestStatus({ tone: "error", message: "Connection failed. Check the settings and retry." });
        showError(result.message || "slskd connection failed");
      }
    } catch (error) {
      setTestStatus({ tone: "error", message: "Connection failed. Check the settings and retry." });
      showError(
        error.response?.data?.message ||
          error.response?.data?.error ||
          error.message ||
          "slskd connection failed",
      );
    } finally {
      setTestingSlskd(false);
    }
  };

  const handleTestYtdlp = async () => {
    setTestStatus(null);
    setTestingYtdlp(true);
    try {
      await handleSaveSettings();
      const result = await testYtdlpConnection();
      setTestStatus({ tone: "success", message: "Connected." });
      showSuccess(result.message || "yt-dlp OK");
    } catch (error) {
      setTestStatus({ tone: "error", message: "Connection failed. Check the settings and retry." });
      showError(
        error.response?.data?.message ||
          error.response?.data?.error ||
          error.message ||
          "yt-dlp test failed",
      );
    } finally {
      setTestingYtdlp(false);
    }
  };

  return (
    <>
      <div className="settings-page__section">
        <div className="settings-page__section-header">
          <div className="settings-page__section-intro">
            <h3 className="settings-page__section-title">Download clients</h3>
          </div>
        </div>
        <div className="settings-page__integration-card-grid">
          <IntegrationCard
            title="slskd"
            subtitle="Soulseek"
            status={getProviderStatus(slskdEnabled, slskdConfigured)}
            meta={`Priority ${slskd.priority ?? 10}`}
            onClick={() => setActiveModal(CLIENT_MODALS.slskd)}
          />
          <IntegrationCard
            title="yt-dlp"
            subtitle="YouTube / web"
            status={getProviderStatus(ytdlpEnabled, ytdlpConfigured)}
            meta={`Priority ${ytdlp.priority ?? 50}`}
            onClick={() => setActiveModal(CLIENT_MODALS.ytdlp)}
          />
          <IntegrationCard
            title="NZBGet"
            subtitle="Usenet"
            status={getProviderStatus(nzbgetEnabled, health?.nzbgetConfigured || nzbgetConfigured)}
            meta={`Priority ${nzbget.priority ?? 20}`}
            onClick={() => setActiveModal(CLIENT_MODALS.nzbget)}
          />
          <IntegrationCard
            title="SABnzbd"
            subtitle="Usenet"
            status={getProviderStatus(sabnzbdEnabled, health?.sabnzbdConfigured || sabnzbdConfigured)}
            meta={`Priority ${sabnzbd.priority ?? 20}`}
            onClick={() => setActiveModal(CLIENT_MODALS.sabnzbd)}
          />
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
          onClick={() => setActiveModal(CLIENT_MODALS.qualityProfile)}
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

      {activeModal === CLIENT_MODALS.qualityProfile && (
        <QualityProfileModal
          profile={{ ...qualityProfile, order: qualityOrder, enabled: [...qualityEnabled] }}
          onChange={updateQualityProfile}
          onClose={() => setActiveModal(null)}
        />
      )}

      {activeModal === CLIENT_MODALS.slskd && (
        <SettingsIntegrationModal
          title="slskd"
          onClose={() => setActiveModal(null)}
          testStatus={testStatus}
          footerActions={
            <button
              type="button"
              className="btn btn-secondary"
              disabled={testingSlskd}
              onClick={handleTestSlskd}
            >
              {testingSlskd ? (
                <DotLoader size="sm" label={null} />
              ) : (
                <RefreshCw className="artist-icon-sm" aria-hidden />
              )}
              {testingSlskd ? "Testing..." : "Test connection"}
            </button>
          }
        >
          <SettingsModalToggle
            label="Enable slskd"
            checked={slskdEnabled}
            onChange={(event) => updateIntegration("slskd", { enabled: event.target.checked })}
          />

          <SettingsModalSection title="Connection">
            <SettingsModalField label="Server URL">
              <SettingsInput
                type="url"
                placeholder="http://localhost:5030"
                autoComplete="off"
                value={slskd.url || ""}
                onChange={(event) => updateIntegration("slskd", { url: event.target.value })}
              />
            </SettingsModalField>
            <SettingsModalField label="API key">
              <SettingsInput
                type="password"
                autoComplete="off"
                value={slskd.apiKey || ""}
                onChange={(event) => updateIntegration("slskd", { apiKey: event.target.value })}
              />
            </SettingsModalField>
          </SettingsModalSection>

          <SettingsModalSection title="Behavior">
            <SettingsModalField label="Source priority">
              <SettingsInput
                type="number"
                min="1"
                max="1000"
                value={slskd.priority ?? 10}
                onChange={(event) =>
                  updateIntegration("slskd", {
                    priority: toNumber(event.target.value, 10),
                  })
                }
              />
            </SettingsModalField>
            <SettingsModalToggle
              label="Clean up after runs"
              checked={slskd.cleanupAfterRuns === true}
              onChange={(event) =>
                updateIntegration("slskd", {
                  cleanupAfterRuns: event.target.checked,
                })
              }
            />
          </SettingsModalSection>
        </SettingsIntegrationModal>
      )}

      {activeModal === CLIENT_MODALS.ytdlp && (
        <SettingsIntegrationModal
          title="yt-dlp"
          onClose={() => setActiveModal(null)}
          testStatus={testStatus}
          footerActions={
            <button
              type="button"
              className="btn btn-secondary"
              disabled={testingYtdlp}
              onClick={handleTestYtdlp}
            >
              {testingYtdlp ? (
                <DotLoader size="sm" label={null} />
              ) : (
                <RefreshCw className="artist-icon-sm" aria-hidden />
              )}
              {testingYtdlp ? "Testing..." : "Test connection"}
            </button>
          }
        >
          <SettingsModalToggle
            label="Enable yt-dlp"
            checked={ytdlpEnabled}
            onChange={(event) => updateIntegration("ytdlp", { enabled: event.target.checked })}
          />

          <SettingsModalSection title="Behavior">
            <SettingsModalField label="Source priority">
              <SettingsInput
                type="number"
                min="1"
                max="1000"
                value={ytdlp.priority ?? 50}
                onChange={(event) =>
                  updateIntegration("ytdlp", {
                    priority: toNumber(event.target.value, 50),
                  })
                }
              />
            </SettingsModalField>
          </SettingsModalSection>

          <SettingsModalSection title="Downloads">
            <SettingsModalField
              label="Staging path"
              htmlFor="ytdlp-staging-path"
              hint="Temporary downloads stay here until imported."
            >
              <DownloadFolderField
                id="ytdlp-staging-path"
                value={ytdlp.stagingPath || ""}
                autoApplySuggestion={false}
                onChange={(nextPath) => updateIntegration("ytdlp", { stagingPath: nextPath })}
              />
            </SettingsModalField>
          </SettingsModalSection>
        </SettingsIntegrationModal>
      )}

      {activeModal === CLIENT_MODALS.nzbget && (
        <SettingsIntegrationModal
          title="NZBGet"
          onClose={() => setActiveModal(null)}
          testStatus={testStatus}
          footerActions={
            <button
              type="button"
              className="btn btn-secondary"
              disabled={testingNzbget}
              onClick={handleTestNzbget}
            >
              {testingNzbget ? (
                <DotLoader size="sm" label={null} />
              ) : (
                <RefreshCw className="artist-icon-sm" aria-hidden />
              )}
              {testingNzbget ? "Testing..." : "Test connection"}
            </button>
          }
        >
          <SettingsModalToggle
            label="Enable NZBGet"
            checked={nzbgetEnabled}
            onChange={(event) => updateIntegration("nzbget", { enabled: event.target.checked })}
          />

          <SettingsModalSection title="Connection">
            <SettingsModalField label="Server URL">
              <SettingsInput
                type="url"
                placeholder="http://localhost:6789"
                autoComplete="off"
                value={nzbget.url || ""}
                onChange={(event) => updateIntegration("nzbget", { url: event.target.value })}
              />
            </SettingsModalField>
            <SettingsModalField label="Username">
              <SettingsInput
                type="text"
                autoComplete="off"
                value={nzbget.username || ""}
                onChange={(event) => updateIntegration("nzbget", { username: event.target.value })}
              />
            </SettingsModalField>
            <SettingsModalField label="Password">
              <SettingsInput
                type="password"
                autoComplete="off"
                value={nzbget.password || ""}
                onChange={(event) => updateIntegration("nzbget", { password: event.target.value })}
              />
            </SettingsModalField>
          </SettingsModalSection>

          <SettingsModalSection title="Downloads">
            <SettingsModalField label="Category">
              <SettingsInput
                type="text"
                value={nzbget.category || "aurral"}
                onChange={(event) => updateIntegration("nzbget", { category: event.target.value })}
              />
            </SettingsModalField>
            <SettingsModalField label="Source priority">
              <SettingsInput
                type="number"
                min="1"
                max="1000"
                value={nzbget.priority ?? 20}
                onChange={(event) =>
                  updateIntegration("nzbget", {
                    priority: toNumber(event.target.value, 20),
                  })
                }
              />
            </SettingsModalField>
          </SettingsModalSection>

          <div className="settings-page__advanced-toggle-row">
            <button
              type="button"
              className="settings-page__advanced-toggle"
              onClick={() => setShowAdvanced((current) => !current)}
            >
              {showAdvanced ? "Hide advanced" : "Show advanced"}
            </button>
          </div>

          {showAdvanced && (
            <SettingsModalSection title="Advanced">
              <SettingsModalField label="NZB priority">
                <SettingsInput
                  type="number"
                  min="-100"
                  max="900"
                  value={nzbget.nzbPriority ?? 0}
                  onChange={(event) =>
                    updateIntegration("nzbget", {
                      nzbPriority: toNumber(event.target.value, 0),
                    })
                  }
                />
              </SettingsModalField>
              <SettingsModalField label="Completed download path">
                <SettingsInput
                  type="text"
                  placeholder="/downloads/completed"
                  autoComplete="off"
                  value={nzbget.completedPath || ""}
                  onChange={(event) =>
                    updateIntegration("nzbget", {
                      completedPath: event.target.value,
                    })
                  }
                />
              </SettingsModalField>
              <SettingsModalToggle
                label="Add NZBs paused"
                checked={nzbget.addPaused === true}
                onChange={(event) =>
                  updateIntegration("nzbget", {
                    addPaused: event.target.checked,
                  })
                }
              />
            </SettingsModalSection>
          )}
        </SettingsIntegrationModal>
      )}

      {activeModal === CLIENT_MODALS.sabnzbd && (
        <SettingsIntegrationModal
          title="SABnzbd"
          onClose={() => setActiveModal(null)}
          testStatus={testStatus}
          footerActions={
            <button
              type="button"
              className="btn btn-secondary"
              disabled={testingSabnzbd}
              onClick={handleTestSabnzbd}
            >
              {testingSabnzbd ? (
                <DotLoader size="sm" label={null} />
              ) : (
                <RefreshCw className="artist-icon-sm" aria-hidden />
              )}
              {testingSabnzbd ? "Testing..." : "Test connection"}
            </button>
          }
        >
          <SettingsModalToggle
            label="Enable SABnzbd"
            checked={sabnzbdEnabled}
            onChange={(event) => updateIntegration("sabnzbd", { enabled: event.target.checked })}
          />

          <SettingsModalSection title="Connection">
            <SettingsModalField label="Server URL">
              <SettingsInput
                type="url"
                placeholder="http://localhost:8080"
                autoComplete="off"
                value={sabnzbd.url || ""}
                onChange={(event) => updateIntegration("sabnzbd", { url: event.target.value })}
              />
            </SettingsModalField>
            <SettingsModalField label="API key">
              <SettingsInput
                type="password"
                autoComplete="off"
                value={sabnzbd.apiKey || ""}
                onChange={(event) => updateIntegration("sabnzbd", { apiKey: event.target.value })}
              />
            </SettingsModalField>
          </SettingsModalSection>

          <SettingsModalSection title="Downloads">
            <SettingsModalField label="Category">
              <SettingsInput
                type="text"
                value={sabnzbd.category || "aurral"}
                onChange={(event) => updateIntegration("sabnzbd", { category: event.target.value })}
              />
            </SettingsModalField>
            <SettingsModalField label="Source priority">
              <SettingsInput
                type="number"
                min="1"
                max="1000"
                value={sabnzbd.priority ?? 20}
                onChange={(event) =>
                  updateIntegration("sabnzbd", {
                    priority: toNumber(event.target.value, 20),
                  })
                }
              />
            </SettingsModalField>
          </SettingsModalSection>

          <div className="settings-page__advanced-toggle-row">
            <button
              type="button"
              className="settings-page__advanced-toggle"
              onClick={() => setShowAdvanced((current) => !current)}
            >
              {showAdvanced ? "Hide advanced" : "Show advanced"}
            </button>
          </div>

          {showAdvanced && (
            <SettingsModalSection title="Advanced">
              <SettingsModalToggle
                label="Add NZBs paused"
                checked={sabnzbd.addPaused === true}
                onChange={(event) =>
                  updateIntegration("sabnzbd", {
                    addPaused: event.target.checked,
                  })
                }
              />
            </SettingsModalSection>
          )}
        </SettingsIntegrationModal>
      )}
    </>
  );
}

import { CheckCircle } from "lucide-react";
import FlipSaveButton from "../../../components/FlipSaveButton";
import { DEFAULT_METADATA_BASE_URL, DEFAULT_SEARCH_URL } from "../utils";
import { SettingsInput } from "./SettingsField";

export function SettingsMetadataTab({
  settings,
  updateSettings,
  health,
  hasUnsavedChanges,
  saving,
  handleSaveSettings,
}) {
  return (
    <div className="settings-page__panel">
      <div className="settings-page__panel-header">
        <h2 className="settings-page__panel-title">Metadata Services</h2>
        <FlipSaveButton
          saving={saving}
          disabled={!hasUnsavedChanges}
          onClick={handleSaveSettings}
        />
      </div>
      <form
        onSubmit={handleSaveSettings}
        className="settings-page__form"
        autoComplete="off"
      >
        <div className="settings-page__section">
          <div className="settings-page__section-header">
            <h3 className="settings-page__section-title">Metadata Server</h3>
            {health?.metadataConfigured && (
              <span className="settings-page__status">
                <CheckCircle className="settings-page__status-icon" />
                Configured
              </span>
            )}
          </div>
          <div className="settings-page__fields">
            <div className="settings-page__field">
              <label className="artist-field-label" htmlFor="metadata-base-url">
                Base URL
              </label>
              <SettingsInput
                id="metadata-base-url"
                type="url"
                placeholder={DEFAULT_METADATA_BASE_URL}
                autoComplete="off"
                value={settings.integrations?.metadata?.baseUrl || ""}
                onChange={(e) =>
                  updateSettings({
                    ...settings,
                    integrations: {
                      ...settings.integrations,
                      metadata: {
                        ...(settings.integrations?.metadata || {}),
                        provider: "brainzmash",
                        baseUrl: e.target.value,
                      },
                    },
                  })
                }
              />
            </div>
          </div>
        </div>

        <div className="settings-page__section">
          <div className="settings-page__section-header">
            <h3 className="settings-page__section-title">Search Server</h3>
            {health?.searchConfigured && (
              <span className="settings-page__status">
                <CheckCircle className="settings-page__status-icon" />
                Configured
              </span>
            )}
          </div>
          <div className="settings-page__fields">
            <div className="settings-page__field">
              <label className="artist-field-label" htmlFor="search-base-url">
                Base URL
              </label>
              <SettingsInput
                id="search-base-url"
                type="url"
                placeholder={DEFAULT_SEARCH_URL}
                autoComplete="off"
                value={settings.integrations?.search?.url || ""}
                onChange={(e) =>
                  updateSettings({
                    ...settings,
                    integrations: {
                      ...settings.integrations,
                      search: {
                        ...(settings.integrations?.search || {}),
                        url: e.target.value,
                      },
                    },
                  })
                }
              />
            </div>
            <div className="settings-page__field">
              <label className="artist-field-label" htmlFor="search-api-key">
                API Key
              </label>
              <SettingsInput
                id="search-api-key"
                type="password"
                placeholder="Optional"
                autoComplete="new-password"
                value={settings.integrations?.search?.apiKey || ""}
                onChange={(e) =>
                  updateSettings({
                    ...settings,
                    integrations: {
                      ...settings.integrations,
                      search: {
                        ...(settings.integrations?.search || {}),
                        apiKey: e.target.value,
                      },
                    },
                  })
                }
              />
            </div>
          </div>
        </div>
      </form>
    </div>
  );
}

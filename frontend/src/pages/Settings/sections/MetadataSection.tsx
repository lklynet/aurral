import { SettingsInput } from "../components/SettingsField";
import { useServerSettings } from "../SettingsProviders";
import { DEFAULT_METADATA_BASE_URL } from "../utils";
import { SettingsGroup, SettingsPage, SettingsRow } from "../SettingsLayout";

export function MetadataSection() {
  const { settings, updateSettings, health } = useServerSettings();
  const { metadata } = settings.integrations;

  return (
    <SettingsPage title="Metadata">
      <SettingsGroup title="Metadata server">
        <SettingsRow
          label="Base URL"
          htmlFor="metadata-base-url"
          help={health?.metadataConfigured ? "Connected." : null}
        >
          <SettingsInput
            id="metadata-base-url"
            type="url"
            placeholder={DEFAULT_METADATA_BASE_URL}
            autoComplete="off"
            value={metadata.baseUrl || ""}
            onChange={(event) =>
              updateSettings({
                ...settings,
                integrations: {
                  ...settings.integrations,
                  metadata: { ...metadata, provider: "brainzmash", baseUrl: event.target.value },
                },
              })
            }
          />
        </SettingsRow>
      </SettingsGroup>
    </SettingsPage>
  );
}

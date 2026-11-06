import { parseResponse } from "hono/client";
import { authClient } from "../../../utils/api/clients/auth.ts";
import { setDateTimeFormat } from "../../../utils/dateTime.ts";
import { queryKeys } from "../../../queryClient.ts";
import { Select } from "../../../components/Select";
import { useServerSettings } from "../SettingsProviders";
import { SettingsGroup, SettingsPage, SettingsRow } from "../SettingsLayout";
import { ApiKeyRow } from "../components/ApiKeyRow";
import { BackupGroup } from "./BackupGroup";

export function GeneralSection() {
  const { settings, updateSettings } = useServerSettings();

  return (
    <SettingsPage title="General">
      <SettingsGroup title="Display">
        <SettingsRow
          label="Date and time format"
          htmlFor="date-time-format"
          help="Applies to all users."
        >
          <Select
            id="date-time-format"
            value={settings.dateTimeFormat}
            onChange={(dateTimeFormat) => {
              setDateTimeFormat(dateTimeFormat);
              updateSettings({ ...settings, dateTimeFormat });
            }}
            options={[
              { value: "browser", label: "Browser default" },
              { value: "day-first", label: "14:30 09/08/2026" },
              { value: "year-first", label: "2026/08/09 14:30" },
            ]}
          />
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup title="API access">
        <ApiKeyRow
          queryKey={queryKeys.apiKey}
          load={(signal) => parseResponse(authClient["api-key"].$get({}, { init: { signal } }))}
          rotate={() => parseResponse(authClient["api-key"].rotate.$post())}
          help={
            <>
              Gives admin access. Send it as an <code>X-Api-Key</code> header or{" "}
              <code>api_key</code> query parameter.
            </>
          }
        />
      </SettingsGroup>
      <BackupGroup />
    </SettingsPage>
  );
}

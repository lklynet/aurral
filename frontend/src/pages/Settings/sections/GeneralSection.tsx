import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { Check, Copy } from "../../../components/icons";
import { DotLoader } from "../../../components/DotLoader";
import PillToggle from "../../../components/PillToggle";
import TooltipButton from "../../../components/TooltipButton";
import { authClient } from "../../../utils/api/clients/auth.ts";
import { setDateTimeFormat } from "../../../utils/dateTime.ts";
import { queryKeys } from "../../../queryClient.ts";
import { SettingsSelect } from "../components/SettingsField";
import { useServerSettings } from "../SettingsProviders";
import { SettingsGroup, SettingsNote, SettingsPage, SettingsRow } from "../SettingsLayout";

const COPY_FAILED = "Could not copy the API key. Select it and copy manually.";

function ApiKeyRow() {
  const { showSuccess, showError } = useServerSettings();
  const queryClient = useQueryClient();
  const apiKeyQuery = useQuery({
    queryKey: queryKeys.apiKey,
    queryFn: async ({ signal }) =>
      (await parseResponse(authClient["api-key"].$get({}, { init: { signal } }))).apiKey || null,
  });
  const apiKey = apiKeyQuery.data ?? null;
  const [rotating, setRotating] = useState(false);
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    if (!apiKey) return;
    if (!navigator.clipboard?.writeText) {
      showError(COPY_FAILED);
      return;
    }
    try {
      await navigator.clipboard.writeText(apiKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      showError(COPY_FAILED);
    }
  };

  const rotate = async () => {
    if (!window.confirm("Rotate the API key? Apps using the current key stop working.")) return;
    setRotating(true);
    try {
      const res = await parseResponse(authClient["api-key"].rotate.$post());
      queryClient.setQueryData(queryKeys.apiKey, res.apiKey || null);
      showSuccess("API key rotated");
    } catch {
      showError("Failed to rotate API key");
    } finally {
      setRotating(false);
    }
  };

  return (
    <SettingsRow
      label="API key"
      help={
        <>
          Send it as an <code>X-Api-Key</code> header or <code>api_key</code> query parameter. Keep
          it private.
        </>
      }
      stack
    >
      {apiKeyQuery.isPending ? (
        <p className="settings-loading">
          <DotLoader size="sm" label={null} /> Loading…
        </p>
      ) : apiKey ? (
        <>
          <code className="settings-code">{apiKey}</code>
          <TooltipButton
            label={copied ? "Copied" : "Copy API key"}
            className="btn btn-ghost btn-icon btn-sm"
            onClick={copy}
          >
            {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          </TooltipButton>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={rotate}
            disabled={rotating}
          >
            {rotating ? <DotLoader size="xs" label={null} /> : null}
            Rotate
          </button>
        </>
      ) : (
        <SettingsNote tone="error">Couldn&apos;t load the API key.</SettingsNote>
      )}
    </SettingsRow>
  );
}

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
          <SettingsSelect
            id="date-time-format"
            value={settings.dateTimeFormat}
            onChange={(event) => {
              const dateTimeFormat = event.target.value;
              setDateTimeFormat(dateTimeFormat);
              updateSettings({ ...settings, dateTimeFormat });
            }}
          >
            <option value="browser">Browser default</option>
            <option value="day-first">14:30 09/08/2026</option>
            <option value="year-first">2026/08/09 14:30</option>
          </SettingsSelect>
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup title="Subsonic">
        <SettingsRow
          label="Favorite flow tracks"
          htmlFor="subsonic-favorite-auto-keep"
          help="Adds flow tracks to the Library when favorited in a Subsonic client."
        >
          <PillToggle
            id="subsonic-favorite-auto-keep"
            checked={settings.subsonic?.favoriteAutoKeep !== false}
            onChange={(event) =>
              updateSettings({
                ...settings,
                subsonic: { ...settings.subsonic, favoriteAutoKeep: event.target.checked },
              })
            }
            aria-label="Keep flow tracks when favorited through Subsonic"
          />
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup title="API access">
        <ApiKeyRow />
      </SettingsGroup>
    </SettingsPage>
  );
}

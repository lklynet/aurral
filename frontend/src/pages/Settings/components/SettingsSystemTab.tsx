import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Check, Copy, RotateCcw } from "../../../components/icons";
import { DotLoader } from "../../../components/DotLoader";
import { parseResponse } from "hono/client";
import { authClient } from "../../../utils/api/clients/auth.ts";
import { SettingsSystemSection } from "./SettingsStorageSection";
import { SettingsSelect } from "./SettingsField";
import PillToggle from "../../../components/PillToggle";
import { setDateTimeFormat } from "../../../utils/dateTime.ts";
import Tooltip from "../../../components/Tooltip";
import { queryKeys } from "../../../queryClient.ts";
import type { HealthResponse } from "../../../utils/appHealth.ts";
import type { SettingsState } from "../utils";
import type { useToast } from "../../../contexts/ToastContext";

type Toast = ReturnType<typeof useToast>["showSuccess"];

export function SettingsSystemTab({
  health,
  settings,
  updateSettings,
  showSuccess,
  showError,
}: {
  health: HealthResponse | null;
  settings: SettingsState;
  updateSettings: (settings: SettingsState) => void;
  showSuccess: Toast;
  showError: Toast;
}) {
  const queryClient = useQueryClient();
  const apiKeyQuery = useQuery({
    queryKey: queryKeys.apiKey,
    queryFn: async ({ signal }) =>
      (await parseResponse(authClient["api-key"].$get({}, { init: { signal } }))).apiKey || null,
  });
  const apiKey = apiKeyQuery.data ?? null;
  const loading = apiKeyQuery.isPending;
  const [rotating, setRotating] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    if (!apiKey) return;
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      showError("Could not copy the API key. Select it and copy manually.");
      return;
    }
    try {
      await navigator.clipboard.writeText(apiKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      showError("Could not copy the API key. Select it and copy manually.");
    }
  };

  const handleRotate = async () => {
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
    <div className="arr-page settings-system">
      <SettingsSystemSection health={health} />

      <section className="settings-system__section">
        <div className="settings-system__section-header">
          <h2 className="settings-system__section-title">Display</h2>
        </div>
        <div className="settings-system__rows">
          <div className="settings-system__row">
            <div className="settings-system__copy">
              <label className="settings-system__label" htmlFor="date-time-format">
                Date and time format
              </label>
              <p className="settings-system__description">Applies to all users.</p>
            </div>
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
          </div>
        </div>
      </section>

      <section className="settings-system__section">
        <div className="settings-system__section-header">
          <h2 className="settings-system__section-title">Subsonic</h2>
        </div>
        <div className="settings-system__rows">
          <div className="settings-system__row">
            <div className="settings-system__copy">
              <label className="settings-system__label" htmlFor="subsonic-favorite-auto-keep">
                Favorite flow tracks
              </label>
              <p className="settings-system__description">
                Adds flow tracks to the Library when favorited in a Subsonic client.
              </p>
            </div>
            <div className="settings-system__value">
              <PillToggle
                id="subsonic-favorite-auto-keep"
                checked={settings.subsonic?.favoriteAutoKeep !== false}
                onChange={(event) =>
                  updateSettings({
                    ...settings,
                    subsonic: {
                      ...(settings.subsonic || {}),
                      favoriteAutoKeep: event.target.checked,
                    },
                  })
                }
                aria-label="Keep flow tracks when favorited through Subsonic"
              />
            </div>
          </div>
        </div>
      </section>

      <section className="settings-system__section settings-system__api-section">
        <div className="settings-system__section-header">
          <h2 className="settings-system__section-title">API access</h2>
          <p className="settings-system__section-description">
            Authenticate requests with an <code>X-Api-Key</code> header or <code>api_key</code>{" "}
            query parameter.
          </p>
        </div>
        <div className="settings-system__rows">
          {loading ? (
            <div className="settings-system__row">
              <div className="settings-system__copy">
                <div className="settings-system__label">API key</div>
              </div>
              <div className="settings-system__value">
                <DotLoader size="sm" label={null} /> Loading…
              </div>
            </div>
          ) : apiKey ? (
            <div className="settings-system__row">
              <div className="settings-system__copy">
                <div className="settings-system__label">API key</div>
                <p className="settings-system__description">Keep this key private.</p>
              </div>
              <div className="settings-system__api-value">
                <Tooltip content="API key">
                  <code className="settings-system__api-key">{apiKey}</code>
                </Tooltip>
                <Tooltip content={copied ? "Copied" : "Copy to clipboard"}>
                  <button
                    type="button"
                    className="arr-btn arr-btn--ghost arr-btn--icon"
                    onClick={handleCopy}
                    aria-label={copied ? "Copied" : "Copy API key"}
                  >
                    {copied ? (
                      <Check className="artist-icon-xs" />
                    ) : (
                      <Copy className="artist-icon-xs" />
                    )}
                  </button>
                </Tooltip>
                <Tooltip content="Rotate API key">
                  <button
                    type="button"
                    className="arr-btn arr-btn--ghost arr-btn--icon"
                    onClick={handleRotate}
                    disabled={rotating}
                    aria-label="Rotate API key"
                  >
                    {rotating ? (
                      <DotLoader size="xs" label={null} />
                    ) : (
                      <RotateCcw className="artist-icon-xs" aria-hidden />
                    )}
                  </button>
                </Tooltip>
              </div>
            </div>
          ) : (
            <div className="settings-system__row">
              <div className="settings-system__copy">
                <div className="settings-system__label">API key</div>
              </div>
              <div className="settings-system__value settings-system__value--error">
                <AlertCircle className="artist-icon-xs" aria-hidden />
                Unable to load API key
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

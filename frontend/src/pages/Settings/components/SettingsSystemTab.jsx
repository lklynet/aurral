import { useCallback, useEffect, useState } from "react";
import { AlertCircle, Check, Copy, RotateCcw } from "lucide-react";
import { getApiKey, rotateApiKey } from "../../../utils/api/endpoints/auth";
import { SettingsSystemSection } from "./SettingsStorageSection";
import { SettingsSelect } from "./SettingsField";
import PillToggle from "../../../components/PillToggle";
import { setDateTimeFormat } from "../../../utils/dateTime.js";

export function SettingsSystemTab({ health, settings, updateSettings, showSuccess, showError }) {
  const [apiKey, setApiKey] = useState(null);
  const [loading, setLoading] = useState(true);
  const [rotating, setRotating] = useState(false);
  const [copied, setCopied] = useState(false);

  const fetchKey = useCallback(async () => {
    try {
      const res = await getApiKey();
      setApiKey(res?.apiKey || null);
    } catch {
      setApiKey(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchKey();
  }, [fetchKey]);

  const handleCopy = async () => {
    if (!apiKey) return;
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      showError("Failed to copy API key. Select the key and copy it manually.");
      return;
    }
    try {
      await navigator.clipboard.writeText(apiKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      showError("Failed to copy API key. Select the key and copy it manually.");
    }
  };

  const handleRotate = async () => {
    setRotating(true);
    try {
      const res = await rotateApiKey();
      setApiKey(res?.apiKey || null);
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
              <p className="settings-system__description">
                Set the date and 24-hour time order for all users.
              </p>
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
                Favorite Flow tracks
              </label>
              <p className="settings-system__description">
                Keep a Flow track in the permanent Library when a Subsonic client favorites it.
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
                aria-label="Keep Flow tracks when favorited through Subsonic"
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
              <div className="settings-system__value">Loading…</div>
            </div>
          ) : apiKey ? (
            <div className="settings-system__row">
              <div className="settings-system__copy">
                <div className="settings-system__label">API key</div>
                <p className="settings-system__description">Keep this key private.</p>
              </div>
              <div className="settings-system__api-value">
                <code className="settings-system__api-key" title="API key">
                  {apiKey}
                </code>
                <button
                  type="button"
                  className="arr-btn arr-btn--ghost arr-btn--icon"
                  onClick={handleCopy}
                  title={copied ? "Copied" : "Copy to clipboard"}
                  aria-label={copied ? "Copied" : "Copy API key"}
                >
                  {copied ? (
                    <Check className="artist-icon-xs" />
                  ) : (
                    <Copy className="artist-icon-xs" />
                  )}
                </button>
                <button
                  type="button"
                  className="arr-btn arr-btn--ghost arr-btn--icon"
                  onClick={handleRotate}
                  disabled={rotating}
                  title="Rotate API key"
                  aria-label="Rotate API key"
                >
                  <RotateCcw
                    className={"artist-icon-xs" + (rotating ? " animate-spin" : "")}
                  />
                </button>
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

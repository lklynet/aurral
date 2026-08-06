import { useCallback, useEffect, useState } from "react";
import { AlertCircle, Check, Copy, RotateCcw } from "lucide-react";
import { getApiKey, rotateApiKey } from "../../../utils/api/endpoints/auth";
import { SettingsSystemSection } from "./SettingsStorageSection";

export function SettingsSystemTab({ health, showSuccess, showError }) {
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

  const handleCopy = () => {
    if (!apiKey) return;
    navigator.clipboard.writeText(apiKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
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

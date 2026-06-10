import { useState, useRef } from "react";
import { CheckCircle, Plus, Trash2, GripVertical } from "lucide-react";
import FlipSaveButton from "../../../components/FlipSaveButton";
import { SettingsInput, SettingsTextarea } from "./SettingsField";
import PillToggle from "../../../components/PillToggle";
import { testGotifyConnection } from "../../../utils/api";

export function SettingsNotificationsTab({
  settings,
  updateSettings,
  hasUnsavedChanges,
  saving,
  handleSaveSettings,
  testingGotify,
  setTestingGotify,
  showSuccess,
  showError,
}) {
  const handleTestGotify = async () => {
    const url = settings.integrations?.gotify?.url;
    const token = settings.integrations?.gotify?.token;
    if (!url || !token) {
      showError("Enter Gotify URL and token first");
      return;
    }
    setTestingGotify(true);
    try {
      await testGotifyConnection(url, token);
      showSuccess("Test notification sent.");
    } catch (err) {
      const msg =
        err.response?.data?.message ||
        err.response?.data?.error ||
        err.message;
      showError(`Gotify test failed: ${msg}`);
    } finally {
      setTestingGotify(false);
    }
  };

  const webhooks = settings.integrations?.webhooks || [];

  const updateWebhooks = (newWebhooks) => {
    updateSettings({
      ...settings,
      integrations: {
        ...settings.integrations,
        webhooks: newWebhooks,
      },
    });
  };

  const [dragIdx, setDragIdx] = useState(null);
  const allowDragRef = useRef(null);

  const addWebhook = () => {
    if (webhooks.length >= 5) return;
    updateWebhooks([...webhooks, { url: "", body: null, headers: [] }]);
  };

  const removeWebhook = (index) => {
    updateWebhooks(webhooks.filter((_, i) => i !== index));
  };

  const moveWebhook = (from, to) => {
    const next = [...webhooks];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    updateWebhooks(next);
  };

  const updateWebhook = (index, patch) => {
    updateWebhooks(
      webhooks.map((wh, i) => (i === index ? { ...wh, ...patch } : wh)),
    );
  };

  const webhookEvents = settings.integrations?.webhookEvents || {};
  const updateWebhookEvents = (patch) => {
    updateSettings({
      ...settings,
      integrations: {
        ...settings.integrations,
        webhookEvents: { ...webhookEvents, ...patch },
      },
    });
  };

  const addHeader = (whIndex) => {
    const wh = webhooks[whIndex];
    if ((wh.headers || []).length >= 10) return;
    updateWebhook(whIndex, { headers: [...(wh.headers || []), { key: "", value: "" }] });
  };

  const removeHeader = (whIndex, hIndex) => {
    const wh = webhooks[whIndex];
    updateWebhook(whIndex, { headers: (wh.headers || []).filter((_, i) => i !== hIndex) });
  };

  const updateHeader = (whIndex, hIndex, patch) => {
    const wh = webhooks[whIndex];
    updateWebhook(whIndex, {
      headers: (wh.headers || []).map((h, i) => (i === hIndex ? { ...h, ...patch } : h)),
    });
  };

  const handleSave = (e) => {
    const cleanedWebhooks = webhooks.map((wh) => ({
      ...wh,
      headers: (wh.headers || []).filter(
        (h) => (h.key || "").trim() && (h.value || "").trim(),
      ),
    }));
    const settingsToSave = {
      ...settings,
      integrations: {
        ...settings.integrations,
        webhooks: cleanedWebhooks,
      },
    };
    updateWebhooks(cleanedWebhooks);
    handleSaveSettings(e, settingsToSave);
  };

  return (
    <div className="settings-page__panel">
      <div className="settings-page__panel-header">
        <h2
          className="settings-page__panel-title">
          Notifications
        </h2>
        <FlipSaveButton
          saving={saving}
          disabled={!hasUnsavedChanges}
          onClick={handleSave}
        />
      </div>
      <form
        onSubmit={handleSave}
        className="settings-page__form"
        autoComplete="off"
      >
        <div
          className="settings-page__section"
        >
          <div className="settings-page__section-header">
            <h3
              className="settings-page__section-title">
              Gotify
            </h3>
            <div className="settings-page__inline-row">
              {settings.integrations?.gotify?.url &&
                settings.integrations?.gotify?.token && (
                  <span className="settings-page__status">
                    <CheckCircle className="settings-page__status-icon" />
                    Configured
                  </span>
                )}
            </div>
          </div>
          <fieldset className="settings-page__fields">
            <div>
              <label
                className="artist-field-label"
              >
                Server URL
              </label>
              <SettingsInput type="url"

                placeholder="https://gotify.example.com"
                autoComplete="off"
                value={settings.integrations?.gotify?.url || ""}
                onChange={(e) =>
                  updateSettings({
                    ...settings,
                    integrations: {
                      ...settings.integrations,
                      gotify: {
                        ...(settings.integrations?.gotify || {}),
                        url: e.target.value,
                      },
                    },
                  })
                }
              />
            </div>
            <div>
              <label
                className="artist-field-label"
              >
                Application Token
              </label>
                <div className="settings-page__field-row">
                <SettingsInput
                  wrapperClassName="settings-page__field-grow"
                  type="password"
                  placeholder="Gotify app token"
                  autoComplete="off"
                  value={settings.integrations?.gotify?.token || ""}
                  onChange={(e) =>
                    updateSettings({
                      ...settings,
                      integrations: {
                        ...settings.integrations,
                        gotify: {
                          ...(settings.integrations?.gotify || {}),
                          token: e.target.value,
                        },
                      },
                    })
                  }
                />
                <button
                  type="button"
                  onClick={handleTestGotify}
                  disabled={
                    testingGotify ||
                    !settings.integrations?.gotify?.url ||
                    !settings.integrations?.gotify?.token
                  }
                  className="btn btn-secondary"
                >
                  {testingGotify ? "Sending..." : "Test"}
                </button>
              </div>
              <p className="settings-page__hint">
                Create an application in Gotify to get a token.
              </p>
            </div>
            <div className="settings-page__split settings-page__fields">
              <div className="settings-page__inline-row settings-page__inline-row--between">
                <span
                  className="artist-field-label">
                  Notify when daily Discover is updated
                </span>
                <PillToggle
                  checked={
                    settings.integrations?.gotify?.notifyDiscoveryUpdated ||
                    false
                  }
                  onChange={(e) =>
                    updateSettings({
                      ...settings,
                      integrations: {
                        ...settings.integrations,
                        gotify: {
                          ...(settings.integrations?.gotify || {}),
                          notifyDiscoveryUpdated: e.target.checked,
                        },
                      },
                    })
                  }
                />
              </div>
              <div className="settings-page__inline-row settings-page__inline-row--between">
                <span
                  className="artist-field-label">
                  Notify when weekly flow finishes
                </span>
                <PillToggle
                  checked={
                    settings.integrations?.gotify?.notifyWeeklyFlowDone || false
                  }
                  onChange={(e) =>
                    updateSettings({
                      ...settings,
                      integrations: {
                        ...settings.integrations,
                        gotify: {
                          ...(settings.integrations?.gotify || {}),
                          notifyWeeklyFlowDone: e.target.checked,
                        },
                      },
                    })
                  }
                />
              </div>
            </div>
          </fieldset>
        </div>

        <div
          className="settings-page__section"
        >
          <div className="settings-page__section-header">
            <h3
              className="settings-page__section-title">
              Webhooks
            </h3>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={addWebhook}
              disabled={webhooks.length >= 5}
            >
              <Plus className="artist-icon-xs" />
              Add Webhook
            </button>
          </div>

          {!webhooks.length && (
            <p className="settings-page__muted-copy">
              No webhooks configured. Click &ldquo;Add Webhook&rdquo; to create one.
            </p>
          )}

          <div className="settings-page__fields">
            {webhooks.map((wh, index) => (
              <div
                key={index}
                draggable
                onDragStart={(e) => {
                  if (allowDragRef.current !== index) { e.preventDefault(); return; }
                  setDragIdx(index);
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  if (dragIdx !== null && dragIdx !== index) {
                    moveWebhook(dragIdx, index);
                    setDragIdx(index);
                  }
                }}
                onDragEnd={() => {
                  setDragIdx(null);
                  allowDragRef.current = null;
                }}
                className={`settings-page__webhook-card${dragIdx === index ? " is-dragging" : ""}`}
              >
                <div className="settings-page__webhook-header">
                  <div className="settings-page__webhook-title">
                    <GripVertical
                      className="settings-page__drag-handle artist-icon-xs"
                      onMouseDown={() => { allowDragRef.current = index; }}
                      onMouseUp={() => { allowDragRef.current = null; }}
                    />
                    <span>Webhook #{index + 1}</span>
                  </div>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost-danger"
                    onClick={() => removeWebhook(index)}
                    aria-label="Remove webhook"
                  >
                    <Trash2 className="artist-icon-xs" />
                  </button>
                </div>
                <div>
                  <label className="artist-field-label">
                    URL
                  </label>
                  <SettingsInput type="url"

                    placeholder="https://example.com/webhook"
                    value={wh.url || ""}
                    onChange={(e) => updateWebhook(index, { url: e.target.value })}
                  />
                </div>
                <div>
                  <div className="settings-page__section-header">
                    <label className="artist-field-label">
                      Body
                      {wh.body !== null && (
                        <span className="settings-page__hint-inline">
                          POST — variables: <code>$flowPath</code>, <code>$flowName</code>
                        </span>
                      )}
                    </label>
                    {wh.body === null ? (
                      <button
                        type="button"
                        className="btn btn-secondary settings-page__btn--compact"
                        onClick={() => updateWebhook(index, { body: "" })}
                      >
                        <Plus />
                        Add Body
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost-danger"
                        onClick={() => updateWebhook(index, { body: null })}
                      >
                        Remove
                      </button>
                    )}
                  </div>
                  {wh.body !== null && (
                    <SettingsTextarea
                      rows={3}
                      maxLength={1000}
                      value={wh.body || ""}
                      onChange={(e) => updateWebhook(index, { body: e.target.value })}
                      spellCheck={false}
                      autoComplete="off"
                      autoCorrect="off"
                      autoCapitalize="off"
                    />
                  )}
                </div>
                <div>
                  <div className="settings-page__section-header">
                    <label className="artist-field-label">
                      Headers
                    </label>
                    <button
                      type="button"
                      className="btn btn-secondary settings-page__btn--compact"
                      onClick={() => addHeader(index)}
                      disabled={(wh.headers || []).length >= 10}
                    >
                      <Plus />
                      Add Header
                    </button>
                  </div>
                  {(wh.headers || []).length > 0 && (
                    <div className="settings-page__field-stack--md">
                      {(wh.headers || []).map((header, hIndex) => (
                        <div key={hIndex} className="settings-page__header-fields-row">
                          <SettingsInput
                            wrapperClassName="settings-page__field-grow"
                            className="settings-page__mono-input"
                            placeholder="Header-Name"
                            spellCheck={false}
                            value={header.key || ""}
                            onChange={(e) => updateHeader(index, hIndex, { key: e.target.value })}
                          />
                          <SettingsInput
                            wrapperClassName="settings-page__field-grow"
                            className="settings-page__mono-input"
                            placeholder="value"
                            spellCheck={false}
                            value={header.value || ""}
                            onChange={(e) => updateHeader(index, hIndex, { value: e.target.value })}
                          />
                          <button
                            type="button"
                            className="btn btn-sm btn-ghost-danger"
                            onClick={() => removeHeader(index, hIndex)}
                            aria-label="Remove header"
                          >
                            <Trash2 className="artist-icon-xs" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>

          <div className="settings-page__split settings-page__fields">
            <div className="settings-page__inline-row settings-page__inline-row--between">
              <span className="artist-field-label">
                Notify when daily Discover is updated
              </span>
              <PillToggle
                checked={webhookEvents.notifyDiscoveryUpdated || false}
                onChange={(e) => updateWebhookEvents({ notifyDiscoveryUpdated: e.target.checked })}
              />
            </div>
            <div className="settings-page__inline-row settings-page__inline-row--between">
              <span className="artist-field-label">
                Notify when weekly flow finishes
              </span>
              <PillToggle
                checked={webhookEvents.notifyWeeklyFlowDone || false}
                onChange={(e) => updateWebhookEvents({ notifyWeeklyFlowDone: e.target.checked })}
              />
            </div>
          </div>
        </div>
      </form>
    </div>
  );
}

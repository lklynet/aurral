import { useState, useRef } from "react";
import { CheckCircle, Pencil, Plus, Trash2, GripVertical } from "lucide-react";
import FlipSaveButton from "../../../components/FlipSaveButton";
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
  const [gotifyEditing, setGotifyEditing] = useState(false);

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

  const codeInputStyle = { background: "#171515", color: "#c1c1c3", borderColor: "#2a2a2e" };

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
    <div className="card animate-fade-in">
      <div className="flex items-center justify-between mb-6">
        <h2
          className="text-2xl font-bold flex items-center"
          style={{ color: "#fff" }}
        >
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
        className="space-y-6"
        autoComplete="off"
      >
        <div
          className="p-6 rounded-lg space-y-4"
          style={{
            backgroundColor: "#1a1a1e",
            border: "1px solid #2a2a2e",
          }}
        >
          <div className="flex items-center justify-between mb-2">
            <h3
              className="text-lg font-medium flex items-center"
              style={{ color: "#fff" }}
            >
              Gotify
            </h3>
            <div className="flex items-center gap-2">
              {settings.integrations?.gotify?.url &&
                settings.integrations?.gotify?.token && (
                  <span className="flex items-center text-sm text-green-400">
                    <CheckCircle className="w-4 h-4 mr-1" />
                    Configured
                  </span>
                )}
              <button
                type="button"
                className={`btn ${
                  gotifyEditing ? "btn-primary" : "btn-secondary"
                } px-2 py-1`}
                onClick={() => setGotifyEditing((value) => !value)}
                aria-label={
                  gotifyEditing ? "Lock Gotify settings" : "Edit Gotify settings"
                }
              >
                <Pencil className="w-4 h-4" />
              </button>
            </div>
          </div>
          <fieldset
            disabled={!gotifyEditing}
            className={`grid grid-cols-1 gap-4 ${
              gotifyEditing ? "" : "opacity-60"
            }`}
          >
            <div>
              <label
                className="block text-sm font-medium mb-1"
                style={{ color: "#fff" }}
              >
                Server URL
              </label>
              <input
                type="url"
                className="input"
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
                className="block text-sm font-medium mb-1"
                style={{ color: "#fff" }}
              >
                Application Token
              </label>
              <div className="flex gap-2">
                <input
                  type="password"
                  className="input flex-1"
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
              <p className="mt-1 text-xs" style={{ color: "#c1c1c3" }}>
                Create an application in Gotify to get a token.
              </p>
            </div>
            <div
              className="pt-4 border-t space-y-4"
              style={{ borderColor: "#2a2a2e" }}
            >
              <div className="flex items-center justify-between">
                <span
                  className="text-sm font-medium"
                  style={{ color: "#fff" }}
                >
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
              <div className="flex items-center justify-between">
                <span
                  className="text-sm font-medium"
                  style={{ color: "#fff" }}
                >
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
          className="p-6 rounded-lg space-y-4"
          style={{
            backgroundColor: "#1a1a1e",
            border: "1px solid #2a2a2e",
          }}
        >
          <div className="flex items-center justify-between mb-2">
            <h3
              className="text-lg font-medium"
              style={{ color: "#fff" }}
            >
              Webhooks
            </h3>
            <button
              type="button"
              className="btn btn-secondary flex items-center gap-1 px-3 py-1"
              onClick={addWebhook}
              disabled={webhooks.length >= 5}
            >
              <Plus className="w-4 h-4" />
              Add Webhook
            </button>
          </div>

          {!webhooks.length && (
            <p className="text-sm" style={{ color: "#c1c1c3" }}>
              No webhooks configured. Click &ldquo;Add Webhook&rdquo; to create one.
            </p>
          )}

          <div className="space-y-4">
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
                className="p-4 rounded-lg space-y-3"
                style={{
                  backgroundColor: "rgba(255,255,255,0.03)",
                  border: `1px solid ${dragIdx === index ? "#555" : "#2a2a2e"}`,
                  opacity: dragIdx === index ? 0.5 : 1,
                }}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <GripVertical
                      className="w-4 h-4 flex-shrink-0"
                      style={{ color: "#555", cursor: "grab" }}
                      onMouseDown={() => { allowDragRef.current = index; }}
                      onMouseUp={() => { allowDragRef.current = null; }}
                    />
                    <span className="text-sm font-medium" style={{ color: "#c1c1c3" }}>
                      Webhook #{index + 1}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="btn btn-secondary px-2 py-1 text-red-400 hover:text-red-300"
                    onClick={() => removeWebhook(index)}
                    aria-label="Remove webhook"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1" style={{ color: "#fff" }}>
                    URL
                  </label>
                  <input
                    type="url"
                    className="input w-full"
                    placeholder="https://example.com/webhook"
                    value={wh.url || ""}
                    onChange={(e) => updateWebhook(index, { url: e.target.value })}
                    style={codeInputStyle}
                  />
                </div>
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-sm font-medium" style={{ color: "#fff" }}>
                      Body
                      {wh.body !== null && (
                        <span className="ml-2 font-normal text-xs" style={{ color: "#c1c1c3" }}>
                          POST — variables: <code>$flowPath</code>, <code>$flowName</code>
                        </span>
                      )}
                    </label>
                    {wh.body === null ? (
                      <button
                        type="button"
                        className="btn btn-secondary flex items-center gap-1 px-2 py-0.5 text-xs"
                        onClick={() => updateWebhook(index, { body: "" })}
                      >
                        <Plus className="w-3 h-3" />
                        Add Body
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-secondary px-2 py-0.5 text-xs text-red-400"
                        onClick={() => updateWebhook(index, { body: null })}
                      >
                        Remove
                      </button>
                    )}
                  </div>
                  {wh.body !== null && (
                    <textarea
                      className="input w-full font-mono text-sm"
                      rows={3}
                      maxLength={1000}
                      value={wh.body || ""}
                      onChange={(e) => updateWebhook(index, { body: e.target.value })}
                      spellCheck={false}
                      autoComplete="off"
                      autoCorrect="off"
                      autoCapitalize="off"
                      style={{ ...codeInputStyle, resize: "vertical" }}
                    />
                  )}
                </div>
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-sm font-medium" style={{ color: "#fff" }}>
                      Headers
                    </label>
                    <button
                      type="button"
                      className="btn btn-secondary flex items-center gap-1 px-2 py-0.5 text-xs"
                      onClick={() => addHeader(index)}
                      disabled={(wh.headers || []).length >= 10}
                    >
                      <Plus className="w-3 h-3" />
                      Add Header
                    </button>
                  </div>
                  {(wh.headers || []).length > 0 && (
                    <div className="space-y-2">
                      {(wh.headers || []).map((header, hIndex) => (
                        <div key={hIndex} className="flex gap-2 items-center">
                          <input
                            className="input flex-1 text-sm font-mono"
                            placeholder="Header-Name"
                            spellCheck={false}
                            value={header.key || ""}
                            onChange={(e) => updateHeader(index, hIndex, { key: e.target.value })}
                            style={codeInputStyle}
                          />
                          <input
                            className="input flex-1 text-sm font-mono"
                            placeholder="value"
                            spellCheck={false}
                            value={header.value || ""}
                            onChange={(e) => updateHeader(index, hIndex, { value: e.target.value })}
                            style={codeInputStyle}
                          />
                          <button
                            type="button"
                            className="btn btn-secondary px-2 py-1 text-red-400"
                            onClick={() => removeHeader(index, hIndex)}
                            aria-label="Remove header"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>

          <div
            className="pt-4 border-t space-y-3"
            style={{ borderColor: "#2a2a2e" }}
          >
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium" style={{ color: "#fff" }}>
                Notify when daily Discover is updated
              </span>
              <PillToggle
                checked={webhookEvents.notifyDiscoveryUpdated || false}
                onChange={(e) => updateWebhookEvents({ notifyDiscoveryUpdated: e.target.checked })}
              />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium" style={{ color: "#fff" }}>
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


import { useState, useRef } from "react";
import { testGotifyConnection } from "../../../utils/api/endpoints/settings.js";

import { Plus, Trash2, GripVertical } from "lucide-react";
import { Link } from "react-router-dom";
import { SettingsInput, SettingsTextarea } from "./SettingsField";
import { IntegrationCard, SettingsIntegrationModal } from "./SettingsIntegrationCards";
import {
  SettingsArrCardGrid,
  SettingsArrFieldSet,
  SettingsArrFormGroup,
} from "./arr/SettingsArrLayout";
import {
  SettingsModalCallout,
  SettingsModalField,
  SettingsModalIntro,
  SettingsModalSection,
  SettingsModalToggle,
  SettingsModalToggleGroup,
} from "./SettingsModalLayout";
import PillToggle from "../../../components/PillToggle";
import { getConfiguredStatus } from "../utils/integrationStatus";
export function SettingsConnectTab({
  settings,
  updateSettings,
  health,
  handleSaveSettings,
  testingGotify,
  setTestingGotify,
  showSuccess,
  showError,
}) {
  const [activeModal, setActiveModal] = useState(null);
  const gotify = settings.integrations?.gotify || {};
  const lastfm = settings.integrations?.lastfm || {};
  const ticketmaster = settings.integrations?.ticketmaster || {};
  const inbox = settings.inbox || {};
  const gotifyConfigured = Boolean(gotify.url && gotify.token);
  const lastfmConfigured = Boolean(health?.lastfmConfigured);
  const ticketmasterConfigured = Boolean(health?.ticketmasterConfigured);

  const webhooks = settings.integrations?.webhooks || [];
  const webhookEvents = settings.integrations?.webhookEvents || {};

  const updateWebhooks = (newWebhooks) => {
    updateSettings({
      ...settings,
      integrations: {
        ...settings.integrations,
        webhooks: newWebhooks,
      },
    });
  };

  const updateWebhookEvents = (patch) => {
    updateSettings({
      ...settings,
      integrations: {
        ...settings.integrations,
        webhookEvents: { ...webhookEvents, ...patch },
      },
    });
  };

  const updateGotify = (patch) =>
    updateSettings({
      ...settings,
      integrations: {
        ...settings.integrations,
        gotify: { ...gotify, ...patch },
      },
    });

  const updateLastfm = (patch) =>
    updateSettings({
      ...settings,
      integrations: {
        ...settings.integrations,
        lastfm: { ...lastfm, ...patch },
      },
    });

  const updateTicketmaster = (patch) =>
    updateSettings({
      ...settings,
      integrations: {
        ...settings.integrations,
        ticketmaster: { ...ticketmaster, ...patch },
      },
    });

  const updateInbox = (patch) =>
    updateSettings({
      ...settings,
      inbox: { ...inbox, ...patch },
    });

  const [dragIdx, setDragIdx] = useState(null);
  const allowDragRef = useRef(null);

  const handleTestGotify = async () => {
    const url = gotify.url;
    const token = gotify.token;
    if (!url || !token) {
      showError("Enter Gotify URL and token first");
      return;
    }
    setTestingGotify(true);
    try {
      await testGotifyConnection(url, token);
      showSuccess("Test notification sent.");
    } catch (err) {
      const msg = err.response?.data?.message || err.response?.data?.error || err.message;
      showError(`Gotify test failed: ${msg}`);
    } finally {
      setTestingGotify(false);
    }
  };

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
    updateWebhooks(webhooks.map((wh, i) => (i === index ? { ...wh, ...patch } : wh)));
  };

  const addHeader = (whIndex) => {
    const wh = webhooks[whIndex];
    if ((wh.headers || []).length >= 10) return;
    updateWebhook(whIndex, {
      headers: [...(wh.headers || []), { key: "", value: "" }],
    });
  };

  const removeHeader = (whIndex, hIndex) => {
    const wh = webhooks[whIndex];
    updateWebhook(whIndex, {
      headers: (wh.headers || []).filter((_, i) => i !== hIndex),
    });
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
      headers: (wh.headers || []).filter((h) => (h.key || "").trim() && (h.value || "").trim()),
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
    <div className="arr-page">
      <form onSubmit={handleSave} className="arr-form" autoComplete="off">
        <SettingsArrFieldSet legend="Connections">
          <div className="arr-info">
            External services Aurral integrates with for notifications and discovery data.
          </div>
          <SettingsArrCardGrid>
            <IntegrationCard
              title="Gotify"
              subtitle="Push notifications"
              status={getConfiguredStatus(gotifyConfigured)}
              meta={gotify.url ? gotify.url.replace(/^https?:\/\//, "") : "Mobile alerts"}
              onClick={() => setActiveModal("gotify")}
            />
            <IntegrationCard
              title="Last.fm"
              subtitle="Listening history API"
              status={getConfiguredStatus(lastfmConfigured)}
              meta={lastfm.username || "Admin default"}
              onClick={() => setActiveModal("lastfm")}
            />
            <IntegrationCard
              title="Ticketmaster"
              subtitle="Local shows"
              status={getConfiguredStatus(ticketmasterConfigured)}
              meta={`${ticketmaster.searchRadiusMiles ?? 250} mi radius`}
              onClick={() => setActiveModal("ticketmaster")}
            />
          </SettingsArrCardGrid>
        </SettingsArrFieldSet>

        <SettingsArrFieldSet
          legend="Webhooks"
          actions={
            <button
              type="button"
              className="arr-btn"
              onClick={addWebhook}
              disabled={webhooks.length >= 5}
            >
              <Plus className="artist-icon-xs" aria-hidden />
              Add webhook
            </button>
          }
        >
          {!webhooks.length ? (
            <p className="arr-form-help">
              No webhooks configured. Click &ldquo;Add webhook&rdquo; to create one.
            </p>
          ) : null}

          {webhooks.map((wh, index) => (
            <div
              key={index}
              draggable
              onDragStart={(e) => {
                if (allowDragRef.current !== index) {
                  e.preventDefault();
                  return;
                }
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
              className={`arr-webhook-card${dragIdx === index ? " is-dragging" : ""}`}
            >
              <div className="arr-webhook-card__header">
                <div className="arr-webhook-card__title">
                  <GripVertical
                    className="arr-webhook-card__drag artist-icon-xs"
                    onMouseDown={() => {
                      allowDragRef.current = index;
                    }}
                    onMouseUp={() => {
                      allowDragRef.current = null;
                    }}
                  />
                  <span>Webhook #{index + 1}</span>
                </div>
                <button
                  type="button"
                  className="arr-btn arr-btn--ghost arr-btn--icon"
                  onClick={() => removeWebhook(index)}
                  aria-label="Remove webhook"
                >
                  <Trash2 className="artist-icon-sm" aria-hidden />
                </button>
              </div>

              <SettingsArrFormGroup label="URL" labelFor={`webhook-url-${index}`} size="large">
                <SettingsInput
                  id={`webhook-url-${index}`}
                  type="url"
                  placeholder="https://example.com/webhook"
                  value={wh.url || ""}
                  onChange={(e) => updateWebhook(index, { url: e.target.value })}
                />
              </SettingsArrFormGroup>

              <SettingsArrFormGroup
                label="Body"
                size="large"
                help={
                  wh.body === null
                    ? "Optional JSON or text payload sent with each webhook."
                    : undefined
                }
              >
                {wh.body === null ? (
                  <button
                    type="button"
                    className="arr-btn"
                    onClick={() => updateWebhook(index, { body: "" })}
                  >
                    <Plus className="artist-icon-xs" aria-hidden />
                    Add body
                  </button>
                ) : (
                  <>
                    <SettingsTextarea
                      rows={3}
                      maxLength={1000}
                      value={wh.body || ""}
                      onChange={(e) => updateWebhook(index, { body: e.target.value })}
                      spellCheck={false}
                      autoComplete="off"
                    />
                    <button
                      type="button"
                      className="arr-btn arr-webhook-card__inline-action"
                      onClick={() => updateWebhook(index, { body: null })}
                    >
                      Remove body
                    </button>
                  </>
                )}
              </SettingsArrFormGroup>

              <SettingsArrFormGroup label="Headers" size="large">
                {(wh.headers || []).length > 0 ? (
                  <div className="arr-webhook-card__header-rows">
                    {(wh.headers || []).map((header, hIndex) => (
                      <div key={hIndex} className="arr-webhook-card__header-row">
                        <SettingsInput
                          className="settings-page__mono-input"
                          placeholder="Header-Name"
                          spellCheck={false}
                          value={header.key || ""}
                          onChange={(e) =>
                            updateHeader(index, hIndex, {
                              key: e.target.value,
                            })
                          }
                        />
                        <SettingsInput
                          className="settings-page__mono-input"
                          placeholder="value"
                          spellCheck={false}
                          value={header.value || ""}
                          onChange={(e) =>
                            updateHeader(index, hIndex, {
                              value: e.target.value,
                            })
                          }
                        />
                        <button
                          type="button"
                          className="arr-btn arr-btn--ghost arr-btn--icon"
                          onClick={() => removeHeader(index, hIndex)}
                          aria-label="Remove header"
                        >
                          <Trash2 className="artist-icon-sm" aria-hidden />
                        </button>
                      </div>
                    ))}
                  </div>
                ) : null}
                <button
                  type="button"
                  className="arr-btn"
                  onClick={() => addHeader(index)}
                  disabled={(wh.headers || []).length >= 10}
                >
                  <Plus className="artist-icon-xs" aria-hidden />
                  Add header
                </button>
              </SettingsArrFormGroup>
            </div>
          ))}
        </SettingsArrFieldSet>

        <SettingsArrFieldSet legend="Notification Events">
          <SettingsArrFormGroup label="Discover updated">
            <PillToggle
              checked={webhookEvents.notifyDiscoveryUpdated || false}
              aria-label="Discover updated"
              onChange={(e) =>
                updateWebhookEvents({
                  notifyDiscoveryUpdated: e.target.checked,
                })
              }
            />
          </SettingsArrFormGroup>
          <SettingsArrFormGroup label="Weekly flow finished">
            <PillToggle
              checked={webhookEvents.notifyWeeklyFlowDone || false}
              aria-label="Weekly flow finished"
              onChange={(e) =>
                updateWebhookEvents({
                  notifyWeeklyFlowDone: e.target.checked,
                })
              }
            />
          </SettingsArrFormGroup>
          <SettingsArrFormGroup label="Request made">
            <PillToggle
              checked={webhookEvents.notifyRequestMade || false}
              aria-label="Request made"
              onChange={(e) =>
                updateWebhookEvents({
                  notifyRequestMade: e.target.checked,
                })
              }
            />
          </SettingsArrFormGroup>
          <SettingsArrFormGroup label="Request available">
            <PillToggle
              checked={webhookEvents.notifyRequestAvailable || false}
              aria-label="Request available"
              onChange={(e) =>
                updateWebhookEvents({
                  notifyRequestAvailable: e.target.checked,
                })
              }
            />
          </SettingsArrFormGroup>
        </SettingsArrFieldSet>

        <SettingsArrFieldSet legend="Inbox">
          <div className="arr-info">
            Choose which library-based updates appear in the inbox dropdown.
          </div>
          <SettingsArrFormGroup label="Enable Inbox" labelFor="inbox-enabled">
            <PillToggle
              id="inbox-enabled"
              checked={inbox.enabled !== false}
              aria-label="Enable inbox"
              onChange={(e) => updateInbox({ enabled: e.target.checked })}
            />
          </SettingsArrFormGroup>
          <div className={`settings-inbox-preferences${inbox.enabled === false ? " is-disabled" : ""}`} aria-disabled={inbox.enabled === false}>
          <SettingsArrFormGroup label="Upcoming releases" labelFor="inbox-releases">
            <PillToggle
              id="inbox-releases"
              disabled={inbox.enabled === false}
              checked={inbox.releases !== false}
              aria-label="Show upcoming releases in inbox"
              onChange={(e) => updateInbox({ releases: e.target.checked })}
            />
          </SettingsArrFormGroup>
          <SettingsArrFormGroup label="Upcoming shows" labelFor="inbox-shows">
            <PillToggle
              id="inbox-shows"
              checked={inbox.shows !== false}
              aria-label="Show upcoming shows in inbox"
              onChange={(e) => updateInbox({ shows: e.target.checked })}
            />
          </SettingsArrFormGroup>
          <SettingsArrFormGroup label="Library Artist news" labelFor="inbox-news">
            <PillToggle
              id="inbox-news"
              checked={inbox.news !== false}
              aria-label="Show library artist news in inbox"
              onChange={(e) => updateInbox({ news: e.target.checked })}
            />
          </SettingsArrFormGroup>
          <SettingsArrFormGroup label="Recommended Artist news" labelFor="inbox-recommended-news">
            <PillToggle
              id="inbox-recommended-news"
              checked={inbox.recommendedNews === true}
              aria-label="Show recommended artist news in inbox"
              onChange={(e) => updateInbox({ recommendedNews: e.target.checked })}
            />
          </SettingsArrFormGroup>
          <SettingsArrFormGroup label="Discoveries" labelFor="inbox-discoveries">
            <PillToggle
              id="inbox-discoveries"
              disabled={inbox.enabled === false}
              checked={inbox.discoveries !== false}
              aria-label="Show discoveries in inbox"
              onChange={(e) => updateInbox({ discoveries: e.target.checked })}
            />
          </SettingsArrFormGroup>
          </div>
        </SettingsArrFieldSet>
      </form>

      {activeModal === "gotify" && (
        <SettingsIntegrationModal
          title="Gotify"
          onClose={() => setActiveModal(null)}
          footerActions={
            <button
              type="button"
              onClick={handleTestGotify}
              disabled={testingGotify || !gotify.url || !gotify.token}
              className="btn btn-secondary"
            >
              {testingGotify ? "Sending..." : "Test notification"}
            </button>
          }
        >
          <SettingsModalSection title="Connection">
            <SettingsModalField label="Server URL">
              <SettingsInput
                type="url"
                placeholder="https://gotify.example.com"
                autoComplete="off"
                value={gotify.url || ""}
                onChange={(e) => updateGotify({ url: e.target.value })}
              />
            </SettingsModalField>
            <SettingsModalField label="Application token">
              <SettingsInput
                type="password"
                placeholder="Gotify app token"
                autoComplete="off"
                value={gotify.token || ""}
                onChange={(e) => updateGotify({ token: e.target.value })}
              />
            </SettingsModalField>
          </SettingsModalSection>
          <SettingsModalSection title="Notification events">
            <SettingsModalToggleGroup>
              <SettingsModalToggle
                label="Discover updated"
                checked={gotify.notifyDiscoveryUpdated || false}
                onChange={(e) => updateGotify({ notifyDiscoveryUpdated: e.target.checked })}
              />
              <SettingsModalToggle
                label="Weekly flow finished"
                checked={gotify.notifyWeeklyFlowDone || false}
                onChange={(e) => updateGotify({ notifyWeeklyFlowDone: e.target.checked })}
              />
              <SettingsModalToggle
                label="Request made"
                checked={gotify.notifyRequestMade || false}
                onChange={(e) => updateGotify({ notifyRequestMade: e.target.checked })}
              />
              <SettingsModalToggle
                label="Request available"
                checked={gotify.notifyRequestAvailable || false}
                onChange={(e) => updateGotify({ notifyRequestAvailable: e.target.checked })}
              />
            </SettingsModalToggleGroup>
          </SettingsModalSection>
        </SettingsIntegrationModal>
      )}

      {activeModal === "lastfm" && (
        <SettingsIntegrationModal title="Last.fm" onClose={() => setActiveModal(null)}>
          <SettingsModalIntro>
            Admin default API key and username. Users can override listening history in{" "}
            <Link to="/profile" className="settings-page__link">
              Profile
            </Link>
            .
          </SettingsModalIntro>
          <SettingsModalSection title="Credentials">
            <SettingsModalField label="API key">
              <SettingsInput
                type="password"
                placeholder="Last.fm API key"
                autoComplete="off"
                value={lastfm.apiKey || ""}
                onChange={(e) => updateLastfm({ apiKey: e.target.value })}
              />
            </SettingsModalField>
            <SettingsModalField label="Default username">
              <SettingsInput
                type="text"
                placeholder="Your Last.fm username"
                autoComplete="off"
                value={lastfm.username || ""}
                onChange={(e) => updateLastfm({ username: e.target.value })}
              />
            </SettingsModalField>
          </SettingsModalSection>
        </SettingsIntegrationModal>
      )}

      {activeModal === "ticketmaster" && (
        <SettingsIntegrationModal title="Ticketmaster" onClose={() => setActiveModal(null)}>
          <SettingsModalCallout>
            <a
              href="https://developer-acct.ticketmaster.com/user/login"
              target="_blank"
              rel="noopener noreferrer"
              className="settings-page__link"
            >
              Open the Ticketmaster developer portal
            </a>
          </SettingsModalCallout>
          <SettingsModalSection title="API">
            <SettingsModalField label="Consumer key">
              <SettingsInput
                type="password"
                placeholder="Ticketmaster consumer key"
                autoComplete="off"
                value={ticketmaster.apiKey || ""}
                onChange={(e) => updateTicketmaster({ apiKey: e.target.value })}
              />
            </SettingsModalField>
            <SettingsModalField label="Search radius (miles)">
              <SettingsInput
                type="number"
                min={5}
                max={250}
                step={5}
                value={ticketmaster.searchRadiusMiles ?? 250}
                onChange={(e) => {
                  const raw = Number(e.target.value);
                  const value = Number.isFinite(raw)
                    ? Math.max(5, Math.min(250, Math.floor(raw)))
                    : 250;
                  updateTicketmaster({ searchRadiusMiles: value });
                }}
              />
            </SettingsModalField>
          </SettingsModalSection>
          <SettingsModalSection title="Local discovery">
            <SettingsModalToggleGroup>
              <SettingsModalToggle
                label="Include recommended artists in local shows"
                checked={ticketmaster.localDiscoveryIncludeRecommendations !== false}
                onChange={(e) =>
                  updateTicketmaster({
                    localDiscoveryIncludeRecommendations: e.target.checked,
                  })
                }
              />
              <SettingsModalToggle
                label="Include trending artists in local shows"
                checked={ticketmaster.localDiscoveryIncludeTrending !== false}
                onChange={(e) =>
                  updateTicketmaster({
                    localDiscoveryIncludeTrending: e.target.checked,
                  })
                }
              />
            </SettingsModalToggleGroup>
          </SettingsModalSection>
        </SettingsIntegrationModal>
      )}

    </div>
  );
}

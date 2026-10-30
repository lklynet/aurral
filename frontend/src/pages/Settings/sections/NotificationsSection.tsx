import { useState, type FormEvent } from "react";
import { parseResponse } from "hono/client";
import PillToggle from "../../../components/PillToggle";
import TooltipButton from "../../../components/TooltipButton";
import { DotLoader } from "../../../components/DotLoader";
import { Trash2 } from "../../../components/icons";
import { downloadClientSettingsClient } from "../../../utils/api/clients/downloadClientSettings.ts";
import { SettingsInput, SettingsTextarea } from "../components/SettingsField";
import { useServerSettings } from "../SettingsProviders";
import { SettingsLink, useSettingsRoute } from "../settingsRoute";
import type { SettingsState } from "../utils";
import { readApiError } from "../utils/apiError.ts";
import { configuredStatus } from "../utils/serviceStatus";
import {
  SettingsActions,
  SettingsGroup,
  SettingsPage,
  SettingsRow,
  SettingsServiceRow,
  useSettingsItem,
} from "../SettingsLayout";

type Integrations = SettingsState["integrations"];
type Webhook = Integrations["webhooks"][number];
type WebhookHeader = NonNullable<Webhook["headers"]>[number];
type TestStatus = { tone: "success" | "error"; message: string };

const MAX_WEBHOOKS = 5;
const MAX_HEADERS = 10;

const EVENTS = [
  ["notifyDiscoveryUpdated", "Discover updated"],
  ["notifyWeeklyFlowDone", "Flow finished"],
  ["notifyRequestMade", "Request made"],
  ["notifyRequestAvailable", "Request available"],
] as const;

type EventKey = (typeof EVENTS)[number][0];

const INBOX_ITEMS = [
  ["releases", "Upcoming releases"],
  ["shows", "Upcoming shows"],
  ["news", "Library artist news"],
  ["recommendedNews", "Recommended artist news"],
  ["discoveries", "Discoveries"],
] as const;

function webhookName(url: string) {
  try {
    return new URL(url).host || url;
  } catch {
    return url || "Webhook";
  }
}

function resolveWebhookItem(webhooks: Webhook[], item: string | null) {
  if (item === "webhook") return { index: null };
  const match = item?.match(/^webhook-(\d+)$/);
  const index = match ? Number(match[1]) : -1;
  return index >= 0 && index < webhooks.length ? { index } : null;
}

function useTest(send: () => Promise<unknown>, success: string, failure: string, label: string) {
  const { showSuccess, showError } = useServerSettings();
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState<TestStatus | null>(null);

  const run = async () => {
    setTesting(true);
    setStatus(null);
    try {
      await send();
      setStatus({ tone: "success", message: success });
      showSuccess(success);
    } catch (error) {
      setStatus({ tone: "error", message: failure });
      const reason = readApiError(error);
      showError(`${label} test failed: ${reason.message || reason.error || reason.text}`);
    } finally {
      setTesting(false);
    }
  };

  return { testing, status, run, reset: () => setStatus(null) };
}

function EventToggles({
  idPrefix,
  values,
  onChange,
}: {
  idPrefix: string;
  values: Partial<Record<EventKey, boolean>>;
  onChange: (key: EventKey, enabled: boolean) => void;
}) {
  return EVENTS.map(([key, label]) => (
    <SettingsRow key={key} label={label} htmlFor={`${idPrefix}-${key}`}>
      <PillToggle
        id={`${idPrefix}-${key}`}
        checked={values[key] === true}
        aria-label={label}
        onChange={(event) => onChange(key, event.target.checked)}
      />
    </SettingsRow>
  ));
}

function GotifyDetail() {
  const { settings, updateSettings } = useServerSettings();
  const { gotify } = settings.integrations;
  const url = gotify.url || "";
  const token = gotify.token || "";
  const test = useTest(
    () => parseResponse(downloadClientSettingsClient.gotify.test.$post({ json: { url, token } })),
    "Test notification sent.",
    "Test failed. Check the URL and token, then retry.",
    "Gotify",
  );
  const update = (patch: Partial<Integrations["gotify"]>) => {
    test.reset();
    updateSettings({
      ...settings,
      integrations: { ...settings.integrations, gotify: { ...gotify, ...patch } },
    });
  };

  return (
    <SettingsPage title="Gotify" back="Notifications">
      <SettingsGroup title="Connection">
        <SettingsRow label="Server URL" htmlFor="gotify-url">
          <SettingsInput
            id="gotify-url"
            type="url"
            placeholder="https://gotify.example.com"
            autoComplete="off"
            value={url}
            onChange={(event) => update({ url: event.target.value })}
          />
        </SettingsRow>
        <SettingsRow label="Application token" htmlFor="gotify-token">
          <SettingsInput
            id="gotify-token"
            type="password"
            autoComplete="off"
            value={token}
            onChange={(event) => update({ token: event.target.value })}
          />
        </SettingsRow>
        <SettingsActions status={test.status}>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={test.run}
            disabled={test.testing || !url || !token}
          >
            {test.testing ? <DotLoader size="xs" label={null} /> : null}
            Send test
          </button>
        </SettingsActions>
      </SettingsGroup>
      <SettingsGroup title="Events">
        <EventToggles
          idPrefix="gotify"
          values={gotify}
          onChange={(key, enabled) => update({ [key]: enabled })}
        />
      </SettingsGroup>
    </SettingsPage>
  );
}

function WebhookDetail({ index }: { index: number | null }) {
  const { settings, updateSettings } = useServerSettings();
  const route = useSettingsRoute();
  const { webhooks } = settings.integrations;
  const existing = index === null ? undefined : webhooks[index];
  const [url, setUrl] = useState(existing?.url ?? "");
  const [body, setBody] = useState(existing?.body ?? "");
  const [headers, setHeaders] = useState<WebhookHeader[]>(existing?.headers ?? []);
  const [missingUrl, setMissingUrl] = useState(false);
  const draft = { url: url.trim(), body: body.trim() || null, headers };
  const test = useTest(
    () => parseResponse(downloadClientSettingsClient.webhook.test.$post({ json: draft })),
    "Test webhook sent.",
    "Test failed. Check the URL, body, and headers, then retry.",
    "Webhook",
  );

  const save = (next: Webhook[]) =>
    updateSettings({ ...settings, integrations: { ...settings.integrations, webhooks: next } });

  const editHeader = (
    headerIndex: number,
    patch: Partial<Pick<WebhookHeader, "key" | "value">>,
  ) => {
    test.reset();
    setHeaders(headers.map((header, i) => (i === headerIndex ? { ...header, ...patch } : header)));
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!draft.url) {
      setMissingUrl(true);
      return;
    }
    const webhook = {
      ...draft,
      headers: headers.filter((header) => header.key.trim() && header.value.trim()),
    };
    save(
      index === null
        ? [...webhooks, webhook]
        : webhooks.map((entry, i) => (i === index ? webhook : entry)),
    );
    route.back();
  };

  const remove = () => {
    if (index === null) return;
    save(webhooks.filter((_entry, i) => i !== index));
    route.back();
  };

  return (
    <SettingsPage title={index === null ? "Add webhook" : "Webhook"} back="Notifications">
      <SettingsGroup>
        <form onSubmit={submit}>
          <SettingsRow label="URL" htmlFor="webhook-url">
            <SettingsInput
              id="webhook-url"
              type="url"
              placeholder="https://example.com/webhook"
              autoComplete="off"
              value={url}
              onChange={(event) => {
                setMissingUrl(false);
                test.reset();
                setUrl(event.target.value);
              }}
            />
          </SettingsRow>
          <SettingsRow
            label="Body"
            htmlFor="webhook-body"
            help="Optional. With a body Aurral sends a POST, otherwise a GET. $event, $artistName, $albumName, $flowName, and $username are filled in."
            stack
          >
            <SettingsTextarea
              id="webhook-body"
              rows={4}
              maxLength={1000}
              spellCheck={false}
              autoComplete="off"
              value={body}
              onChange={(event) => {
                test.reset();
                setBody(event.target.value);
              }}
            />
          </SettingsRow>
          <SettingsRow label="Headers" stack>
            {headers.map((header, headerIndex) => (
              <div key={headerIndex} className="settings-webhook-header">
                <SettingsInput
                  aria-label="Header name"
                  placeholder="Header-Name"
                  spellCheck={false}
                  autoComplete="off"
                  value={header.key}
                  onChange={(event) => editHeader(headerIndex, { key: event.target.value })}
                />
                <SettingsInput
                  aria-label="Header value"
                  placeholder="value"
                  spellCheck={false}
                  autoComplete="off"
                  value={header.value}
                  onChange={(event) => editHeader(headerIndex, { value: event.target.value })}
                />
                <TooltipButton
                  label="Remove header"
                  className="btn btn-ghost btn-icon btn-sm"
                  onClick={() => setHeaders(headers.filter((_header, i) => i !== headerIndex))}
                >
                  <Trash2 aria-hidden="true" />
                </TooltipButton>
              </div>
            ))}
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={headers.length >= MAX_HEADERS}
              onClick={() => setHeaders([...headers, { key: "", value: "" }])}
            >
              Add header
            </button>
          </SettingsRow>
          <SettingsActions
            status={missingUrl ? { tone: "error", message: "Enter a URL." } : test.status}
          >
            <button type="submit" className="btn btn-primary btn-sm">
              {index === null ? "Add webhook" : "Save"}
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={test.run}
              disabled={test.testing || !draft.url}
            >
              {test.testing ? <DotLoader size="xs" label={null} /> : null}
              Send test
            </button>
            {index === null ? (
              <button type="button" className="btn btn-ghost btn-sm" onClick={route.back}>
                Cancel
              </button>
            ) : (
              <button type="button" className="btn btn-ghost btn-sm" onClick={remove}>
                Delete
              </button>
            )}
          </SettingsActions>
        </form>
      </SettingsGroup>
    </SettingsPage>
  );
}

function InboxGroup() {
  const { settings, updateSettings } = useServerSettings();
  const { inbox } = settings;
  const update = (patch: Partial<SettingsState["inbox"]>) =>
    updateSettings({ ...settings, inbox: { ...inbox, ...patch } });

  return (
    <SettingsGroup title="Inbox">
      <SettingsRow label="Enabled" htmlFor="inbox-enabled">
        <PillToggle
          id="inbox-enabled"
          checked={inbox.enabled !== false}
          aria-label="Enabled"
          onChange={(event) => update({ enabled: event.target.checked })}
        />
      </SettingsRow>
      {INBOX_ITEMS.map(([key, label]) => (
        <SettingsRow key={key} label={label} htmlFor={`inbox-${key}`}>
          <PillToggle
            id={`inbox-${key}`}
            checked={inbox[key] === true}
            disabled={inbox.enabled === false}
            aria-label={label}
            onChange={(event) => update({ [key]: event.target.checked })}
          />
        </SettingsRow>
      ))}
    </SettingsGroup>
  );
}

export function NotificationsSection() {
  const { settings, updateSettings } = useServerSettings();
  const item = useSettingsItem();
  const { gotify, webhooks, webhookEvents } = settings.integrations;
  const webhookItem = resolveWebhookItem(webhooks, item);

  if (item === "gotify") return <GotifyDetail />;
  if (webhookItem) return <WebhookDetail key={item} index={webhookItem.index} />;

  return (
    <SettingsPage title="Notifications">
      <InboxGroup />
      <SettingsGroup title="Push">
        <SettingsServiceRow
          to="notifications/gotify"
          name="Gotify"
          status={configuredStatus(Boolean(gotify.url && gotify.token))}
        />
      </SettingsGroup>
      <SettingsGroup
        title="Webhooks"
        actions={
          webhooks.length < MAX_WEBHOOKS ? (
            <SettingsLink to="notifications/webhook" className="btn btn-secondary btn-sm">
              Add webhook
            </SettingsLink>
          ) : null
        }
      >
        {webhooks.length === 0 ? (
          <p className="settings-group__note">No webhooks yet.</p>
        ) : (
          webhooks.map((webhook, index) => (
            <SettingsServiceRow
              key={`${webhook.url}-${index}`}
              to={`notifications/webhook-${index}`}
              name={webhookName(webhook.url)}
            />
          ))
        )}
      </SettingsGroup>
      {webhooks.length > 0 ? (
        <SettingsGroup title="Webhook events">
          <EventToggles
            idPrefix="webhook-event"
            values={webhookEvents}
            onChange={(key, enabled) =>
              updateSettings({
                ...settings,
                integrations: {
                  ...settings.integrations,
                  webhookEvents: { ...webhookEvents, [key]: enabled },
                },
              })
            }
          />
        </SettingsGroup>
      ) : null}
    </SettingsPage>
  );
}

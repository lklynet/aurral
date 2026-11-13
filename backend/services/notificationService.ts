import * as v from "valibot";
import path from "node:path";
import { http } from "../../lib/http.ts";
import type { NotificationEvent } from "../../lib/notificationEvents.ts";
import { dbOps } from "../db/helpers/index.ts";
import { logger } from "./logger.ts";
import { notificationQueue } from "./jobs/queues.ts";
import { asAppError } from "../../lib/errors.ts";
import { webhookSchema } from "../db/helpers/integrationSettings.ts";
import { getSettingsEncryptionKey } from "../db/helpers/settings.ts";
import { decryptWithKey, encryptWithKey } from "../config/encryption.ts";
import {
  dispatchPluginEvent,
  emitPluginEvent,
  pluginEventDeliverySchema,
} from "./plugins/pluginEvents.ts";

type WebhookTarget = v.InferOutput<typeof webhookSchema>;
type WebhookHeader = NonNullable<WebhookTarget["headers"]>[number];

const WEBHOOK_PLACEHOLDERS = [
  "flowPath",
  "flowName",
  "albumName",
  "albumPath",
  "artistName",
  "trackName",
  "path",
  "username",
  "userId",
  "event",
  "title",
  "message",
] as const;

type WebhookVars = Partial<Record<(typeof WEBHOOK_PLACEHOLDERS)[number], string>>;

interface RequestActor {
  username?: string;
  userId?: number | string;
  id?: number | string;
}

interface RequestNotice {
  albumName?: string;
  artistName?: string;
  albumPath?: string | null;
  user?: RequestActor | null;
}

export const queuedNotificationSchema = v.variant("kind", [
  pluginEventDeliverySchema,
  v.object({
    kind: v.literal("webhook"),
    event: v.string(),
    webhook: webhookSchema,
    vars: v.record(v.string(), v.string()),
  }),
]);

function logDeliveryFailure(
  kind: string,
  event: string | null | undefined,
  url: string,
  error: unknown,
) {
  const failure = asAppError(error);
  logger.error("notifications", "Notification delivery failed", {
    kind,
    event: event || null,
    receiver: URL.parse(url)?.host ?? null,
    status: failure?.response?.status ?? null,
    message: failure?.message || String(error),
  });
}

function buildHeaders(headers: WebhookHeader[] | undefined) {
  if (!Array.isArray(headers)) return {};
  const result: Record<string, string> = {};
  for (const { key, value } of headers) {
    const k = (key || "").trim();
    const v = (value || "").trim();
    if (k && v) result[k] = v;
  }
  return result;
}

function withHeaderValues(
  webhook: WebhookTarget,
  update: (value: string, key: Buffer) => string | null | undefined,
) {
  const key = getSettingsEncryptionKey();
  return {
    ...webhook,
    headers: webhook.headers?.map((header) => ({
      ...header,
      value: update(header.value, key) ?? "",
    })),
  };
}

function escapeJsonString(value: unknown) {
  return JSON.stringify(String(value ?? "")).slice(1, -1);
}

const placeholderPattern = new RegExp(`\\$(${WEBHOOK_PLACEHOLDERS.join("|")})\\b`, "g");

export function interpolateBody(str: string | null | undefined, vars: Record<string, string> = {}) {
  return String(str ?? "").replace(placeholderPattern, (_, key: string) =>
    escapeJsonString(vars[key] ?? ""),
  );
}

async function sendWebhookDirect(webhook: WebhookTarget, event: string, vars: WebhookVars) {
  const url = (webhook.url || "").trim();
  if (!/^https?:\/\//i.test(url)) {
    logger.warn("notifications", "Skipping a webhook without an http(s) URL", { event });
    return;
  }
  const rawBody = (webhook.body || "").trim();
  try {
    if (rawBody) {
      const interpolated = interpolateBody(rawBody, { ...vars, event });
      let parsed: unknown;
      try {
        parsed = JSON.parse(interpolated);
      } catch {
        parsed = interpolated;
      }
      const headers = { ...buildHeaders(webhook.headers), "Content-Type": "application/json" };
      await http.post(url, parsed, { timeoutMs: 30000, headers });
    } else {
      await http.get(url, { timeoutMs: 30000, headers: buildHeaders(webhook.headers) });
    }
  } catch (error) {
    logDeliveryFailure("webhooks", event, url, error);
    throw error;
  }
}

export async function deliverQueuedNotification(
  payload: v.InferOutput<typeof queuedNotificationSchema>,
) {
  if (payload.kind === "plugin") {
    dispatchPluginEvent(payload);
    return;
  }
  await sendWebhookDirect(
    withHeaderValues(payload.webhook, decryptWithKey),
    payload.event,
    payload.vars,
  );
}

type Notice = {
  title: string;
  message: string;
  vars?: WebhookVars;
  plugin?: Record<string, unknown> & { kind: string };
};

function notify(event: NotificationEvent, { title, message, vars = {}, plugin }: Notice) {
  try {
    const { integrations } = dbOps.getSettings();
    if (plugin) emitPluginEvent("notification", { title, message, ...plugin });
    const resolved = Object.fromEntries(
      Object.entries({ ...vars, title, message, event }).filter(([, value]) => value),
    );
    for (const webhook of integrations?.webhooks ?? []) {
      if (!webhook.events?.includes(event)) continue;
      notificationQueue.enqueue({
        kind: "webhook",
        event,
        webhook: withHeaderValues(webhook, encryptWithKey),
        vars: resolved,
      });
    }
  } catch (error) {
    logger.warn("notifications", "Could not queue a notification", {
      event,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

const WEBHOOK_TEST_VARS = Object.freeze({
  flowPath: "/aurral/test-webhook",
  flowName: "Aurral webhook test",
  albumName: "Test album",
  albumPath: "/music/Test artist/Test album",
  artistName: "Test artist",
  trackName: "Test track",
  path: "/music/Test artist/Test album/01 - Test track.flac",
  username: "webhook-test-user",
  userId: "webhook-test-user",
  title: "Aurral test",
  message: "Aurral webhook test",
});

export async function sendWebhookTest(webhook: WebhookTarget) {
  await sendWebhookDirect(webhook, "webhookTest", WEBHOOK_TEST_VARS);
}

function actorVars(user: RequestActor | null | undefined) {
  const username = String(user?.username || "").trim();
  const userId = user?.userId ?? user?.id;
  return { username, userId: userId == null ? "" : String(userId) };
}

function byline(album?: string, artist?: string) {
  const name = String(album || "").trim() || "Album";
  const by = String(artist || "").trim();
  return by ? `${name} by ${by}` : name;
}

export function notifyDiscoveryUpdated() {
  const message = "Daily Discover recommendations have been updated.";
  notify("notifyDiscoveryUpdated", {
    title: "Aurral – Discover",
    message,
    vars: { flowName: "Aurral – Discover" },
    plugin: { kind: "discovery.updated", title: "Discover updated" },
  });
}

export function notifyFlowDone(
  playlistType: string,
  { completed = 0, failed = 0 }: { completed?: number; failed?: number } = {},
  flowPath = "",
  flowName = "",
) {
  const name = String(flowName || playlistType || "").trim() || playlistType;
  const counts = completed > 0 || failed > 0 ? ` Completed: ${completed}, Failed: ${failed}` : "";
  notify("notifyFlowDone", {
    title: "Aurral – Flow",
    message: `Flow "${name}" finished processing.${counts}`,
    vars: { flowPath, flowName: name },
    plugin: {
      kind: "flow.done",
      title: "Flow finished",
      message: `Flow "${name}" finished processing.`,
      flow: { name, path: flowPath, completed, failed },
    },
  });
}

function requestVars({ albumName, artistName, albumPath, user }: RequestNotice) {
  return {
    albumName: String(albumName || "").trim(),
    artistName: String(artistName || "").trim(),
    albumPath: albumPath || "",
    ...actorVars(user),
  };
}

export function notifyRequestMade(notice: RequestNotice = {}) {
  const vars = requestVars(notice);
  const subject = byline(notice.albumName, notice.artistName);
  notify("notifyRequestMade", {
    title: "Aurral – Request",
    message: `Album requested: ${subject}${vars.username ? ` (${vars.username})` : ""}`,
    vars,
    plugin: {
      kind: "request.made",
      title: "Album requested",
      message: `Album requested: ${subject}`,
      album: { title: notice.albumName ?? null, artist: notice.artistName ?? null },
      user: vars.username ? { username: vars.username } : null,
    },
  });
}

export function notifyRequestAvailable(notice: RequestNotice = {}) {
  const vars = requestVars(notice);
  const subject = byline(notice.albumName, notice.artistName);
  notify("notifyRequestAvailable", {
    title: "Aurral – Request",
    message: `Album available: ${subject}${vars.username ? ` requested by ${vars.username}` : ""}`,
    vars,
    plugin: {
      kind: "request.available",
      title: "Album available",
      message: `Album available: ${subject}`,
      album: { title: notice.albumName ?? null, artist: notice.artistName ?? null },
      user: vars.username ? { username: vars.username } : null,
    },
  });
}

export function notifyArtistAdded({
  artistName,
  user,
}: {
  artistName: string;
  user?: RequestActor | null;
}) {
  const actor = actorVars(user);
  const message = `Artist added: ${artistName}`;
  notify("notifyArtistAdded", {
    title: "Aurral – Library",
    message: `${message}${actor.username ? ` (${actor.username})` : ""}`,
    vars: { artistName, ...actor },
    plugin: {
      kind: "artist.added",
      title: "Artist added",
      message,
      artist: { name: artistName },
      user: actor.username ? { username: actor.username } : null,
    },
  });
}

export function notifyTrackAdded({
  trackName,
  artistName,
  albumName,
  filePath,
}: {
  trackName?: string | null;
  artistName?: string | null;
  albumName?: string | null;
  filePath: string;
}) {
  const track = String(trackName || "").trim() || path.basename(filePath);
  const artist = String(artistName || "").trim();
  notify("notifyTrackAdded", {
    title: "Aurral – Library",
    message: `Track added: ${artist ? `${track} by ${artist}` : track}`,
    vars: {
      trackName: track,
      artistName: artist,
      albumName: String(albumName || "").trim(),
      path: filePath,
      albumPath: path.dirname(filePath),
    },
  });
}

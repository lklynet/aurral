import axios from "axios";
import { dbOps } from "../config/db-helpers.js";

async function sendGotify(title, message, priority = 5) {
  const settings = dbOps.getSettings();
  const gotify = settings.integrations?.gotify || {};
  const url = (gotify.url || "").trim().replace(/\/+$/, "");
  const token = (gotify.token || "").trim();
  if (!url || !token) return;
  const endpoint = `${url}/message?token=${encodeURIComponent(token)}`;
  try {
    await axios.post(
      endpoint,
      { title, message, priority },
      { timeout: 10000, headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.warn("[NotificationService] Gotify send failed:", err.message);
  }
}

function buildHeaders(headers) {
  if (!Array.isArray(headers)) return {};
  const result = {};
  for (const { key, value } of headers) {
    const k = (key || "").trim();
    const v = (value || "").trim();
    if (k && v) result[k] = v;
  }
  return result;
}

function escapeJsonString(value) {
  return JSON.stringify(String(value ?? "")).slice(1, -1);
}

function interpolateBody(str, flowPath, flowName) {
  return str
    .replace(/\$flowPath/g, escapeJsonString(flowPath))
    .replace(/\$flowName/g, escapeJsonString(flowName));
}

async function sendWebhooks(
  { webhooks, webhookEvents = {} },
  event,
  flowPath = "",
  flowName = "",
) {
  if (!webhookEvents[event]) return;
  if (!Array.isArray(webhooks) || webhooks.length === 0) return;

  for (const webhook of webhooks) {
    const url = (webhook.url || "").trim();
    if (!url) continue;
    if (!/^https?:\/\//i.test(url)) {
      console.warn(
        `[NotificationService] Skipping webhook with non-http(s) URL: ${url}`,
      );
      continue;
    }
    const rawBody = (webhook.body || "").trim();
    try {
      if (rawBody) {
        console.log(`[NotificationService] Webhook POST ${url}`);
        const interpolated = interpolateBody(rawBody, flowPath, flowName);
        let parsed;
        try {
          parsed = JSON.parse(interpolated);
        } catch {
          console.warn(
            `[NotificationService] Webhook body is not valid JSON, sending as raw string: ${url}`,
          );
          parsed = interpolated;
        }
        const headers = {
          ...buildHeaders(webhook.headers),
          "Content-Type": "application/json",
        };
        await axios.post(url, parsed, { timeout: 30000, headers });
      } else {
        console.log(`[NotificationService] Webhook GET ${url}`);
        await axios.get(url, {
          timeout: 30000,
          headers: buildHeaders(webhook.headers),
        });
      }
    } catch (err) {
      console.warn(
        `[NotificationService] Webhook send failed (${url}):`,
        err.message,
      );
    }
  }
}

export async function sendGotifyTest(url, token) {
  const base = (url || "").trim().replace(/\/+$/, "");
  const t = (token || "").trim();
  if (!base || !t) {
    const err = new Error("Gotify URL and token are required");
    err.code = "MISSING_CONFIG";
    throw err;
  }
  const endpoint = `${base}/message?token=${encodeURIComponent(t)}`;
  const response = await axios.post(
    endpoint,
    {
      title: "Aurral – Test",
      message: "This is a test notification from Aurral.",
      priority: 5,
    },
    { timeout: 10000, headers: { "Content-Type": "application/json" } },
  );
  return response.status === 200;
}

export async function notifyDiscoveryUpdated() {
  const settings = dbOps.getSettings();
  const gotify = settings.integrations?.gotify || {};
  await Promise.all([
    gotify.notifyDiscoveryUpdated
      ? sendGotify(
          "Aurral – Discover",
          "Daily Discover recommendations have been updated.",
          5,
        )
      : Promise.resolve(),
    sendWebhooks(
      settings.integrations,
      "notifyDiscoveryUpdated",
      "",
      "Aurral – Discover",
    ),
  ]);
}

export async function notifyWeeklyFlowDone(
  playlistType,
  stats = {},
  flowPath = "",
  flowName = "",
) {
  const settings = dbOps.getSettings();
  const gotify = settings.integrations?.gotify || {};
  const completed = stats.completed ?? 0;
  const failed = stats.failed ?? 0;
  await Promise.all([
    gotify.notifyWeeklyFlowDone
      ? sendGotify(
          "Aurral – Weekly Flow",
          `Weekly flow "${playlistType}" finished processing.${completed > 0 || failed > 0 ? ` Completed: ${completed}, Failed: ${failed}` : ""}`,
          5,
        )
      : Promise.resolve(),
    sendWebhooks(
      settings.integrations,
      "notifyWeeklyFlowDone",
      flowPath,
      flowName,
    ),
  ]);
}

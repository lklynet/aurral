import axios from "../../lib/axiosFetch.js";
import { dbOps } from "../db/helpers/index.js";
import { enqueueNotification } from "./honkerDb.js";

async function sendGotifyDirect(title, message, priority = 5) {
  const settings = dbOps.getSettings();
  const gotify = settings.integrations?.gotify || {};
  const url = (gotify.url || "").trim().replace(/\/+$/, "");
  const token = (gotify.token || "").trim();
  if (!url || !token) return;
  const endpoint = `${url}/message?token=${encodeURIComponent(token)}`;
  await axios.post(
    endpoint,
    { title, message, priority },
    { timeout: 10000, headers: { "Content-Type": "application/json" } },
  );
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

const WEBHOOK_PLACEHOLDERS = [
  "flowPath",
  "flowName",
  "albumName",
  "artistName",
  "username",
  "userId",
  "event",
];

export function interpolateBody(str, vars = {}) {
  const source = String(str ?? "");
  const pattern = new RegExp(`\\$(${WEBHOOK_PLACEHOLDERS.join("|")})`, "g");
  return source.replace(pattern, (_, key) => escapeJsonString(vars[key] ?? ""));
}

function normalizeWebhookVars(vars = {}, flowPath = "", flowName = "") {
  if (vars && typeof vars === "object" && !Array.isArray(vars)) {
    return {
      flowPath: vars.flowPath ?? flowPath ?? "",
      flowName: vars.flowName ?? flowName ?? "",
      albumName: vars.albumName ?? "",
      artistName: vars.artistName ?? "",
      username: vars.username ?? "",
      userId: vars.userId ?? "",
      event: vars.event ?? "",
    };
  }
  return {
    flowPath: flowPath || "",
    flowName: flowName || "",
    albumName: "",
    artistName: "",
    username: "",
    userId: "",
    event: "",
  };
}

function requestActorVars(user = null) {
  if (!user || typeof user !== "object") {
    return { username: "", userId: "" };
  }
  const username = String(user.username || "").trim();
  const userId = user.userId ?? user.id;
  return {
    username,
    userId: userId == null || userId === "" ? "" : String(userId),
  };
}

function formatRequestSubject(albumName, artistName) {
  const album = String(albumName || "").trim() || "Album";
  const artist = String(artistName || "").trim();
  return artist ? `${album} by ${artist}` : album;
}

async function sendWebhooksDirect({ webhooks, webhookEvents = {} }, event, vars = {}) {
  if (!webhookEvents[event]) return;
  if (!Array.isArray(webhooks) || webhooks.length === 0) return;

  const resolved = normalizeWebhookVars({ ...vars, event });

  for (const webhook of webhooks) {
    const url = (webhook.url || "").trim();
    if (!url) continue;
    if (!/^https?:\/\//i.test(url)) {
      console.warn(`[NotificationService] Skipping webhook with non-http(s) URL: ${url}`);
      continue;
    }
    const rawBody = (webhook.body || "").trim();
    if (rawBody) {
      const interpolated = interpolateBody(rawBody, resolved);
      let parsed;
      try {
        parsed = JSON.parse(interpolated);
      } catch {
        parsed = interpolated;
      }
      const headers = {
        ...buildHeaders(webhook.headers),
        "Content-Type": "application/json",
      };
      await axios.post(url, parsed, { timeout: 30000, headers });
    } else {
      await axios.get(url, {
        timeout: 30000,
        headers: buildHeaders(webhook.headers),
      });
    }
  }
}

export async function deliverQueuedNotification(payload = {}) {
  const kind = String(payload?.kind || "").trim();
  switch (kind) {
    case "gotify":
      await sendGotifyDirect(payload.title, payload.message, Number(payload.priority ?? 5));
      return;
    case "webhooks":
      await sendWebhooksDirect(
        payload.integrations || {},
        payload.event,
        normalizeWebhookVars(payload.vars, payload.flowPath, payload.flowName),
      );
      return;
    default:
      throw new Error(`Unknown notification kind: ${kind || "unknown"}`);
  }
}

function queueGotify(title, message, priority = 5) {
  return enqueueNotification({
    kind: "gotify",
    title,
    message,
    priority,
    requestedAt: Date.now(),
  });
}

function queueWebhooks(integrations, event, vars = {}) {
  const resolved = normalizeWebhookVars({ ...vars, event });
  return enqueueNotification({
    kind: "webhooks",
    integrations,
    event,
    vars: resolved,
    flowPath: resolved.flowPath,
    flowName: resolved.flowName,
    requestedAt: Date.now(),
  });
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
  const tasks = [];
  if (gotify.notifyDiscoveryUpdated) {
    tasks.push(
      queueGotify("Aurral – Discover", "Daily Discover recommendations have been updated.", 5),
    );
  }
  tasks.push(
    queueWebhooks(settings.integrations, "notifyDiscoveryUpdated", {
      flowName: "Aurral – Discover",
    }),
  );
  await Promise.all(tasks);
}

export async function notifyWeeklyFlowDone(playlistType, stats = {}, flowPath = "", flowName = "") {
  const settings = dbOps.getSettings();
  const gotify = settings.integrations?.gotify || {};
  const completed = stats.completed ?? 0;
  const failed = stats.failed ?? 0;
  const tasks = [];
  if (gotify.notifyWeeklyFlowDone) {
    tasks.push(
      queueGotify(
        "Aurral – Weekly Flow",
        `Weekly flow "${playlistType}" finished processing.${completed > 0 || failed > 0 ? ` Completed: ${completed}, Failed: ${failed}` : ""}`,
        5,
      ),
    );
  }
  tasks.push(
    queueWebhooks(settings.integrations, "notifyWeeklyFlowDone", {
      flowPath,
      flowName,
    }),
  );
  await Promise.all(tasks);
}

export async function notifyRequestMade({ albumName, artistName, user = null } = {}) {
  const settings = dbOps.getSettings();
  const gotify = settings.integrations?.gotify || {};
  const actor = requestActorVars(user);
  const subject = formatRequestSubject(albumName, artistName);
  const tasks = [];
  if (gotify.notifyRequestMade) {
    const byUser = actor.username ? ` (${actor.username})` : "";
    tasks.push(queueGotify("Aurral – Request", `Album requested: ${subject}${byUser}`, 5));
  }
  tasks.push(
    queueWebhooks(settings.integrations, "notifyRequestMade", {
      albumName: String(albumName || "").trim(),
      artistName: String(artistName || "").trim(),
      ...actor,
    }),
  );
  await Promise.all(tasks);
}

export async function notifyRequestAvailable({ albumName, artistName, user = null } = {}) {
  const settings = dbOps.getSettings();
  const gotify = settings.integrations?.gotify || {};
  const actor = requestActorVars(user);
  const subject = formatRequestSubject(albumName, artistName);
  const tasks = [];
  if (gotify.notifyRequestAvailable) {
    const byUser = actor.username ? ` requested by ${actor.username}` : "";
    tasks.push(queueGotify("Aurral – Request", `Album available: ${subject}${byUser}`, 5));
  }
  tasks.push(
    queueWebhooks(settings.integrations, "notifyRequestAvailable", {
      albumName: String(albumName || "").trim(),
      artistName: String(artistName || "").trim(),
      ...actor,
    }),
  );
  await Promise.all(tasks);
}

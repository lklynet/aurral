import { createHash, randomBytes } from "node:crypto";
import * as v from "valibot";
import { db } from "../config/db-sqlite.ts";
import type { HubLinksRow } from "../db/rows.ts";
import { dbOps } from "../db/helpers/index.ts";
import { enqueueSystemTask } from "./jobs/systemTasks.ts";
import { getShareInstance, SHARE_ORIGIN } from "./shareLinks/store.ts";

const HUB_TIMEOUT_MS = 5000;
const REVOKE_ATTEMPTS = 30;

const startedSchema = v.object({ userCode: v.string(), expiresAt: v.number() });
const statusSchema = v.variant("status", [
  v.object({ status: v.literal("pending"), expiresAt: v.number() }),
  v.object({ status: v.literal("linked"), handle: v.string() }),
]);
const revokedSchema = v.object({ error: v.literal("link_revoked") });
const revokeTaskSchema = v.object({ origin: v.string(), tokenHash: v.string() });

export class HubLinkError extends Error {}

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export const hubLinksEnabled = () => dbOps.getSettings().security.aurralAccounts !== false;

export const selectLink = db.prepare<[number], HubLinksRow>(
  "SELECT * FROM hub_links WHERE user_id = ?",
);
const deleteLink = db.prepare<[number]>("DELETE FROM hub_links WHERE user_id = ?");

const countPublications = db.prepare<[number], { count: number }>(
  "SELECT COUNT(*) AS count FROM hub_publications WHERE user_id = ?",
);

export const hubRequest = (origin: string, path: string, init: RequestInit = {}) =>
  fetch(`${origin}${path}`, { ...init, signal: AbortSignal.timeout(HUB_TIMEOUT_MS) });

function queueRevoke(link: HubLinksRow) {
  enqueueSystemTask(
    { kind: "hub-link-revoke", origin: link.origin, tokenHash: hashToken(link.token) },
    { maxAttempts: REVOKE_ATTEMPTS },
  );
}

export const markLinkBroken = db.transaction((userId: number) => {
  db.prepare<[number]>("UPDATE hub_links SET broken = 1 WHERE user_id = ?").run(userId);
  db.prepare<[number]>("DELETE FROM hub_publications WHERE user_id = ?").run(userId);
});

export const forgetHubLink = db.transaction((userId: number) => {
  const link = selectLink.get(userId);
  if (!link) return;
  queueRevoke(link);
  deleteLink.run(userId);
});

export async function startHubLink(user: { id: number; username: string }) {
  if (!hubLinksEnabled()) throw new HubLinkError("aurral.org accounts are turned off.");
  const token = randomBytes(32).toString("base64url");
  const { id: instanceId, secret } = getShareInstance();
  const response = await hubRequest(SHARE_ORIGIN, "/v1/links", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ instanceId, secret, token, userName: user.username }),
  }).catch(() => null);
  const started = response?.ok ? v.safeParse(startedSchema, await response.json()) : null;
  if (!started?.success) throw new HubLinkError("Couldn't reach aurral.org. Try again.");
  db.transaction(() => {
    forgetHubLink(user.id);
    db.prepare<[number, string, string, string, number]>(
      "INSERT INTO hub_links (user_id, origin, token, user_code, expires_at) VALUES (?, ?, ?, ?, ?)",
    ).run(user.id, SHARE_ORIGIN, token, started.output.userCode, started.output.expiresAt);
  })();
  return hubLinkStatus(user.id);
}

async function checkHub(link: HubLinksRow) {
  const response = await hubRequest(link.origin, "/v1/link", {
    headers: { Authorization: `Bearer ${link.token}` },
  }).catch(() => null);
  if (!response) return;
  const body: unknown = await response.json().catch(() => null);
  if (response.status === 401 && v.is(revokedSchema, body)) {
    if (link.linked_at) {
      markLinkBroken(link.user_id);
    } else {
      deleteLink.run(link.user_id);
    }
    return;
  }
  const status = response.ok ? v.safeParse(statusSchema, body) : null;
  if (status?.success && status.output.status === "linked") {
    db.prepare<[string, number, number]>(
      "UPDATE hub_links SET handle = ?, linked_at = coalesce(linked_at, ?), user_code = NULL, expires_at = NULL WHERE user_id = ?",
    ).run(status.output.handle, Date.now(), link.user_id);
  }
}

export async function hubLinkStatus(userId: number) {
  const available = hubLinksEnabled();
  const before = selectLink.get(userId);
  if (before && !before.broken && available) await checkHub(before);
  const link = before && available ? selectLink.get(userId) : before;
  const base = {
    available,
    origin: link?.origin ?? SHARE_ORIGIN,
    publicPlaylists: countPublications.get(userId)?.count ?? 0,
  };
  if (!link) return { ...base, state: "none" as const };
  if (link.linked_at && link.handle) {
    return {
      ...base,
      state: link.broken ? ("broken" as const) : ("linked" as const),
      handle: link.handle,
      linkedAt: link.linked_at,
    };
  }
  if (link.user_code && link.expires_at && link.expires_at > Date.now()) {
    return {
      ...base,
      state: "pending" as const,
      code: link.user_code,
      expiresAt: link.expires_at,
    };
  }
  return { ...base, state: "none" as const };
}

export async function revokeHubLink(payload: unknown) {
  const task = v.safeParse(revokeTaskSchema, payload);
  if (!task.success) return;
  const { id: instanceId, secret } = getShareInstance();
  const response = await hubRequest(task.output.origin, "/v1/links/revoke", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ instanceId, secret, tokenHash: task.output.tokenHash }),
  });
  if (!response.ok) throw new Error(`aurral.org answered ${response.status}`);
}

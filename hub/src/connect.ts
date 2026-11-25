import type { D1Database } from "@cloudflare/workers-types/index.ts";
import * as v from "valibot";
import {
  CONNECT_ASSERTION_TTL_MS,
  CONNECT_MAX_SERVERS_DEFAULT,
  CONNECT_MAX_USERS_PER_SERVER,
  CONNECT_SLUG_HOLD_MS,
  CONNECT_SLUG_PATTERN,
  CONNECT_TICKET_TTL_MS,
  CONNECT_TRIAL_MS,
  normalizeLanHints,
  parseEd25519PrivateJwk,
  sha256Base64Url,
  signConnectToken,
  toBase64Url,
  type ConnectPublicJwk,
} from "../../lib/connectTokens.ts";
import { allowedText, handleOf } from "./handles.ts";
import { sha256Hex } from "./instances.ts";

export const CONNECT_AUTH_CODE_MS = 2 * 60 * 1000;
export const CONNECT_CLIENT_TOKEN_MS = 30 * 24 * 60 * 60 * 1000;

export const CONNECT_CLIENTS = ["hosted", "desktop", "mobile"] as const;
export type ConnectClientId = (typeof CONNECT_CLIENTS)[number];

export type EntitlementStatus = "none" | "trial" | "active" | "past_due" | "canceled";
export type SlugProblem = "invalid" | "reserved" | "not_allowed" | "taken";

const OFFICIAL_SLUGS = ["aurral", "lklynet"];

const RESERVED_SLUGS = new Set([
  "relay",
  "us",
  "eu",
  "ap",
  "api",
  "www",
  "mail",
  "status",
  "admin",
  "administrator",
  "auth",
  "connect",
  "music",
  "hub",
  "docs",
  "data",
  "share",
  "app",
  "cdn",
  "static",
  "staging",
  "dev",
  "test",
  "root",
  "system",
  "support",
  "help",
  "official",
  "staff",
  "mod",
  "moderator",
  "team",
  "account",
  "settings",
  "link",
  "null",
  "undefined",
  "lidarr",
  "brainzmash",
]);

const lanHintsListSchema = v.array(v.string());

type EntitlementRow = {
  account_id: string;
  status: string;
  max_servers: number;
  current_period_end: number | null;
  trial_used_at: number | null;
  updated_at: number;
};

export type ConnectEntitlementSummary = {
  status: EntitlementStatus;
  active: boolean;
  maxServers: number;
  currentPeriodEnd: number | null;
  trialAvailable: boolean;
};

export const normalizeSlug = (input: string) => input.trim().toLowerCase();

export function checkSlug(slug: string): Exclude<SlugProblem, "taken"> | null {
  if (!CONNECT_SLUG_PATTERN.test(slug) || slug.startsWith("xn--")) return "invalid";
  if (RESERVED_SLUGS.has(slug) || OFFICIAL_SLUGS.some((name) => slug.includes(name))) {
    return "reserved";
  }
  if (!allowedText(slug.replace(/-/g, " "))) return "not_allowed";
  return null;
}

export const connectOriginFor = (slug: string, connectDomain: string) =>
  `https://${slug}.${connectDomain}`;

function parseLanHints(raw: string): string[] {
  try {
    const parsed = v.safeParse(lanHintsListSchema, JSON.parse(raw));
    return parsed.success ? normalizeLanHints(parsed.output) : [];
  } catch {
    return [];
  }
}

function normalizeStatus(status: string): EntitlementStatus {
  if (status === "trial" || status === "active" || status === "past_due" || status === "canceled") {
    return status;
  }
  return "none";
}

export function isEntitlementActive(
  row: Pick<EntitlementRow, "status" | "current_period_end"> | null,
  now = Date.now(),
): boolean {
  if (!row) return false;
  if (row.status !== "trial" && row.status !== "active" && row.status !== "past_due") return false;
  return row.current_period_end === null || row.current_period_end > now;
}

export async function getEntitlement(
  db: D1Database,
  accountId: string,
  now = Date.now(),
): Promise<ConnectEntitlementSummary> {
  const row = await db
    .prepare(
      "SELECT account_id, status, max_servers, current_period_end, trial_used_at, updated_at FROM connect_entitlements WHERE account_id = ?",
    )
    .bind(accountId)
    .first<EntitlementRow>();
  if (!row) {
    return {
      status: "none",
      active: false,
      maxServers: CONNECT_MAX_SERVERS_DEFAULT,
      currentPeriodEnd: null,
      trialAvailable: true,
    };
  }
  return {
    status: normalizeStatus(row.status),
    active: isEntitlementActive(row, now),
    maxServers: row.max_servers,
    currentPeriodEnd: row.current_period_end,
    trialAvailable: row.trial_used_at === null,
  };
}

export async function getConnectAccountSummary(
  db: D1Database,
  accountId: string,
  now = Date.now(),
) {
  const [entitlement, count] = await Promise.all([
    getEntitlement(db, accountId, now),
    db
      .prepare("SELECT COUNT(*) AS count FROM connect_servers WHERE owner_account_id = ?")
      .bind(accountId)
      .first<number>("count"),
  ]);
  return { entitlement, serverCount: count ?? 0 };
}

export async function startConnectTrial(
  db: D1Database,
  accountId: string,
  now = Date.now(),
): Promise<"started" | "already_active" | "already_used"> {
  const existing = await db
    .prepare(
      "SELECT account_id, status, max_servers, current_period_end, trial_used_at, updated_at FROM connect_entitlements WHERE account_id = ?",
    )
    .bind(accountId)
    .first<EntitlementRow>();
  if (isEntitlementActive(existing, now)) return "already_active";
  if (existing?.trial_used_at !== null && existing?.trial_used_at !== undefined) {
    return "already_used";
  }
  const periodEnd = now + CONNECT_TRIAL_MS;
  const result = await db
    .prepare(
      `INSERT INTO connect_entitlements (account_id, status, max_servers, current_period_end, trial_used_at, updated_at)
       VALUES (?1, 'trial', ?2, ?3, ?4, ?4)
       ON CONFLICT (account_id) DO UPDATE SET
         status = 'trial',
         current_period_end = excluded.current_period_end,
         trial_used_at = excluded.trial_used_at,
         updated_at = excluded.updated_at
       WHERE connect_entitlements.trial_used_at IS NULL`,
    )
    .bind(accountId, CONNECT_MAX_SERVERS_DEFAULT, periodEnd, now)
    .run();
  return result.meta.changes > 0 ? "started" : "already_used";
}

export async function setConnectEntitlement(
  db: D1Database,
  accountId: string,
  update: {
    status: Exclude<EntitlementStatus, "none">;
    maxServers?: number;
    currentPeriodEnd: number | null;
  },
  now = Date.now(),
) {
  const maxServers = update.maxServers ?? CONNECT_MAX_SERVERS_DEFAULT;
  await db
    .prepare(
      `INSERT INTO connect_entitlements (account_id, status, max_servers, current_period_end, trial_used_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, CASE WHEN ?2 = 'trial' THEN ?5 ELSE NULL END, ?5)
       ON CONFLICT (account_id) DO UPDATE SET
         status = excluded.status,
         max_servers = excluded.max_servers,
         current_period_end = excluded.current_period_end,
         trial_used_at = COALESCE(connect_entitlements.trial_used_at, excluded.trial_used_at),
         updated_at = excluded.updated_at`,
    )
    .bind(accountId, update.status, maxServers, update.currentPeriodEnd, now)
    .run();
}

async function claimSlugForInstance(
  db: D1Database,
  instanceId: string,
  rawSlug: string,
  now = Date.now(),
): Promise<{ ok: true; slug: string } | { ok: false; error: SlugProblem }> {
  const slug = normalizeSlug(rawSlug);
  const problem = checkSlug(slug);
  if (problem) return { ok: false, error: problem };

  const current = await db
    .prepare("SELECT slug FROM connect_slugs WHERE instance_id = ?")
    .bind(instanceId)
    .first<string>("slug");
  if (current === slug) return { ok: true, slug };

  const existing = await db
    .prepare("SELECT instance_id, released_at FROM connect_slugs WHERE slug = ?")
    .bind(slug)
    .first<{ instance_id: string | null; released_at: number | null }>();
  if (existing) {
    const held =
      existing.instance_id !== null ||
      existing.released_at === null ||
      existing.released_at > now - CONNECT_SLUG_HOLD_MS;
    if (held) return { ok: false, error: "taken" };
  }

  const statements = [];
  if (current) {
    statements.push(
      db
        .prepare(
          "UPDATE connect_slugs SET instance_id = NULL, released_at = ? WHERE slug = ? AND instance_id = ?",
        )
        .bind(now, current, instanceId),
    );
  }
  statements.push(
    db
      .prepare(
        `INSERT INTO connect_slugs (slug, instance_id, released_at)
         VALUES (?1, ?2, NULL)
         ON CONFLICT (slug) DO UPDATE SET instance_id = excluded.instance_id, released_at = NULL
         WHERE connect_slugs.instance_id IS NULL
           AND connect_slugs.released_at IS NOT NULL
           AND connect_slugs.released_at <= ?3`,
      )
      .bind(slug, instanceId, now - CONNECT_SLUG_HOLD_MS),
  );
  const results = await db.batch(statements);
  const claimResult = results.at(-1);
  if (!claimResult?.meta.changes) {
    if (current) {
      await db
        .prepare(
          "UPDATE connect_slugs SET instance_id = ?, released_at = NULL WHERE slug = ? AND instance_id IS NULL",
        )
        .bind(instanceId, current)
        .run();
    }
    return { ok: false, error: "taken" };
  }
  return { ok: true, slug };
}

export async function registerConnectServer(
  db: D1Database,
  params: {
    instanceId: string;
    ownerAccountId: string;
    slug: string;
    name: string;
    lanHints?: readonly string[];
    startTrial?: boolean;
    connectDomain: string;
    now?: number;
  },
) {
  const now = params.now ?? Date.now();
  if (params.startTrial) {
    await startConnectTrial(db, params.ownerAccountId, now);
  }
  const entitlement = await getEntitlement(db, params.ownerAccountId, now);
  if (!entitlement.active) return { ok: false as const, error: "subscription_required" as const };

  const slug = normalizeSlug(params.slug);
  const slugProblem = checkSlug(slug);
  if (slugProblem) return { ok: false as const, error: `slug_${slugProblem}` as const };

  const existingSlug = await db
    .prepare("SELECT instance_id, released_at FROM connect_slugs WHERE slug = ?")
    .bind(slug)
    .first<{ instance_id: string | null; released_at: number | null }>();
  if (
    existingSlug &&
    existingSlug.instance_id !== params.instanceId &&
    (existingSlug.instance_id !== null ||
      existingSlug.released_at === null ||
      existingSlug.released_at > now - CONNECT_SLUG_HOLD_MS)
  ) {
    return { ok: false as const, error: "slug_taken" as const };
  }

  const lanHints = normalizeLanHints(params.lanHints ?? []);
  const inserted = await db
    .prepare(
      `INSERT INTO connect_servers (instance_id, owner_account_id, name, lan_hints, online, last_seen_at, created_at, updated_at)
       SELECT ?1, ?2, ?3, ?4, 0, NULL, ?5, ?5
       WHERE NOT EXISTS (SELECT 1 FROM connect_servers WHERE instance_id = ?1)
         AND (SELECT COUNT(*) FROM connect_servers WHERE owner_account_id = ?2) < ?6`,
    )
    .bind(
      params.instanceId,
      params.ownerAccountId,
      params.name,
      JSON.stringify(lanHints),
      now,
      entitlement.maxServers,
    )
    .run();
  const createdServer = inserted.meta.changes > 0;
  if (!createdServer) {
    const updated = await db
      .prepare(
        "UPDATE connect_servers SET name = ?, lan_hints = ?, updated_at = ? WHERE instance_id = ? AND owner_account_id = ?",
      )
      .bind(params.name, JSON.stringify(lanHints), now, params.instanceId, params.ownerAccountId)
      .run();
    if (!updated.meta.changes) {
      const owner = await db
        .prepare("SELECT owner_account_id FROM connect_servers WHERE instance_id = ?")
        .bind(params.instanceId)
        .first<string>("owner_account_id");
      return {
        ok: false as const,
        error:
          owner && owner !== params.ownerAccountId
            ? ("server_already_owned" as const)
            : ("server_limit_reached" as const),
      };
    }
  }

  const claimed = await claimSlugForInstance(db, params.instanceId, slug, now);
  if (!claimed.ok) {
    if (createdServer) {
      await db
        .prepare(
          `DELETE FROM connect_servers
           WHERE instance_id = ?1
             AND owner_account_id = ?2
             AND NOT EXISTS (SELECT 1 FROM connect_slugs WHERE instance_id = ?1)`,
        )
        .bind(params.instanceId, params.ownerAccountId)
        .run();
    }
    return { ok: false as const, error: `slug_${claimed.error}` as const };
  }

  return {
    ok: true as const,
    server: {
      instanceId: params.instanceId,
      slug: claimed.slug,
      connectUrl: connectOriginFor(claimed.slug, params.connectDomain),
      name: params.name,
      lanHints,
    },
    entitlement,
  };
}

export async function updateConnectServer(
  db: D1Database,
  params: {
    instanceId: string;
    ownerAccountId: string;
    name?: string;
    slug?: string;
    lanHints?: readonly string[];
    connectDomain: string;
    now?: number;
  },
) {
  const now = params.now ?? Date.now();
  const row = await db
    .prepare(
      `SELECT s.instance_id, s.owner_account_id, s.name, s.lan_hints, sl.slug
       FROM connect_servers s
       LEFT JOIN connect_slugs sl ON sl.instance_id = s.instance_id
       WHERE s.instance_id = ?`,
    )
    .bind(params.instanceId)
    .first<{
      instance_id: string;
      owner_account_id: string;
      name: string;
      lan_hints: string;
      slug: string | null;
    }>();
  if (!row) return { ok: false as const, error: "not_found" as const };
  if (row.owner_account_id !== params.ownerAccountId) {
    return { ok: false as const, error: "forbidden" as const };
  }

  let slug = row.slug;
  if (params.slug !== undefined) {
    const claimed = await claimSlugForInstance(db, params.instanceId, params.slug, now);
    if (!claimed.ok) return { ok: false as const, error: `slug_${claimed.error}` as const };
    slug = claimed.slug;
  }
  if (!slug) return { ok: false as const, error: "not_found" as const };

  const name = params.name ?? row.name;
  const lanHints =
    params.lanHints !== undefined
      ? normalizeLanHints(params.lanHints)
      : parseLanHints(row.lan_hints);
  await db
    .prepare(
      "UPDATE connect_servers SET name = ?, lan_hints = ?, updated_at = ? WHERE instance_id = ?",
    )
    .bind(name, JSON.stringify(lanHints), now, params.instanceId)
    .run();

  return {
    ok: true as const,
    server: {
      instanceId: params.instanceId,
      slug,
      connectUrl: connectOriginFor(slug, params.connectDomain),
      name,
      lanHints,
    },
  };
}

export async function disableConnectServer(
  db: D1Database,
  params: { instanceId: string; ownerAccountId?: string; now?: number },
) {
  const now = params.now ?? Date.now();
  const existing = await db
    .prepare("SELECT owner_account_id FROM connect_servers WHERE instance_id = ?")
    .bind(params.instanceId)
    .first<string>("owner_account_id");
  if (!existing) return { ok: true as const };
  if (params.ownerAccountId && existing !== params.ownerAccountId) {
    return { ok: false as const, error: "forbidden" as const };
  }
  await db.batch([
    db
      .prepare("UPDATE connect_slugs SET instance_id = NULL, released_at = ? WHERE instance_id = ?")
      .bind(now, params.instanceId),
    db.prepare("DELETE FROM connect_servers WHERE instance_id = ?").bind(params.instanceId),
  ]);
  return { ok: true as const };
}

export async function connectJwks(signingKey: string | undefined): Promise<ConnectPublicJwk[]> {
  if (!signingKey) return [];
  const parsed = await parseEd25519PrivateJwk(signingKey);
  return parsed ? [parsed.publicJwk] : [];
}

export async function issueTunnelTicket(
  db: D1Database,
  params: {
    instanceId: string;
    signingKey: string | undefined;
    hubOrigin: string;
    connectDomain: string;
    relayUrl: string;
    lanHints?: readonly string[];
    now?: number;
  },
) {
  if (!params.signingKey) return { ok: false as const, error: "connect_unconfigured" as const };
  const now = params.now ?? Date.now();
  const row = await db
    .prepare(
      `SELECT s.instance_id, s.owner_account_id, sl.slug, e.status, e.current_period_end
       FROM connect_servers s
       JOIN connect_slugs sl ON sl.instance_id = s.instance_id
       LEFT JOIN connect_entitlements e ON e.account_id = s.owner_account_id
       WHERE s.instance_id = ?`,
    )
    .bind(params.instanceId)
    .first<{
      instance_id: string;
      owner_account_id: string;
      slug: string;
      status: string | null;
      current_period_end: number | null;
    }>();
  if (!row) return { ok: false as const, error: "connect_not_enabled" as const };
  if (
    !isEntitlementActive(
      row.status ? { status: row.status, current_period_end: row.current_period_end } : null,
      now,
    )
  ) {
    return { ok: false as const, error: "subscription_required" as const };
  }
  if (params.lanHints !== undefined) {
    await db
      .prepare("UPDATE connect_servers SET lan_hints = ?, updated_at = ? WHERE instance_id = ?")
      .bind(JSON.stringify(normalizeLanHints(params.lanHints)), now, params.instanceId)
      .run();
  }
  const connectOrigin = connectOriginFor(row.slug, params.connectDomain);
  const iat = Math.floor(now / 1000);
  const exp = Math.floor((now + CONNECT_TICKET_TTL_MS) / 1000);
  const ticket = await signConnectToken(params.signingKey, {
    typ: "aurral-connect-tunnel" as const,
    iss: params.hubOrigin,
    aud: "aurral-relay" as const,
    sub: row.instance_id,
    slug: row.slug,
    connectOrigin,
    iat,
    exp,
  });
  return {
    ok: true as const,
    ticket,
    expiresAt: exp * 1000,
    slug: row.slug,
    connectUrl: connectOrigin,
    relayUrl: params.relayUrl,
  };
}

export async function updateRelayStatus(
  db: D1Database,
  updates: readonly { instanceId: string; online: boolean }[],
  now = Date.now(),
) {
  if (!updates.length) return;
  await db.batch(
    updates.map((entry) =>
      db
        .prepare("UPDATE connect_servers SET online = ?, last_seen_at = ? WHERE instance_id = ?")
        .bind(entry.online ? 1 : 0, now, entry.instanceId),
    ),
  );
}

export function isAllowedRedirectUri(
  clientId: ConnectClientId,
  redirectUri: string,
  appOrigin: string,
): boolean {
  const normalizedApp = appOrigin.replace(/\/+$/, "");
  if (clientId === "hosted") return redirectUri === `${normalizedApp}/connect/callback`;
  if (clientId === "mobile") return redirectUri === "aurral://connect/callback";
  if (redirectUri === "aurral://connect/callback") return true;
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return false;
  }
  const port = Number(url.port);
  return (
    url.protocol === "http:" &&
    url.hostname === "127.0.0.1" &&
    Number.isInteger(port) &&
    port >= 1024 &&
    port <= 65535 &&
    url.pathname === "/connect/callback" &&
    !url.search &&
    !url.hash &&
    !url.username &&
    !url.password
  );
}

const randomToken = () => toBase64Url(crypto.getRandomValues(new Uint8Array(32)));

export async function createConnectAuthCode(
  db: D1Database,
  params: {
    accountId: string;
    clientId: ConnectClientId;
    redirectUri: string;
    codeChallenge: string;
    now?: number;
  },
) {
  const now = params.now ?? Date.now();
  const code = randomToken();
  const codeHash = await sha256Hex(code);
  const expiresAt = now + CONNECT_AUTH_CODE_MS;
  await db.batch([
    db.prepare("DELETE FROM connect_auth_codes WHERE expires_at <= ?").bind(now),
    db
      .prepare(
        "INSERT INTO connect_auth_codes (code_hash, account_id, client_id, redirect_uri, code_challenge, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(
        codeHash,
        params.accountId,
        params.clientId,
        params.redirectUri,
        params.codeChallenge,
        expiresAt,
      ),
  ]);
  return { code, expiresAt };
}

export async function exchangeConnectAuthCode(
  db: D1Database,
  params: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
    now?: number;
  },
) {
  const now = params.now ?? Date.now();
  const codeHash = await sha256Hex(params.code);
  const row = await db
    .prepare(
      "SELECT account_id, client_id, redirect_uri, code_challenge, expires_at FROM connect_auth_codes WHERE code_hash = ?",
    )
    .bind(codeHash)
    .first<{
      account_id: string;
      client_id: string;
      redirect_uri: string;
      code_challenge: string;
      expires_at: number;
    }>();
  if (!row || row.expires_at <= now || row.redirect_uri !== params.redirectUri) {
    return null;
  }
  const expectedChallenge = await sha256Base64Url(params.codeVerifier);
  if (expectedChallenge !== row.code_challenge) return null;

  const consumed = await db
    .prepare("DELETE FROM connect_auth_codes WHERE code_hash = ? AND expires_at > ?")
    .bind(codeHash, now)
    .run();
  if (!consumed.meta.changes) return null;

  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const expiresAt = now + CONNECT_CLIENT_TOKEN_MS;
  await db.batch([
    db.prepare("DELETE FROM connect_client_tokens WHERE expires_at <= ?").bind(now),
    db
      .prepare(
        "INSERT INTO connect_client_tokens (token_hash, account_id, client_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(tokenHash, row.account_id, row.client_id, now, expiresAt),
  ]);
  return { token, expiresAt, accountId: row.account_id };
}

export async function resolveConnectClientAccount(
  db: D1Database,
  token: string,
  now = Date.now(),
): Promise<string | null> {
  const row = await db
    .prepare("SELECT account_id FROM connect_client_tokens WHERE token_hash = ? AND expires_at > ?")
    .bind(await sha256Hex(token), now)
    .first<string>("account_id");
  return row ?? null;
}

export async function revokeConnectClientToken(db: D1Database, token: string) {
  await db
    .prepare("DELETE FROM connect_client_tokens WHERE token_hash = ?")
    .bind(await sha256Hex(token))
    .run();
}

async function isWithinHouseholdCap(
  db: D1Database,
  instanceId: string,
  ownerAccountId: string,
  accountId: string,
): Promise<boolean> {
  if (accountId === ownerAccountId) return true;
  const allowed = await db
    .prepare(
      `SELECT account_id
       FROM links
       WHERE instance_id = ? AND account_id IS NOT NULL AND account_id != ?
       GROUP BY account_id
       ORDER BY MIN(linked_at) ASC, account_id ASC
       LIMIT ?`,
    )
    .bind(instanceId, ownerAccountId, CONNECT_MAX_USERS_PER_SERVER - 1)
    .all<{ account_id: string }>();
  return allowed.results.some((entry) => entry.account_id === accountId);
}

export async function discoverConnectServers(
  db: D1Database,
  params: { accountId: string; connectDomain: string; now?: number },
) {
  const now = params.now ?? Date.now();
  const [handle, entitlement, rows] = await Promise.all([
    handleOf(db, params.accountId),
    getEntitlement(db, params.accountId, now),
    db
      .prepare(
        `SELECT s.instance_id, s.owner_account_id, s.name, s.lan_hints, s.online, s.last_seen_at,
                sl.slug, e.status AS owner_status, e.current_period_end AS owner_period_end,
                l.user_name, l.linked_at
         FROM links l
         JOIN connect_servers s ON s.instance_id = l.instance_id
         JOIN connect_slugs sl ON sl.instance_id = s.instance_id
         LEFT JOIN connect_entitlements e ON e.account_id = s.owner_account_id
         WHERE l.account_id = ?
         ORDER BY l.linked_at DESC`,
      )
      .bind(params.accountId)
      .all<{
        instance_id: string;
        owner_account_id: string;
        name: string;
        lan_hints: string;
        online: number;
        last_seen_at: number | null;
        slug: string;
        owner_status: string | null;
        owner_period_end: number | null;
        user_name: string;
        linked_at: number;
      }>(),
  ]);

  const seen = new Set<string>();
  const servers = [];
  for (const row of rows.results) {
    if (seen.has(row.instance_id)) continue;
    seen.add(row.instance_id);
    if (
      !isEntitlementActive(
        row.owner_status
          ? { status: row.owner_status, current_period_end: row.owner_period_end }
          : null,
        now,
      )
    ) {
      continue;
    }
    if (
      !(await isWithinHouseholdCap(db, row.instance_id, row.owner_account_id, params.accountId))
    ) {
      continue;
    }
    servers.push({
      instanceId: row.instance_id,
      name: row.name,
      slug: row.slug,
      connectUrl: connectOriginFor(row.slug, params.connectDomain),
      lanHints: parseLanHints(row.lan_hints),
      localUserName: row.user_name,
      online: row.online === 1,
      lastSeenAt: row.last_seen_at,
      isOwner: row.owner_account_id === params.accountId,
    });
  }

  return {
    account: { id: params.accountId, handle },
    entitlement,
    servers,
  };
}

export async function issueConnectAssertion(
  db: D1Database,
  params: {
    accountId: string;
    instanceId: string;
    signingKey: string | undefined;
    hubOrigin: string;
    connectDomain: string;
    now?: number;
  },
) {
  if (!params.signingKey) return { ok: false as const, error: "connect_unconfigured" as const };
  const now = params.now ?? Date.now();
  const [handle, row] = await Promise.all([
    handleOf(db, params.accountId),
    db
      .prepare(
        `SELECT s.instance_id, s.owner_account_id, sl.slug, e.status AS owner_status,
                e.current_period_end AS owner_period_end
         FROM links l
         JOIN connect_servers s ON s.instance_id = l.instance_id
         JOIN connect_slugs sl ON sl.instance_id = s.instance_id
         LEFT JOIN connect_entitlements e ON e.account_id = s.owner_account_id
         WHERE l.account_id = ? AND l.instance_id = ?
         LIMIT 1`,
      )
      .bind(params.accountId, params.instanceId)
      .first<{
        instance_id: string;
        owner_account_id: string;
        slug: string;
        owner_status: string | null;
        owner_period_end: number | null;
      }>(),
  ]);
  if (!handle) return { ok: false as const, error: "handle_required" as const };
  if (!row) return { ok: false as const, error: "server_not_linked" as const };
  if (
    !isEntitlementActive(
      row.owner_status
        ? { status: row.owner_status, current_period_end: row.owner_period_end }
        : null,
      now,
    )
  ) {
    return { ok: false as const, error: "subscription_required" as const };
  }
  if (!(await isWithinHouseholdCap(db, row.instance_id, row.owner_account_id, params.accountId))) {
    return { ok: false as const, error: "server_user_limit_reached" as const };
  }

  const iat = Math.floor(now / 1000);
  const exp = Math.floor((now + CONNECT_ASSERTION_TTL_MS) / 1000);
  const token = await signConnectToken(params.signingKey, {
    typ: "aurral-connect-auth" as const,
    iss: params.hubOrigin,
    aud: row.instance_id,
    sub: params.accountId,
    handle,
    jti: crypto.randomUUID(),
    iat,
    exp,
  });
  return {
    ok: true as const,
    token,
    expiresAt: exp * 1000,
    connectUrl: connectOriginFor(row.slug, params.connectDomain),
  };
}

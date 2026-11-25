import {
  parseAuthAssertion,
  parseConnectJwks,
  verifyConnectToken,
  type ConnectPublicJwk,
} from "../../../lib/connectTokens.ts";
import { createSession } from "../../config/session-helpers.ts";
import { userOps } from "../../db/helpers/index.ts";
import { buildPermissions } from "../auth.ts";
import { findUserIdByHubAccountId, hubLinksEnabled, hubRequest } from "../hubLink.ts";
import { getShareInstance, SHARE_ORIGIN } from "../shareLinks/store.ts";
import { getConnectConfig } from "./connectStore.ts";

const JWKS_TTL_MS = 60 * 60 * 1000;
const JWKS_MIN_REFRESH_MS = 30 * 1000;
const MAX_TRACKED_JTIS = 5000;

let cachedKeys: { origin: string; fetchedAt: number; keys: ConnectPublicJwk[] } | null = null;
const usedJtis = new Map<string, number>();

export class ConnectAuthError extends Error {
  status: 401 | 403 | 409 | 502 | 503;
  code: string;

  constructor(status: 401 | 403 | 409 | 502 | 503, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function resetConnectAuthCache() {
  cachedKeys = null;
  usedJtis.clear();
}

function pruneExpiredJtis(now: number) {
  for (const [jti, expiresAt] of usedJtis) {
    if (expiresAt <= now) usedJtis.delete(jti);
  }
}

async function fetchConnectKeys(origin: string, force = false): Promise<ConnectPublicJwk[]> {
  const now = Date.now();
  if (
    !force &&
    cachedKeys &&
    cachedKeys.origin === origin &&
    cachedKeys.keys.length > 0 &&
    now - cachedKeys.fetchedAt < JWKS_TTL_MS
  ) {
    return cachedKeys.keys;
  }
  if (
    force &&
    cachedKeys &&
    cachedKeys.origin === origin &&
    cachedKeys.keys.length > 0 &&
    now - cachedKeys.fetchedAt < JWKS_MIN_REFRESH_MS
  ) {
    return cachedKeys.keys;
  }
  const response = await hubRequest(origin, "/v1/connect/keys").catch(() => null);
  if (!response?.ok) {
    if (cachedKeys?.origin === origin && cachedKeys.keys.length > 0) return cachedKeys.keys;
    throw new ConnectAuthError(
      502,
      "hub_unreachable",
      "Couldn't reach aurral.org to verify sign-in.",
    );
  }
  const parsed = parseConnectJwks(await response.json().catch(() => null));
  if (!parsed) {
    throw new ConnectAuthError(
      502,
      "hub_invalid_keys",
      "Received invalid signing keys from aurral.org.",
    );
  }
  cachedKeys = { origin, fetchedAt: now, keys: parsed.keys };
  return parsed.keys;
}

export async function exchangeConnectAssertion(
  assertion: string,
  meta: { ip: string | null; userAgent: string | null },
) {
  const config = getConnectConfig();
  if (!config.enabled || !config.allowHubSignIn || !hubLinksEnabled()) {
    throw new ConnectAuthError(
      403,
      "connect_sign_in_disabled",
      "Sign in with Aurral is turned off on this server.",
    );
  }

  const origin = config.hubOrigin || SHARE_ORIGIN;
  const instanceId = getShareInstance().id;
  const keys = await fetchConnectKeys(origin, false);
  let verified = await verifyConnectToken(assertion, keys, parseAuthAssertion, {
    expectedIss: origin,
    expectedAud: instanceId,
  });
  if (!verified) {
    const refreshed = await fetchConnectKeys(origin, true);
    verified = await verifyConnectToken(assertion, refreshed, parseAuthAssertion, {
      expectedIss: origin,
      expectedAud: instanceId,
    });
  }
  if (!verified) {
    throw new ConnectAuthError(
      401,
      "invalid_assertion",
      "That Aurral sign-in token is invalid or expired.",
    );
  }

  const now = Date.now();
  pruneExpiredJtis(now);
  if (usedJtis.has(verified.jti)) {
    throw new ConnectAuthError(
      401,
      "assertion_reused",
      "That Aurral sign-in token was already used.",
    );
  }
  if (usedJtis.size >= MAX_TRACKED_JTIS) {
    throw new ConnectAuthError(
      503,
      "connect_busy",
      "Too many recent sign-in attempts. Try again in a minute.",
    );
  }
  usedJtis.set(verified.jti, verified.exp * 1000 + 60_000);

  const lookup = findUserIdByHubAccountId(origin, verified.sub);
  if (lookup.kind === "ambiguous") {
    throw new ConnectAuthError(
      409,
      "ambiguous_account_link",
      "More than one local user on this server is linked to this aurral.org account.",
    );
  }
  const user = lookup.kind === "matched" ? userOps.getUserById(lookup.userId) : null;
  if (!user || user.status !== "active") {
    throw new ConnectAuthError(
      403,
      "account_not_linked",
      "This aurral.org account isn't linked to an active user on this server.",
    );
  }

  const session = createSession(user.id, meta.ip, meta.userAgent, { reauthenticated: false });
  return {
    token: session.token,
    expiresAt: session.expiresAt,
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      permissions: buildPermissions(user.role, user.permissions),
    },
  };
}

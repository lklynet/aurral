import * as client from "openid-client";
import type { IDToken, UserInfoResponse } from "openid-client";
import { db } from "../config/db-sqlite.ts";
import { createSession } from "../config/session-helpers.ts";
import { createSystemProvisionedUser, toResolvedUser } from "../middleware/auth.ts";
import { userOps, userIdentityOps } from "../db/helpers/index.ts";

const STATE_TTL_MS = 10 * 60 * 1000;
const EXCHANGE_TTL_MS = 60 * 1000;
const OIDC_TRANSACTION_COOKIE = "aurral_oidc_transaction";
type DiscoveryConfig = Awaited<ReturnType<typeof client.discovery>>;
type OidcTokens = Awaited<ReturnType<typeof client.authorizationCodeGrant>>;
type OidcClaims = Partial<IDToken & UserInfoResponse>;

const pendingLogins = new Map<
  string,
  {
    codeVerifier: string;
    nonce: string;
    transactionId: string;
    expiresAt: number;
    mode: "login" | "link";
    linkUserId: number | null;
  }
>();
const pendingExchanges = new Map<
  string,
  {
    expiresAt: number;
    transactionId: string;
    linked: boolean;
    user: ReturnType<typeof toResolvedUser>;
  }
>();
let discoveryConfig: DiscoveryConfig | null = null;
let discoveryKey = "";

function parseCsv(value: string | undefined) {
  if (!value) return [];
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function prunePendingLogins(now = Date.now()) {
  for (const [state, entry] of pendingLogins) {
    if (!entry || entry.expiresAt <= now) pendingLogins.delete(state);
  }
}

function prunePendingExchanges(now = Date.now()) {
  for (const [code, entry] of pendingExchanges) {
    if (!entry || entry.expiresAt <= now) pendingExchanges.delete(code);
  }
}

export type ExchangeRequest = {
  cookie: string | undefined;
  ip: string | null;
  userAgent: string | null;
};

function getTransactionCookie(cookieHeader: string | undefined) {
  const cookies = String(cookieHeader || "").split(";");
  for (const cookie of cookies) {
    const [name, ...parts] = cookie.trim().split("=");
    if (name !== OIDC_TRANSACTION_COOKIE) continue;
    try {
      return decodeURIComponent(parts.join("="));
    } catch {
      return "";
    }
  }
  return "";
}

function transactionCookie(value: string, secure: boolean, maxAge?: number) {
  const attributes = [
    `${OIDC_TRANSACTION_COOKIE}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (secure) attributes.push("Secure");
  if (maxAge != null) attributes.push(`Max-Age=${maxAge}`);
  return attributes.join("; ");
}

function getRequiredConfig() {
  const issuer = String(process.env.OIDC_ISSUER || "").trim();
  const clientId = String(process.env.OIDC_CLIENT_ID || "").trim();
  const clientSecret = String(process.env.OIDC_CLIENT_SECRET || "").trim();
  const redirectUri = String(process.env.OIDC_REDIRECT_URI || "").trim();
  const secretRequired = getTokenEndpointAuthMethod() !== "none";
  if (!issuer || !clientId || (secretRequired && !clientSecret) || !redirectUri) return null;
  return { issuer, clientId, clientSecret, redirectUri };
}

export function isOidcEnabled() {
  if (process.env.OIDC_ENABLED !== "true") return false;
  return !!getRequiredConfig();
}

export function getOidcBootstrapInfo() {
  if (!isOidcEnabled()) {
    return {
      oidcEnabled: false,
      oidcLogoutUrl: null,
    };
  }
  return {
    oidcEnabled: true,
    oidcLogoutUrl: process.env.OIDC_LOGOUT_URL || null,
  };
}

function getScopes() {
  const scopes = String(process.env.OIDC_SCOPES || "openid profile email")
    .trim()
    .replace(/\s+/g, " ");
  return scopes || "openid profile email";
}

function getUsernameClaim() {
  return (
    String(process.env.OIDC_USERNAME_CLAIM || "preferred_username").trim() || "preferred_username"
  );
}

function getGroupsClaim() {
  return String(process.env.OIDC_GROUPS_CLAIM || "").trim();
}

function getTokenEndpointAuthMethod() {
  const method = String(process.env.OIDC_TOKEN_ENDPOINT_AUTH_METHOD || "client_secret_basic")
    .trim()
    .toLowerCase();
  return method || "client_secret_basic";
}

function buildClientAuthentication(method: string, clientSecret: string) {
  switch (method) {
    case "client_secret_post":
      return client.ClientSecretPost(clientSecret);
    case "none":
      return client.None();
    case "client_secret_basic":
      return client.ClientSecretBasic(clientSecret);
    default:
      throw new Error(
        `Unsupported OIDC_TOKEN_ENDPOINT_AUTH_METHOD "${method}" (expected client_secret_basic, client_secret_post, or none)`,
      );
  }
}

function generateUniqueUsername(base: string) {
  const trimmed = String(base || "")
    .trim()
    .toLowerCase();
  if (!trimmed) return trimmed;
  if (!userOps.getUserByUsername(trimmed)) return trimmed;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${trimmed}-${suffix}`;
    if (!userOps.getUserByUsername(candidate)) return candidate;
  }
  throw new Error("Could not generate a unique username for OIDC provisioning");
}

function normalizeGroups(value: unknown) {
  if (Array.isArray(value)) {
    return value
      .map((item) =>
        String(item || "")
          .trim()
          .toLowerCase(),
      )
      .filter(Boolean);
  }
  if (value == null) return [];
  return String(value)
    .split(/[,\s]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

export function resolveOidcRole(username: string | null | undefined, claims: OidcClaims = {}) {
  const adminUsers = parseCsv(process.env.OIDC_ADMIN_USERS).map((u) => u.toLowerCase());
  if (adminUsers.includes(String(username || "").toLowerCase())) return "admin";

  const groupsClaim = getGroupsClaim();
  if (groupsClaim) {
    const groups = normalizeGroups(claims[groupsClaim]);
    const adminGroups = parseCsv(process.env.OIDC_ADMIN_GROUPS).map((g) => g.toLowerCase());
    if (groups.some((g) => adminGroups.includes(g))) return "admin";
  }

  return (process.env.OIDC_DEFAULT_ROLE || "user").trim().toLowerCase() === "admin"
    ? "admin"
    : "user";
}

export function resolveOidcUsername(claims: OidcClaims = {}) {
  const claimName = getUsernameClaim();
  const primary = String(claims[claimName] || "").trim();
  if (primary) return primary.toLowerCase();
  const email = String(claims.email || "").trim();
  if (email) return email.toLowerCase();
  return "";
}

async function fetchEffectiveClaims(oidc: DiscoveryConfig, tokens: OidcTokens, claims: OidcClaims) {
  if (!claims.sub || !tokens.access_token) return claims;

  try {
    const userInfo = await client.fetchUserInfo(oidc, tokens.access_token, claims.sub);
    const effectiveClaims = { ...claims, ...userInfo };
    const groupsClaim = getGroupsClaim();
    if (groupsClaim) {
      effectiveClaims[groupsClaim] = claims[groupsClaim];
    }
    return effectiveClaims;
  } catch {
    return claims;
  }
}

async function getDiscoveryConfig() {
  const config = getRequiredConfig();
  if (!config) {
    throw new Error("OIDC is not configured");
  }
  const authMethod = getTokenEndpointAuthMethod();
  const key = `${config.issuer}|${config.clientId}|${config.clientSecret}|${config.redirectUri}|${authMethod}`;
  if (discoveryConfig && discoveryKey === key) return { config, oidc: discoveryConfig };
  const issuerUrl = new URL(config.issuer);
  const discoveryOptions =
    issuerUrl.protocol === "http:" ? { execute: [client.allowInsecureRequests] } : undefined;
  discoveryConfig = await client.discovery(
    issuerUrl,
    config.clientId,
    config.clientSecret,
    buildClientAuthentication(authMethod, config.clientSecret),
    discoveryOptions,
  );
  discoveryKey = key;
  return { config, oidc: discoveryConfig };
}

function toDisplayName(claims: OidcClaims) {
  return resolveOidcUsername(claims) || String(claims.email || "").trim() || null;
}

function resolveOidcSessionUser(config: { issuer: string }, claims: OidcClaims) {
  const subject = String(claims.sub || "").trim();
  if (!subject) {
    throw Object.assign(new Error("OIDC identity did not include a usable subject"), {
      status: 400,
    });
  }

  const existingIdentity = userIdentityOps.findByProvider("oidc", config.issuer, subject);
  if (existingIdentity) {
    const user = userOps.getUserById(existingIdentity.userId);
    if (!user) {
      throw Object.assign(new Error("Linked OIDC identity has no matching user"), {
        status: 500,
      });
    }
    if (user.status !== "active") {
      throw Object.assign(new Error("This account has been suspended or disabled"), {
        status: 403,
      });
    }
    if (user.isProtected) {
      return toResolvedUser(user);
    }
    const role = resolveOidcRole(resolveOidcUsername(claims) || user.username, claims);
    if (role !== user.role || user.roleSource !== "oidc") {
      userOps.updateUser(user.id, { role, roleSource: "oidc" });
      return toResolvedUser(userOps.getUserById(user.id));
    }
    return toResolvedUser(user);
  }

  const baseUsername = resolveOidcUsername(claims);
  if (!baseUsername) {
    throw Object.assign(new Error("OIDC identity did not include a usable username"), {
      status: 400,
    });
  }

  const role = resolveOidcRole(baseUsername, claims);

  const legacyMatch = userOps.getUserByUsername(baseUsername);
  if (
    legacyMatch &&
    legacyMatch.allowIdentityAdoption &&
    legacyMatch.needsIdentityMigration &&
    legacyMatch.status === "active" &&
    !legacyMatch.isProtected &&
    userIdentityOps.countForUser(legacyMatch.id) === 0
  ) {
    const adoptUser = db.transaction(() => {
      userOps.updateUser(legacyMatch.id, {
        role,
        roleSource: "oidc",
        needsIdentityMigration: false,
        allowIdentityAdoption: false,
      });
      userIdentityOps.link(legacyMatch.id, {
        providerType: "oidc",
        providerKey: config.issuer,
        subject,
        displayName: toDisplayName(claims),
      });
      return userOps.getUserById(legacyMatch.id);
    });
    return toResolvedUser(adoptUser());
  }

  const uniqueUsername = generateUniqueUsername(baseUsername);
  const provisionUser = db.transaction(() => {
    const created = createSystemProvisionedUser(uniqueUsername, role);
    if (!created?.id || created.id < 0) {
      throw Object.assign(new Error("Failed to provision OIDC user"), { status: 500 });
    }
    userOps.updateUser(created.id, { roleSource: "oidc" });
    userIdentityOps.link(created.id, {
      providerType: "oidc",
      providerKey: config.issuer,
      subject,
      displayName: toDisplayName(claims),
    });
    return userOps.getUserById(created.id);
  });
  return toResolvedUser(provisionUser());
}

function buildCallbackUrl(query: Record<string, string>) {
  const redirectUri = getRequiredConfig()?.redirectUri;
  if (!redirectUri) throw new Error("OIDC_REDIRECT_URI is required");
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url;
}

export async function startOidcLogin({
  mode = "login",
  linkUserId = null,
  secure = false,
}: { mode?: "login" | "link"; linkUserId?: number | null; secure?: boolean } = {}) {
  if (!isOidcEnabled()) return null;

  const { config, oidc } = await getDiscoveryConfig();
  const codeVerifier = client.randomPKCECodeVerifier();
  const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
  const state = client.randomState();
  const nonce = client.randomNonce();
  const transactionId = client.randomState();

  prunePendingLogins();
  pendingLogins.set(state, {
    codeVerifier,
    nonce,
    transactionId,
    expiresAt: Date.now() + STATE_TTL_MS,
    mode,
    linkUserId,
  });

  const parameters = {
    redirect_uri: config.redirectUri,
    scope: getScopes(),
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
    nonce,
  };

  const redirectTo = client.buildAuthorizationUrl(oidc, parameters);
  return { authUrl: redirectTo.href, cookie: transactionCookie(transactionId, secure) };
}

function linkOidcIdentity(
  config: { issuer: string },
  claims: OidcClaims,
  linkUserId: number | null,
) {
  const linkUser = userOps.getUserById(linkUserId);
  if (!linkUser) {
    throw Object.assign(new Error("Linking user no longer exists"), { status: 400 });
  }
  if (linkUser.status !== "active") {
    throw Object.assign(new Error("This account has been suspended or disabled"), { status: 403 });
  }
  const subject = String(claims.sub || "").trim();
  if (!subject) {
    throw Object.assign(new Error("OIDC identity did not include a usable subject"), {
      status: 400,
    });
  }
  const existing = userIdentityOps.findByProvider("oidc", config.issuer, subject);
  if (existing && existing.userId !== linkUser.id) {
    throw Object.assign(
      new Error("This single sign-on account is already linked to another user"),
      {
        status: 409,
      },
    );
  }
  if (!existing) {
    db.transaction(() => {
      userIdentityOps.link(linkUser.id, {
        providerType: "oidc",
        providerKey: config.issuer,
        subject,
        displayName: toDisplayName(claims),
      });
      userOps.updateUser(linkUser.id, {
        needsIdentityMigration: false,
        allowIdentityAdoption: false,
      });
    })();
  }
  return toResolvedUser(userOps.getUserById(linkUser.id));
}

export async function handleOidcCallback(
  query: Record<string, string>,
  cookie: string | undefined,
) {
  if (!isOidcEnabled()) {
    throw Object.assign(new Error("OIDC is not enabled"), { status: 404 });
  }

  const state = query.state || "";
  const transactionId = getTransactionCookie(cookie);
  prunePendingLogins();
  const pending = pendingLogins.get(state);
  pendingLogins.delete(state);
  if (!pending || pending.expiresAt <= Date.now() || pending.transactionId !== transactionId) {
    throw Object.assign(new Error("OIDC login session expired"), { status: 400 });
  }

  const { config, oidc } = await getDiscoveryConfig();
  const tokens = await client.authorizationCodeGrant(oidc, buildCallbackUrl(query), {
    pkceCodeVerifier: pending.codeVerifier,
    expectedState: state,
    expectedNonce: pending.nonce,
    idTokenExpected: true,
  });

  const claims = await fetchEffectiveClaims(oidc, tokens, tokens.claims() || {});
  const linked = pending.mode === "link";
  const user = linked
    ? linkOidcIdentity(config, claims, pending.linkUserId)
    : resolveOidcSessionUser(config, claims);

  const code = client.randomState();
  prunePendingExchanges();
  pendingExchanges.set(code, {
    expiresAt: Date.now() + EXCHANGE_TTL_MS,
    transactionId,
    linked,
    user,
  });
  return {
    code,
    linked,
    user,
  };
}

export function exchangeOidcCallback(code: string | null | undefined, request: ExchangeRequest) {
  if (!isOidcEnabled()) {
    throw Object.assign(new Error("OIDC is not enabled"), { status: 404 });
  }

  const transactionId = getTransactionCookie(request.cookie);
  const exchangeCode = String(code || "");
  prunePendingExchanges();
  const pending = pendingExchanges.get(exchangeCode);
  if (!pending || pending.expiresAt <= Date.now() || pending.transactionId !== transactionId) {
    throw Object.assign(new Error("OIDC login session expired"), { status: 400 });
  }

  pendingExchanges.delete(exchangeCode);
  if (pending.linked) {
    return { linked: true, user: pending.user };
  }
  const session = createSession(pending.user!.id, request.ip, request.userAgent);
  return {
    linked: false,
    token: session.token,
    expiresAt: session.expiresAt,
    user: pending.user,
  };
}

export const clearedOidcTransactionCookie = (secure: boolean) => transactionCookie("", secure, 0);

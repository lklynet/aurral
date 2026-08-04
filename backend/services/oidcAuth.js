import * as client from "openid-client";
import { createSession } from "../config/session-helpers.js";
import { ensureExternalUser } from "../middleware/auth.js";

const STATE_TTL_MS = 10 * 60 * 1000;
const EXCHANGE_TTL_MS = 60 * 1000;
const OIDC_TRANSACTION_COOKIE = "aurral_oidc_transaction";
const pendingLogins = new Map();
const pendingExchanges = new Map();
let discoveryConfig = null;
let discoveryKey = "";

function parseCsv(value) {
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

function getTransactionCookie(req) {
  const cookies = String(req.headers?.cookie || "").split(";");
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

function setTransactionCookie(req, res, value, maxAge) {
  const secure = req.secure || req.protocol === "https";
  const attributes = [
    `${OIDC_TRANSACTION_COOKIE}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (secure) attributes.push("Secure");
  if (maxAge != null) attributes.push(`Max-Age=${maxAge}`);
  res.setHeader("Set-Cookie", attributes.join("; "));
}

function getRequiredConfig() {
  const issuer = String(process.env.OIDC_ISSUER || "").trim();
  const clientId = String(process.env.OIDC_CLIENT_ID || "").trim();
  const clientSecret = String(process.env.OIDC_CLIENT_SECRET || "").trim();
  const redirectUri = String(process.env.OIDC_REDIRECT_URI || "").trim();
  if (!issuer || !clientId || !clientSecret || !redirectUri) return null;
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
  return String(process.env.OIDC_USERNAME_CLAIM || "preferred_username").trim() || "preferred_username";
}

function getGroupsClaim() {
  return String(process.env.OIDC_GROUPS_CLAIM || "").trim();
}

function normalizeGroups(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || "").trim().toLowerCase()).filter(Boolean);
  }
  if (value == null) return [];
  return String(value)
    .split(/[,\s]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

export function resolveOidcRole(username, claims = {}) {
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

export function resolveOidcUsername(claims = {}) {
  const claimName = getUsernameClaim();
  const primary = String(claims[claimName] || "").trim();
  if (primary) return primary.toLowerCase();
  const email = String(claims.email || "").trim();
  if (email) return email.toLowerCase();
  return "";
}

async function getDiscoveryConfig() {
  const config = getRequiredConfig();
  if (!config) {
    throw new Error("OIDC is not configured");
  }
  const key = `${config.issuer}|${config.clientId}|${config.clientSecret}|${config.redirectUri}`;
  if (discoveryConfig && discoveryKey === key) return { config, oidc: discoveryConfig };
  const issuerUrl = new URL(config.issuer);
  const discoveryOptions =
    issuerUrl.protocol === "http:" ? { execute: [client.allowInsecureRequests] } : undefined;
  discoveryConfig = await client.discovery(
    issuerUrl,
    config.clientId,
    config.clientSecret,
    undefined,
    discoveryOptions,
  );
  discoveryKey = key;
  return { config, oidc: discoveryConfig };
}

function buildCallbackUrl(req) {
  const redirectUri = getRequiredConfig()?.redirectUri;
  if (!redirectUri) throw new Error("OIDC_REDIRECT_URI is required");
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(req.query || {})) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      if (value[0] != null) url.searchParams.set(key, String(value[0]));
      continue;
    }
    url.searchParams.set(key, String(value));
  }
  return url;
}

export async function startOidcLogin(req, res) {
  if (!isOidcEnabled()) {
    res.status(404).json({ error: "OIDC is not enabled" });
    return;
  }

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
  setTransactionCookie(req, res, transactionId);
  res.redirect(302, redirectTo.href);
}

export async function handleOidcCallback(req) {
  if (!isOidcEnabled()) {
    throw Object.assign(new Error("OIDC is not enabled"), { status: 404 });
  }

  const state = String(req.query?.state || "");
  const transactionId = getTransactionCookie(req);
  prunePendingLogins();
  const pending = pendingLogins.get(state);
  pendingLogins.delete(state);
  if (!pending || pending.expiresAt <= Date.now() || pending.transactionId !== transactionId) {
    throw Object.assign(new Error("OIDC login session expired"), { status: 400 });
  }

  const { oidc } = await getDiscoveryConfig();
  const tokens = await client.authorizationCodeGrant(oidc, buildCallbackUrl(req), {
    pkceCodeVerifier: pending.codeVerifier,
    expectedState: state,
    expectedNonce: pending.nonce,
    idTokenExpected: true,
  });

  const claims = tokens.claims() || {};
  const username = resolveOidcUsername(claims);
  if (!username) {
    throw Object.assign(new Error("OIDC identity did not include a usable username"), {
      status: 400,
    });
  }

  const role = resolveOidcRole(username, claims);
  const user = ensureExternalUser(username, role);
  if (!user?.id || user.id < 0) {
    throw Object.assign(new Error("Failed to provision OIDC user"), { status: 500 });
  }

  const code = client.randomState();
  prunePendingExchanges();
  pendingExchanges.set(code, {
    expiresAt: Date.now() + EXCHANGE_TTL_MS,
    transactionId,
    user,
  });
  return {
    code,
    user,
  };
}

export function exchangeOidcCallback(code, req) {
  if (!isOidcEnabled()) {
    throw Object.assign(new Error("OIDC is not enabled"), { status: 404 });
  }

  const transactionId = getTransactionCookie(req);
  const exchangeCode = String(code || "");
  prunePendingExchanges();
  const pending = pendingExchanges.get(exchangeCode);
  if (!pending || pending.expiresAt <= Date.now() || pending.transactionId !== transactionId) {
    throw Object.assign(new Error("OIDC login session expired"), { status: 400 });
  }

  pendingExchanges.delete(exchangeCode);
  const session = createSession(pending.user.id, req.ip || null, req.headers["user-agent"] || null);
  return {
    token: session.token,
    expiresAt: session.expiresAt,
    user: pending.user,
  };
}

export function clearOidcTransactionCookie(req, res) {
  setTransactionCookie(req, res, "", 0);
}

export function resetOidcStateForTests() {
  pendingLogins.clear();
  pendingExchanges.clear();
  discoveryConfig = null;
  discoveryKey = "";
}

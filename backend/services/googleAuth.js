import * as client from "openid-client";
import { createSession } from "../config/session-helpers.js";
import { toResolvedUser } from "../middleware/auth.js";
import { dbOps, userOps, userIdentityOps } from "../db/helpers/index.js";

const REAL_GOOGLE_ISSUER = "https://accounts.google.com";
const STATE_TTL_MS = 10 * 60 * 1000;
const EXCHANGE_TTL_MS = 60 * 1000;
const TRANSACTION_COOKIE = "aurral_google_transaction";
const pendingLogins = new Map();
const pendingExchanges = new Map();
let discoveryConfig = null;
let discoveryKey = "";
let issuerOverride = null;

// Test-only escape hatch: production always resolves discovery against the
// real Google issuer, but tests need to point it at a local mock server.
export function setGoogleIssuerForTests(issuerUrl) {
  issuerOverride = issuerUrl || null;
  discoveryConfig = null;
  discoveryKey = "";
}

function getGoogleIssuer() {
  return issuerOverride || REAL_GOOGLE_ISSUER;
}

function getGoogleConfig() {
  const google = dbOps.getSettings()?.integrations?.google || {};
  const enabled = google.enabled === true;
  const clientId = String(google.clientId || "").trim();
  const clientSecret = String(google.clientSecret || "").trim();
  const redirectUri = String(google.redirectUri || "").trim();
  if (!enabled || !clientId || !clientSecret || !redirectUri) return null;
  return { clientId, clientSecret, redirectUri };
}

export function isGoogleLoginEnabled() {
  return !!getGoogleConfig();
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
    if (name !== TRANSACTION_COOKIE) continue;
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
    `${TRANSACTION_COOKIE}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (secure) attributes.push("Secure");
  if (maxAge != null) attributes.push(`Max-Age=${maxAge}`);
  res.setHeader("Set-Cookie", attributes.join("; "));
}

async function getDiscoveryConfig(config) {
  const key = `${config.clientId}|${config.clientSecret}`;
  if (discoveryConfig && discoveryKey === key) return discoveryConfig;
  const issuerUrl = new URL(getGoogleIssuer());
  const discoveryOptions =
    issuerUrl.protocol === "http:" ? { execute: [client.allowInsecureRequests] } : undefined;
  discoveryConfig = await client.discovery(
    issuerUrl,
    config.clientId,
    config.clientSecret,
    client.ClientSecretBasic(config.clientSecret),
    discoveryOptions,
  );
  discoveryKey = key;
  return discoveryConfig;
}

function buildCallbackUrl(req, redirectUri) {
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

// mode is either { mode: "login" } or { mode: "link", linkUserId }
export async function startGoogleAuth(req, res, mode) {
  const config = getGoogleConfig();
  if (!config) {
    res.status(404).json({ error: "Google login is not enabled" });
    return;
  }

  const oidc = await getDiscoveryConfig(config);
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
    mode: mode.mode,
    linkUserId: mode.linkUserId || null,
  });

  const parameters = {
    redirect_uri: config.redirectUri,
    scope: "openid email profile",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
    nonce,
  };

  const redirectTo = client.buildAuthorizationUrl(oidc, parameters);
  setTransactionCookie(req, res, transactionId);
  res.redirect(302, redirectTo.href);
}

export async function handleGoogleCallback(req) {
  const config = getGoogleConfig();
  if (!config) {
    throw Object.assign(new Error("Google login is not enabled"), { status: 404 });
  }

  const state = String(req.query?.state || "");
  const transactionId = getTransactionCookie(req);
  prunePendingLogins();
  const pending = pendingLogins.get(state);
  pendingLogins.delete(state);
  if (!pending || pending.expiresAt <= Date.now() || pending.transactionId !== transactionId) {
    throw Object.assign(new Error("Google login session expired"), { status: 400 });
  }

  const oidc = await getDiscoveryConfig(config);
  const tokens = await client.authorizationCodeGrant(oidc, buildCallbackUrl(req, config.redirectUri), {
    pkceCodeVerifier: pending.codeVerifier,
    expectedState: state,
    expectedNonce: pending.nonce,
    idTokenExpected: true,
  });

  const claims = tokens.claims() || {};
  const subject = String(claims.sub || "").trim();
  if (!subject) {
    throw Object.assign(new Error("Google identity did not include a usable subject"), {
      status: 400,
    });
  }
  const displayName = String(claims.email || claims.name || "").trim() || null;

  let result;
  if (pending.mode === "link") {
    const linkUser = userOps.getUserById(pending.linkUserId);
    if (!linkUser) {
      throw Object.assign(new Error("Linking user no longer exists"), { status: 400 });
    }
    if (linkUser.status !== "active") {
      throw Object.assign(new Error("This account has been suspended or disabled"), {
        status: 403,
      });
    }
    const existingIdentity = userIdentityOps.findByProvider("google", "google", subject);
    if (existingIdentity && existingIdentity.userId !== linkUser.id) {
      throw Object.assign(new Error("This Google account is already linked to another user"), {
        status: 409,
      });
    }
    if (!existingIdentity) {
      userIdentityOps.link(linkUser.id, {
        providerType: "google",
        providerKey: "google",
        subject,
        displayName,
      });
    }
    result = { linked: true, user: toResolvedUser(linkUser) };
  } else {
    const identity = userIdentityOps.findByProvider("google", "google", subject);
    if (!identity) {
      throw Object.assign(
        new Error("This Google account isn't linked to an Aurral account yet. Sign in another way and link it in Settings."),
        { status: 403 },
      );
    }
    const user = userOps.getUserById(identity.userId);
    if (!user) {
      throw Object.assign(new Error("Linked Google identity has no matching user"), {
        status: 500,
      });
    }
    if (user.status !== "active") {
      throw Object.assign(new Error("This account has been suspended or disabled"), {
        status: 403,
      });
    }
    result = { linked: false, user: toResolvedUser(user) };
  }

  const code = client.randomState();
  prunePendingExchanges();
  pendingExchanges.set(code, {
    expiresAt: Date.now() + EXCHANGE_TTL_MS,
    transactionId,
    result,
  });
  return { code, ...result };
}

export function exchangeGoogleCallback(code, req) {
  const transactionId = getTransactionCookie(req);
  const exchangeCode = String(code || "");
  prunePendingExchanges();
  const pending = pendingExchanges.get(exchangeCode);
  if (!pending || pending.expiresAt <= Date.now() || pending.transactionId !== transactionId) {
    throw Object.assign(new Error("Google login session expired"), { status: 400 });
  }
  pendingExchanges.delete(exchangeCode);

  if (pending.result.linked) {
    return { linked: true, user: pending.result.user };
  }
  const session = createSession(
    pending.result.user.id,
    req.ip || null,
    req.headers["user-agent"] || null,
  );
  return {
    linked: false,
    token: session.token,
    expiresAt: session.expiresAt,
    user: pending.result.user,
  };
}

export function clearGoogleTransactionCookie(req, res) {
  setTransactionCookie(req, res, "", 0);
}

export function resetGoogleStateForTests() {
  pendingLogins.clear();
  pendingExchanges.clear();
  discoveryConfig = null;
  discoveryKey = "";
  issuerOverride = null;
}

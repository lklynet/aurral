import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { createSign, generateKeyPairSync } from "node:crypto";

import {
  createMockHttpServer,
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { db }, dbHelpers, authModule, sessionModule, oidcModule] =
  await setupIsolatedBackend(
    "oidc-auth",
    "backend/config/db-sqlite.js",
    "backend/db/helpers/index.js",
    "backend/middleware/auth.js",
    "backend/config/session-helpers.js",
    "backend/services/oidcAuth.js",
  );

const { dbOps, userOps } = dbHelpers;
const { ensureExternalUser, isAuthRequiredByConfig, isOidcAuthEnabled } = authModule;
const { createSession, getSessionByToken } = sessionModule;
const {
  exchangeOidcCallback,
  isOidcEnabled,
  resolveOidcUsername,
  resolveOidcRole,
  getOidcBootstrapInfo,
  handleOidcCallback,
  resetOidcStateForTests,
  startOidcLogin,
} = oidcModule;

const completeOnboarding = () => dbOps.updateSettings({ onboardingComplete: true });

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const oidcKey = { ...publicKey.export({ format: "jwk" }), kid: "test-key", use: "sig", alg: "RS256" };

const createIdToken = (issuer, nonce, claimOverrides = {}) => {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "RS256", kid: oidcKey.kid, typ: "JWT" });
  const payload = encode({
    iss: issuer,
    aud: "aurral",
    sub: "oidc-subject",
    preferred_username: "callback-user",
    nonce,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300,
    ...claimOverrides,
  });
  const input = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256").update(input).sign(privateKey).toString("base64url");
  return `${input}.${signature}`;
};

function resetOidcEnv() {
  delete process.env.OIDC_ENABLED;
  delete process.env.OIDC_ISSUER;
  delete process.env.OIDC_CLIENT_ID;
  delete process.env.OIDC_CLIENT_SECRET;
  delete process.env.OIDC_REDIRECT_URI;
  delete process.env.OIDC_SCOPES;
  delete process.env.OIDC_USERNAME_CLAIM;
  delete process.env.OIDC_DEFAULT_ROLE;
  delete process.env.OIDC_ADMIN_USERS;
  delete process.env.OIDC_GROUPS_CLAIM;
  delete process.env.OIDC_ADMIN_GROUPS;
  delete process.env.OIDC_LOGOUT_URL;
  delete process.env.AUTH_PROXY_ENABLED;
  delete process.env.AUTH_PROXY_HEADER;
  resetOidcStateForTests();
}

function enableOidcEnv(overrides = {}) {
  process.env.OIDC_ENABLED = "true";
  process.env.OIDC_ISSUER = "https://auth.example.com/application/o/aurral/";
  process.env.OIDC_CLIENT_ID = "aurral";
  process.env.OIDC_CLIENT_SECRET = "secret";
  process.env.OIDC_REDIRECT_URI = "https://aurral.example.com/sso/callback";
  Object.assign(process.env, overrides);
}

async function createPendingOidcLogin({ idTokenClaims = {}, userInfo = null, userInfoError = false } = {}) {
  let issuer;
  let nonce;
  const discoveryServer = await createMockHttpServer((request, response) => {
    if (request.url === "/jwks") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ keys: [oidcKey] }));
      return;
    }
    if (request.method === "POST" && request.url === "/token") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          access_token: "access-token",
          token_type: "Bearer",
          id_token: createIdToken(issuer, nonce, idTokenClaims),
        }),
      );
      return;
    }
    if (request.url === "/userinfo") {
      response.writeHead(userInfoError ? 500 : 200, { "content-type": "application/json" });
      response.end(JSON.stringify(userInfoError ? { error: "userinfo_unavailable" } : userInfo));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        issuer,
        authorization_endpoint: `${issuer}authorize`,
        token_endpoint: `${issuer}token`,
        ...(userInfo ? { userinfo_endpoint: `${issuer}userinfo` } : {}),
        jwks_uri: `${issuer}jwks`,
      }),
    );
  });
  issuer = `${discoveryServer.url}/`;
  enableOidcEnv({
    OIDC_ISSUER: issuer,
    OIDC_REDIRECT_URI: `${issuer}callback`,
  });

  const response = {
    headers: {},
    redirect(_status, location) {
      this.location = location;
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
  };
  await startOidcLogin({}, response);
  const redirect = new URL(response.location);
  const state = redirect.searchParams.get("state");
  nonce = redirect.searchParams.get("nonce");
  assert.ok(state, "OIDC login redirect must include state");
  const setCookie = response.headers["Set-Cookie"];
  assert.ok(setCookie, "OIDC login must set a transaction cookie");
  return {
    state,
    nonce,
    cookie: setCookie.split(";", 1)[0],
    close: discoveryServer.close,
  };
}

test.beforeEach(() => {
  resetDatabase(db);
  resetOidcEnv();
  dbOps.updateSettings({ onboardingComplete: false });
});

test.after(async () => {
  resetOidcEnv();
  await cleanupIsolatedState(isolatedState);
});

test("OIDC username prefers configured claim then email", () => {
  assert.equal(
    resolveOidcUsername({ preferred_username: "Alice", email: "alice@example.com" }),
    "alice",
  );
  assert.equal(resolveOidcUsername({ email: "Alice@example.com" }), "alice@example.com");

  process.env.OIDC_USERNAME_CLAIM = "nickname";
  assert.equal(resolveOidcUsername({ nickname: "Bob", email: "bob@example.com" }), "bob");
  assert.equal(resolveOidcUsername({}), "");
});

test("OIDC role mapping uses admin users and groups claim", () => {
  assert.equal(resolveOidcRole("carol", {}), "user");

  process.env.OIDC_ADMIN_USERS = "carol";
  assert.equal(resolveOidcRole("carol", {}), "admin");

  delete process.env.OIDC_ADMIN_USERS;
  process.env.OIDC_GROUPS_CLAIM = "groups";
  process.env.OIDC_ADMIN_GROUPS = "aurral-admins";
  assert.equal(resolveOidcRole("dave", { groups: ["users", "aurral-admins"] }), "admin");
  assert.equal(resolveOidcRole("erin", { groups: "users,aurral-admins" }), "admin");
  assert.equal(resolveOidcRole("frank", { groups: ["users"] }), "user");
  assert.equal(resolveOidcRole("gina", { groups: ["admin"] }), "user");

  process.env.OIDC_DEFAULT_ROLE = "admin";
  assert.equal(resolveOidcRole("hank", { groups: ["users"] }), "admin");
});

test("ensureExternalUser JIT-creates and re-syncs role", () => {
  const created = ensureExternalUser("oidc-user", "user");
  assert.ok(created);
  assert.equal(created.username, "oidc-user");
  assert.equal(created.role, "user");
  assert.equal(userOps.getAllUsers().length, 1);

  const promoted = ensureExternalUser("oidc-user", "admin");
  assert.equal(promoted.id, created.id);
  assert.equal(promoted.role, "admin");
  assert.equal(userOps.getUserByUsername("oidc-user")?.role, "admin");
  assert.equal(userOps.getAllUsers().length, 1);
});

test("OIDC enablement requires full config and marks auth required after onboarding", () => {
  process.env.OIDC_ENABLED = "true";
  assert.equal(isOidcEnabled(), false);
  assert.equal(getOidcBootstrapInfo().oidcEnabled, false);

  enableOidcEnv();
  assert.equal(isOidcEnabled(), true);
  assert.equal(isOidcAuthEnabled(), true);
  assert.equal(getOidcBootstrapInfo().oidcEnabled, true);

  assert.equal(isAuthRequiredByConfig(), false);
  completeOnboarding();
  assert.equal(isAuthRequiredByConfig(), true);
});

test("OIDC bootstrap exposes logout URL when configured", () => {
  enableOidcEnv({ OIDC_LOGOUT_URL: "https://auth.example.com/logout" });
  assert.deepEqual(getOidcBootstrapInfo(), {
    oidcEnabled: true,
    oidcLogoutUrl: "https://auth.example.com/logout",
  });
});

test("OIDC-provisioned users get normal Aurral sessions", () => {
  completeOnboarding();
  const user = ensureExternalUser("sso-erin", "user");
  const session = createSession(user.id, "127.0.0.1", "test-agent");
  assert.ok(session?.token);
  assert.equal(getSessionByToken(session.token)?.user?.username, "sso-erin");
});

test("OIDC callback issues a cookie-bound one-time session exchange", async () => {
  const pending = await createPendingOidcLogin();

  try {
    const callback = await handleOidcCallback({
      query: { state: pending.state, code: "authorization-code" },
      headers: { cookie: pending.cookie },
      ip: "127.0.0.1",
    });
    assert.ok(callback.code);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sessions").get().count, 0);

    assert.throws(
      () => exchangeOidcCallback(callback.code, { headers: { cookie: "aurral_oidc_transaction=wrong" } }),
      { status: 400, message: "OIDC login session expired" },
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sessions").get().count, 0);

    const session = exchangeOidcCallback(callback.code, {
      headers: { cookie: pending.cookie, "user-agent": "test-agent" },
      ip: "127.0.0.1",
    });
    assert.ok(session.token);
    assert.equal(getSessionByToken(session.token)?.user?.username, "callback-user");
    assert.throws(
      () => exchangeOidcCallback(callback.code, { headers: { cookie: pending.cookie } }),
      { status: 400, message: "OIDC login session expired" },
    );
  } finally {
    await pending.close();
  }
});

test("OIDC callback combines UserInfo with ID-token claims", async () => {
  process.env.OIDC_GROUPS_CLAIM = "groups";
  process.env.OIDC_ADMIN_GROUPS = "aurral-admins";
  const pending = await createPendingOidcLogin({
    idTokenClaims: { preferred_username: undefined, groups: ["aurral-admins"] },
    userInfo: {
      sub: "oidc-subject",
      preferred_username: "userinfo-user",
      groups: ["regular-users"],
    },
  });

  try {
    const callback = await handleOidcCallback({
      query: { state: pending.state, code: "authorization-code" },
      headers: { cookie: pending.cookie },
      ip: "127.0.0.1",
    });
    assert.equal(callback.user.username, "userinfo-user");
    assert.equal(callback.user.role, "admin");
  } finally {
    await pending.close();
  }
});

test("OIDC callback falls back to ID-token claims when UserInfo fails", async () => {
  const pending = await createPendingOidcLogin({
    idTokenClaims: { preferred_username: "id-token-user" },
    userInfo: { sub: "oidc-subject" },
    userInfoError: true,
  });

  try {
    const callback = await handleOidcCallback({
      query: { state: pending.state, code: "authorization-code" },
      headers: { cookie: pending.cookie },
      ip: "127.0.0.1",
    });
    assert.equal(callback.user.username, "id-token-user");
  } finally {
    await pending.close();
  }
});

test("OIDC groups claim ignores UserInfo-only admin groups", async () => {
  process.env.OIDC_GROUPS_CLAIM = "groups";
  process.env.OIDC_ADMIN_GROUPS = "aurral-admins";
  const pending = await createPendingOidcLogin({
    idTokenClaims: { preferred_username: "id-token-user" },
    userInfo: {
      sub: "oidc-subject",
      preferred_username: "userinfo-user",
      groups: ["aurral-admins"],
    },
  });

  try {
    const callback = await handleOidcCallback({
      query: { state: pending.state, code: "authorization-code" },
      headers: { cookie: pending.cookie },
      ip: "127.0.0.1",
    });
    assert.equal(callback.user.username, "userinfo-user");
    assert.equal(callback.user.role, "user");
  } finally {
    await pending.close();
  }
});

test("OIDC callback rejects an expired state without creating a session", async () => {
  const pending = await createPendingOidcLogin();
  const now = Date.now();
  const clock = mock.method(Date, "now", () => now + 11 * 60 * 1000);

  try {
    await assert.rejects(
      () =>
        handleOidcCallback({
          query: { state: pending.state },
          headers: { cookie: pending.cookie },
          ip: "127.0.0.1",
        }),
      { status: 400, message: "OIDC login session expired" },
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sessions").get().count, 0);
  } finally {
    clock.mock.restore();
    await pending.close();
  }
});

test("OIDC callback rejects a mismatched state without creating a session", async () => {
  const pending = await createPendingOidcLogin();

  try {
    await assert.rejects(
      () =>
        handleOidcCallback({
          query: { state: `${pending.state}-mismatched` },
          headers: { cookie: pending.cookie },
          ip: "127.0.0.1",
        }),
      { status: 400, message: "OIDC login session expired" },
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sessions").get().count, 0);
  } finally {
    await pending.close();
  }
});

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

const { dbOps, userOps, userIdentityOps } = dbHelpers;
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
  delete process.env.OIDC_TOKEN_ENDPOINT_AUTH_METHOD;
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

async function createPendingOidcLogin(options = {}) {
  let issuer;
  let nonce;
  const claimOverrides = options.claimOverrides || {};
  const capturedTokenRequest = {};
  const discoveryServer = await createMockHttpServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    if (request.url === "/jwks") {
      response.end(JSON.stringify({ keys: [oidcKey] }));
      return;
    }
    if (request.method === "POST" && request.url === "/token") {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        capturedTokenRequest.authorizationHeader = request.headers.authorization || null;
        capturedTokenRequest.body = body;
        response.end(
          JSON.stringify({
            access_token: "access-token",
            token_type: "Bearer",
            id_token: createIdToken(issuer, nonce, claimOverrides),
          }),
        );
      });
      return;
    }
    response.end(
      JSON.stringify({
        issuer,
        authorization_endpoint: `${issuer}authorize`,
        token_endpoint: `${issuer}token`,
        jwks_uri: `${issuer}jwks`,
      }),
    );
  });
  issuer = `${discoveryServer.url}/`;
  enableOidcEnv({
    OIDC_ISSUER: issuer,
    OIDC_REDIRECT_URI: `${issuer}callback`,
    ...(options.envOverrides || {}),
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
    capturedTokenRequest,
  };
}

async function completeOidcLogin(pending) {
  const callback = await handleOidcCallback({
    query: { state: pending.state, code: "authorization-code" },
    headers: { cookie: pending.cookie },
    ip: "127.0.0.1",
  });
  return exchangeOidcCallback(callback.code, {
    headers: { cookie: pending.cookie, "user-agent": "test-agent" },
    ip: "127.0.0.1",
  });
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

test("OIDC exchange never leaks passwordHash, for new or returning users", async () => {
  const first = await createPendingOidcLogin();
  try {
    const callback = await handleOidcCallback({
      query: { state: first.state, code: "authorization-code" },
      headers: { cookie: first.cookie },
      ip: "127.0.0.1",
    });
    const session = exchangeOidcCallback(callback.code, {
      headers: { cookie: first.cookie, "user-agent": "test-agent" },
      ip: "127.0.0.1",
    });
    assert.equal(session.user.passwordHash, undefined, "newly provisioned user must be sanitized");
  } finally {
    await first.close();
  }

  const second = await createPendingOidcLogin();
  try {
    const callback = await handleOidcCallback({
      query: { state: second.state, code: "authorization-code" },
      headers: { cookie: second.cookie },
      ip: "127.0.0.1",
    });
    const session = exchangeOidcCallback(callback.code, {
      headers: { cookie: second.cookie, "user-agent": "test-agent" },
      ip: "127.0.0.1",
    });
    assert.equal(session.user.passwordHash, undefined, "returning user must also be sanitized");
  } finally {
    await second.close();
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

test("OIDC login falls back to the UserInfo endpoint when the ID token omits profile claims", async () => {
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
          id_token: createIdToken(issuer, nonce, { preferred_username: undefined, email: undefined }),
        }),
      );
      return;
    }
    if (request.url === "/userinfo") {
      assert.equal(request.headers.authorization, "Bearer access-token");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ sub: "oidc-subject", preferred_username: "authelia-user" }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        issuer,
        authorization_endpoint: `${issuer}authorize`,
        token_endpoint: `${issuer}token`,
        userinfo_endpoint: `${issuer}userinfo`,
        jwks_uri: `${issuer}jwks`,
      }),
    );
  });

  try {
    issuer = `${discoveryServer.url}/`;
    enableOidcEnv({ OIDC_ISSUER: issuer, OIDC_REDIRECT_URI: `${issuer}callback` });

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
    nonce = redirect.searchParams.get("nonce");
    const state = redirect.searchParams.get("state");
    const cookie = response.headers["Set-Cookie"].split(";", 1)[0];
    const callback = await handleOidcCallback({
      query: { state, code: "authorization-code" },
      headers: { cookie },
      ip: "127.0.0.1",
    });
    const session = exchangeOidcCallback(callback.code, {
      headers: { cookie, "user-agent": "test-agent" },
      ip: "127.0.0.1",
    });
    const loggedInUser = getSessionByToken(session.token)?.user;
    assert.equal(
      loggedInUser?.username,
      "authelia-user",
      "must resolve the username from UserInfo when the ID token carries none",
    );
  } finally {
    await discoveryServer.close();
  }
});

test("OIDC login resolves returning users by issuer+subject, not by username claim", async () => {
  let issuer;
  let nonce;
  let claimOverrides = {};
  const discoveryServer = await createMockHttpServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    if (request.url === "/jwks") {
      response.end(JSON.stringify({ keys: [oidcKey] }));
      return;
    }
    if (request.method === "POST" && request.url === "/token") {
      response.end(
        JSON.stringify({
          access_token: "access-token",
          token_type: "Bearer",
          id_token: createIdToken(issuer, nonce, claimOverrides),
        }),
      );
      return;
    }
    response.end(
      JSON.stringify({
        issuer,
        authorization_endpoint: `${issuer}authorize`,
        token_endpoint: `${issuer}token`,
        jwks_uri: `${issuer}jwks`,
      }),
    );
  });

  try {
    issuer = `${discoveryServer.url}/`;
    enableOidcEnv({ OIDC_ISSUER: issuer, OIDC_REDIRECT_URI: `${issuer}callback` });

    const login = async () => {
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
      nonce = redirect.searchParams.get("nonce");
      const state = redirect.searchParams.get("state");
      const cookie = response.headers["Set-Cookie"].split(";", 1)[0];
      const callback = await handleOidcCallback({
        query: { state, code: "authorization-code" },
        headers: { cookie },
        ip: "127.0.0.1",
      });
      const session = exchangeOidcCallback(callback.code, {
        headers: { cookie, "user-agent": "test-agent" },
        ip: "127.0.0.1",
      });
      return getSessionByToken(session.token)?.user;
    };

    const firstUser = await login();
    assert.ok(firstUser?.id);
    assert.equal(userOps.getAllUsers().length, 1);

    claimOverrides = { preferred_username: "renamed-user" };
    const secondUser = await login();
    assert.equal(secondUser?.id, firstUser.id, "same subject must resolve to the same user");
    assert.equal(
      secondUser?.username,
      "callback-user",
      "username claim changing after first login must not rename or re-provision the user",
    );
    assert.equal(userOps.getAllUsers().length, 1, "returning login must not create a second user");
  } finally {
    await discoveryServer.close();
  }
});

test("OIDC provisioning auto-suffixes a colliding username instead of linking to the existing account", async () => {
  const first = await createPendingOidcLogin({ claimOverrides: { sub: "subject-one" } });
  let firstUserId;
  try {
    const session = await completeOidcLogin(first);
    firstUserId = getSessionByToken(session.token)?.user?.id;
  } finally {
    await first.close();
  }

  const second = await createPendingOidcLogin({ claimOverrides: { sub: "subject-two" } });
  try {
    const session = await completeOidcLogin(second);
    const loggedInUser = getSessionByToken(session.token)?.user;
    assert.notEqual(
      loggedInUser?.id,
      firstUserId,
      "a different subject with a colliding username must never log in as the existing account",
    );
    assert.equal(loggedInUser?.username, "callback-user-2");
  } finally {
    await second.close();
  }

  assert.equal(userOps.getAllUsers().length, 2);
  assert.equal(userOps.getUserByUsername("callback-user")?.id, firstUserId);
});

test("OIDC login adopts a legacy account only once an admin has approved that specific account", async () => {
  completeOnboarding();
  const legacy = userOps.createUser("callback-user", "random-unknown-hash", "user", null, false);
  userOps.updateUser(legacy.id, {
    needsIdentityMigration: true,
    allowIdentityAdoption: true,
  });

  const pending = await createPendingOidcLogin();
  try {
    const session = await completeOidcLogin(pending);
    const loggedInUser = getSessionByToken(session.token)?.user;
    assert.equal(loggedInUser?.id, legacy.id, "must adopt the legacy account, not provision a new one");
    assert.equal(loggedInUser?.username, "callback-user");
  } finally {
    await pending.close();
  }

  assert.equal(userOps.getAllUsers().length, 1, "no duplicate account should be created");
  const identities = userIdentityOps.getForUser(legacy.id);
  assert.equal(identities.length, 1);
  assert.equal(identities[0].providerType, "oidc");
  const adopted = userOps.getUserById(legacy.id);
  assert.equal(adopted.needsIdentityMigration, false);
  assert.equal(adopted.roleSource, "oidc");
  assert.equal(
    adopted.allowIdentityAdoption,
    false,
    "approval must be consumed so it authorizes exactly one adoption",
  );
});

test("OIDC login never adopts a legacy account the admin has not approved, even though the migration leaves has_local_password unset", async () => {
  completeOnboarding();
  const legacyLocalAccount = userOps.createUser(
    "callback-user",
    "real-local-password-hash",
    "user",
    null,
    false,
  );
  userOps.updateUser(legacyLocalAccount.id, { needsIdentityMigration: true });

  const pending = await createPendingOidcLogin();
  try {
    const session = await completeOidcLogin(pending);
    const loggedInUser = getSessionByToken(session.token)?.user;
    assert.notEqual(
      loggedInUser?.id,
      legacyLocalAccount.id,
      "a username match alone must never hand an OIDC identity someone else's account",
    );
    assert.equal(loggedInUser?.username, "callback-user-2");
  } finally {
    await pending.close();
  }

  assert.equal(userOps.getAllUsers().length, 2);
  assert.equal(userIdentityOps.getForUser(legacyLocalAccount.id).length, 0);
});

test("OIDC login does not adopt an approved legacy account that is already linked to another identity", async () => {
  completeOnboarding();
  const legacy = userOps.createUser("callback-user", "random-unknown-hash", "user", null, false);
  userOps.updateUser(legacy.id, {
    needsIdentityMigration: true,
    allowIdentityAdoption: true,
  });
  userIdentityOps.link(legacy.id, {
    providerType: "oidc",
    providerKey: "https://already-linked.example/",
    subject: "some-other-subject",
  });

  const pending = await createPendingOidcLogin();
  try {
    const session = await completeOidcLogin(pending);
    const loggedInUser = getSessionByToken(session.token)?.user;
    assert.notEqual(loggedInUser?.id, legacy.id);
    assert.equal(loggedInUser?.username, "callback-user-2");
  } finally {
    await pending.close();
  }
});

test("OIDC login does not adopt the protected bootstrap admin", async () => {
  completeOnboarding();
  const legacy = userOps.createUser("callback-user", "random-unknown-hash", "admin", null, false);
  userOps.updateUser(legacy.id, {
    needsIdentityMigration: true,
    allowIdentityAdoption: true,
  });
  userOps.setProtected(legacy.id, true);

  const pending = await createPendingOidcLogin();
  try {
    const session = await completeOidcLogin(pending);
    const loggedInUser = getSessionByToken(session.token)?.user;
    assert.notEqual(loggedInUser?.id, legacy.id);
  } finally {
    await pending.close();
  }
});

test("OIDC login rejects a suspended user and never overwrites a protected account's role", async () => {
  let issuer;
  let nonce;
  const discoveryServer = await createMockHttpServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    if (request.url === "/jwks") {
      response.end(JSON.stringify({ keys: [oidcKey] }));
      return;
    }
    if (request.method === "POST" && request.url === "/token") {
      response.end(
        JSON.stringify({
          access_token: "access-token",
          token_type: "Bearer",
          id_token: createIdToken(issuer, nonce),
        }),
      );
      return;
    }
    response.end(
      JSON.stringify({
        issuer,
        authorization_endpoint: `${issuer}authorize`,
        token_endpoint: `${issuer}token`,
        jwks_uri: `${issuer}jwks`,
      }),
    );
  });

  try {
    issuer = `${discoveryServer.url}/`;
    enableOidcEnv({ OIDC_ISSUER: issuer, OIDC_REDIRECT_URI: `${issuer}callback` });

    const login = async () => {
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
      nonce = redirect.searchParams.get("nonce");
      const state = redirect.searchParams.get("state");
      const cookie = response.headers["Set-Cookie"].split(";", 1)[0];
      const callback = await handleOidcCallback({
        query: { state, code: "authorization-code" },
        headers: { cookie },
        ip: "127.0.0.1",
      });
      const session = exchangeOidcCallback(callback.code, {
        headers: { cookie, "user-agent": "test-agent" },
        ip: "127.0.0.1",
      });
      return getSessionByToken(session.token)?.user;
    };

    const user = await login();
    assert.equal(user?.role, "user");
    assert.equal(userOps.getUserById(user.id)?.roleSource, "oidc");

    process.env.OIDC_ADMIN_USERS = "callback-user";
    userOps.setProtected(user.id, true);
    const loggedInAgain = await login();
    assert.equal(
      loggedInAgain?.role,
      "user",
      "OIDC must never promote or otherwise change a protected account's role",
    );
    delete process.env.OIDC_ADMIN_USERS;

    userOps.updateUser(user.id, { status: "suspended" });
    await assert.rejects(() => login(), {
      status: 403,
      message: "This account has been suspended or disabled",
    });
  } finally {
    await discoveryServer.close();
  }
});

test("OIDC token exchange defaults to client_secret_basic and honors OIDC_TOKEN_ENDPOINT_AUTH_METHOD", async () => {
  const basicPending = await createPendingOidcLogin();
  try {
    await completeOidcLogin(basicPending);
    assert.ok(
      basicPending.capturedTokenRequest.authorizationHeader?.startsWith("Basic "),
      "default token endpoint auth method must be client_secret_basic",
    );
    assert.ok(
      !String(basicPending.capturedTokenRequest.body || "").includes("client_secret="),
      "client_secret_basic must not put the secret in the request body",
    );
  } finally {
    await basicPending.close();
  }

  const postPending = await createPendingOidcLogin({
    claimOverrides: { sub: "subject-post" },
    envOverrides: { OIDC_TOKEN_ENDPOINT_AUTH_METHOD: "client_secret_post" },
  });
  try {
    await completeOidcLogin(postPending);
    assert.ok(
      String(postPending.capturedTokenRequest.body || "").includes("client_secret="),
      "client_secret_post must include the secret in the request body",
    );
  } finally {
    await postPending.close();
  }
});

test("OIDC token exchange supports the none auth method with an empty client secret", async () => {
  const nonePending = await createPendingOidcLogin({
    claimOverrides: { sub: "subject-none" },
    envOverrides: { OIDC_TOKEN_ENDPOINT_AUTH_METHOD: "none", OIDC_CLIENT_SECRET: "" },
  });
  try {
    assert.equal(isOidcEnabled(), true, "OIDC must stay enabled with an empty secret for none");
    const session = await completeOidcLogin(nonePending);
    assert.ok(session.token);
    assert.equal(nonePending.capturedTokenRequest.authorizationHeader, null);
    const tokenRequestParams = new URLSearchParams(nonePending.capturedTokenRequest.body || "");
    assert.equal(tokenRequestParams.get("client_secret"), null);
    assert.equal(
      tokenRequestParams.get("client_id"),
      "aurral",
      "a public client must still identify itself with client_id in the request body",
    );
  } finally {
    await nonePending.close();
  }
});

test("OIDC rejects an unrecognized token endpoint auth method instead of silently defaulting", async () => {
  enableOidcEnv({ OIDC_TOKEN_ENDPOINT_AUTH_METHOD: "client_secert_basic" });
  const response = {
    headers: {},
    redirect() {},
    setHeader() {},
    status() {
      return this;
    },
    json() {},
  };
  await assert.rejects(() => startOidcLogin({}, response), /Unsupported OIDC_TOKEN_ENDPOINT_AUTH_METHOD/);
});

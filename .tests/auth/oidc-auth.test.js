import test from "node:test";
import assert from "node:assert/strict";

import {
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
  isOidcEnabled,
  resolveOidcUsername,
  resolveOidcRole,
  getOidcBootstrapInfo,
  resetOidcStateForTests,
} = oidcModule;

const completeOnboarding = () => dbOps.updateSettings({ onboardingComplete: true });

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

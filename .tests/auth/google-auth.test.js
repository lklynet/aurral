import test from "node:test";
import assert from "node:assert/strict";
import { createSign, generateKeyPairSync } from "node:crypto";

import {
  createMockHttpServer,
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { db }, dbHelpers, sessionModule, googleModule] = await setupIsolatedBackend(
  "google-auth",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
  "backend/config/session-helpers.js",
  "backend/services/googleAuth.js",
);

const { dbOps, userOps, userIdentityOps } = dbHelpers;
const { getSessionByToken } = sessionModule;
const {
  startGoogleAuth,
  handleGoogleCallback,
  exchangeGoogleCallback,
  isGoogleLoginEnabled,
  resetGoogleStateForTests,
  setGoogleIssuerForTests,
} = googleModule;

const completeOnboarding = () => dbOps.updateSettings({ onboardingComplete: true });

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const googleKey = { ...publicKey.export({ format: "jwk" }), kid: "google-test-key", use: "sig", alg: "RS256" };

const createIdToken = (issuer, nonce, claimOverrides = {}) => {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "RS256", kid: googleKey.kid, typ: "JWT" });
  const payload = encode({
    iss: issuer,
    aud: "google-client-id",
    sub: "google-subject",
    email: "person@example.com",
    nonce,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300,
    ...claimOverrides,
  });
  const input = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256").update(input).sign(privateKey).toString("base64url");
  return `${input}.${signature}`;
};

function enableGoogleConfig(issuer) {
  dbOps.updateSettings({
    integrations: {
      google: {
        enabled: true,
        clientId: "google-client-id",
        clientSecret: "google-client-secret",
        redirectUri: `${issuer}callback`,
      },
    },
  });
}

async function createPendingGoogleAuth(mode, claimOverrides = {}) {
  let issuer;
  let nonce;
  const discoveryServer = await createMockHttpServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    if (request.url === "/jwks") {
      response.end(JSON.stringify({ keys: [googleKey] }));
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
  issuer = `${discoveryServer.url}/`;
  setGoogleIssuerForTests(issuer);
  enableGoogleConfig(issuer);

  const response = {
    headers: {},
    redirect(_status, location) {
      this.location = location;
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
  };
  await startGoogleAuth({ headers: {} }, response, mode);
  const redirect = new URL(response.location);
  const state = redirect.searchParams.get("state");
  nonce = redirect.searchParams.get("nonce");
  const cookie = response.headers["Set-Cookie"].split(";", 1)[0];
  return { state, cookie, close: discoveryServer.close };
}

async function completeGoogleAuth(pending) {
  const callback = await handleGoogleCallback({
    query: { state: pending.state, code: "authorization-code" },
    headers: { cookie: pending.cookie },
    ip: "127.0.0.1",
  });
  return exchangeGoogleCallback(callback.code, {
    headers: { cookie: pending.cookie, "user-agent": "test-agent" },
    ip: "127.0.0.1",
  });
}

test.beforeEach(() => {
  resetDatabase(db);
  resetGoogleStateForTests();
  dbOps.updateSettings({ onboardingComplete: false });
});

test.after(async () => {
  resetGoogleStateForTests();
  await cleanupIsolatedState(isolatedState);
});

test("Google login is disabled until enabled, clientId, clientSecret and redirectUri are all set", () => {
  assert.equal(isGoogleLoginEnabled(), false);
  dbOps.updateSettings({
    integrations: { google: { enabled: true, clientId: "id", clientSecret: "secret" } },
  });
  assert.equal(isGoogleLoginEnabled(), false, "missing redirectUri must keep it disabled");
  dbOps.updateSettings({
    integrations: {
      google: {
        enabled: true,
        clientId: "id",
        clientSecret: "secret",
        redirectUri: "https://aurral.example.com/sso/google/callback",
      },
    },
  });
  assert.equal(isGoogleLoginEnabled(), true);
});

test("logging in with an unrecognized Google identity is rejected and never provisions an account", async () => {
  completeOnboarding();
  const pending = await createPendingGoogleAuth({ mode: "login" });
  try {
    await assert.rejects(() => completeGoogleAuth(pending), {
      status: 403,
    });
    assert.equal(userOps.getAllUsers().length, 0);
    assert.equal(userIdentityOps.findByProvider("google", "google", "google-subject"), null);
  } finally {
    await pending.close();
  }
});

test("linking attaches the identity to the authenticated user, and logging in afterward resolves it without touching role", async () => {
  completeOnboarding();
  const user = userOps.createUser("gordon", "unused-hash", "user");

  const linkPending = await createPendingGoogleAuth({ mode: "link", linkUserId: user.id });
  try {
    const linkResult = await completeGoogleAuth(linkPending);
    assert.equal(linkResult.linked, true);
    assert.equal(linkResult.user.id, user.id);
  } finally {
    await linkPending.close();
  }

  const identity = userIdentityOps.findByProvider("google", "google", "google-subject");
  assert.equal(identity.userId, user.id);

  const loginPending = await createPendingGoogleAuth({ mode: "login" });
  try {
    const loginResult = await completeGoogleAuth(loginPending);
    assert.equal(loginResult.linked, false);
    assert.ok(loginResult.token);
    const sessionUser = getSessionByToken(loginResult.token)?.user;
    assert.equal(sessionUser?.id, user.id);
    assert.equal(sessionUser?.role, "user", "Google must never grant or change role");
  } finally {
    await loginPending.close();
  }
});

test("linking a Google identity already claimed by another user is rejected with 409", async () => {
  completeOnboarding();
  const userA = userOps.createUser("user-a", "unused-hash", "user");
  const userB = userOps.createUser("user-b", "unused-hash", "user");

  const firstLink = await createPendingGoogleAuth({ mode: "link", linkUserId: userA.id });
  try {
    await completeGoogleAuth(firstLink);
  } finally {
    await firstLink.close();
  }

  const secondLink = await createPendingGoogleAuth({ mode: "link", linkUserId: userB.id });
  try {
    await assert.rejects(
      () =>
        handleGoogleCallback({
          query: { state: secondLink.state, code: "authorization-code" },
          headers: { cookie: secondLink.cookie },
          ip: "127.0.0.1",
        }),
      { status: 409 },
    );
  } finally {
    await secondLink.close();
  }

  const identity = userIdentityOps.findByProvider("google", "google", "google-subject");
  assert.equal(identity.userId, userA.id, "the conflicting link attempt must not steal the identity");
});

test("a suspended user cannot log in via a linked Google identity", async () => {
  completeOnboarding();
  const user = userOps.createUser("suspended-google-user", "unused-hash", "user");
  userIdentityOps.link(user.id, {
    providerType: "google",
    providerKey: "google",
    subject: "google-subject",
  });
  userOps.updateUser(user.id, { status: "suspended" });

  const pending = await createPendingGoogleAuth({ mode: "login" });
  try {
    await assert.rejects(() => completeGoogleAuth(pending), {
      status: 403,
      message: "This account has been suspended or disabled",
    });
  } finally {
    await pending.close();
  }
});

test("exchangeGoogleCallback rejects a code that was never issued", () => {
  assert.throws(() => exchangeGoogleCallback("bogus-code", { headers: {} }), {
    status: 400,
    message: "Google login session expired",
  });
});

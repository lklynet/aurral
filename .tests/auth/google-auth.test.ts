import { createAuthRequest } from "./authFixtures.ts";
import { signedInAs } from "../helpers/honoApp.ts";
import { testUser } from "../helpers/userFixtures.ts";
import { test, beforeEach, afterAll } from "vite-plus/test";
import assert from "node:assert/strict";
import { createSign, generateKeyPairSync } from "node:crypto";

import {
  createMockHttpServer,
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.ts";

const [isolatedState, { db }, dbHelpers, sessionModule, googleModule, { api }] =
  await setupIsolatedBackend(
    "google-auth",
    () => import("../../backend/config/db-sqlite.ts"),
    () => import("../../backend/db/helpers/index.ts"),
    () => import("../../backend/config/session-helpers.ts"),
    () => import("../../backend/services/googleAuth.ts"),
    () => import("../../backend/routes/api.ts"),
  );

const { dbOps, userOps, userIdentityOps } = dbHelpers;
const { createSession, getSessionByToken } = sessionModule;
const {
  startGoogleAuth,
  handleGoogleCallback,
  exchangeGoogleCallback,
  isGoogleLoginEnabled,
  setGoogleIssuerForTests,
} = googleModule;

const completeOnboarding = () => dbOps.updateSettings({ onboardingComplete: true });

const exchangeRequest = ({
  headers = {},
  ip = null,
}: {
  headers?: { cookie?: string; "user-agent"?: string };
  ip?: string | null;
}) => ({ cookie: headers.cookie, ip, userAgent: headers["user-agent"] ?? null });

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const googleKey = {
  ...publicKey.export({ format: "jwk" }),
  kid: "google-test-key",
  use: "sig",
  alg: "RS256",
};

const createIdToken = (
  issuer: string,
  nonce: string | null,
  claimOverrides: Record<string, unknown> = {},
) => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
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

function enableGoogleConfig(issuer: string) {
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

async function createGoogleIssuer(claimOverrides = {}) {
  let issuer: string;
  let nonce: string | null;
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

  return {
    useNonceFrom(authUrl: string) {
      nonce = new URL(authUrl).searchParams.get("nonce");
    },
    close: discoveryServer.close,
  };
}

async function createPendingGoogleAuth(
  mode: Parameters<typeof startGoogleAuth>[0],
  claimOverrides = {},
) {
  const issuer = await createGoogleIssuer(claimOverrides);
  const login = await startGoogleAuth(mode);
  assert.ok(login, "Google login must be enabled");
  issuer.useNonceFrom(login.authUrl);
  const state = new URL(login.authUrl).searchParams.get("state");
  assert.ok(state);
  const cookie = login.cookie.split(";", 1)[0];
  return { state, cookie, close: issuer.close };
}

async function completeGoogleAuth(pending: Awaited<ReturnType<typeof createPendingGoogleAuth>>) {
  const callback = await handleGoogleCallback(
    createAuthRequest({
      query: { state: pending.state, code: "authorization-code" },
      headers: { cookie: pending.cookie },
      ip: "127.0.0.1",
    }),
  );
  return exchangeGoogleCallback(
    callback.code,
    exchangeRequest({
      headers: { cookie: pending.cookie, "user-agent": "test-agent" },
      ip: "127.0.0.1",
    }),
  );
}

beforeEach(() => {
  resetDatabase(db);
  dbOps.updateSettings({ onboardingComplete: false });
});

afterAll(async () => {
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

test("Google account linking can return an authorization URL to an authenticated API caller", async () => {
  completeOnboarding();
  const user = userOps.createUser("linker", "unused-hash", "user");
  assert.ok(user != null);
  const { token } = createSession(user.id);
  const issuer = await createGoogleIssuer();
  try {
    const app = signedInAs(testUser(user.id)).route("/", api);
    const response = await app.request("/auth/google/link/start", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200);
    assert.match((await response.json()).authUrl, /^http/);
    assert.equal(response.headers.get("location"), null);
    assert.ok(response.headers.get("set-cookie")?.startsWith("aurral_google_transaction="));
  } finally {
    await issuer.close();
  }
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
  assert.ok(user != null);

  const linkPending = await createPendingGoogleAuth({ mode: "link", linkUserId: user.id });
  try {
    const linkResult = await completeGoogleAuth(linkPending);
    assert.equal(linkResult.linked, true);
    assert.ok(linkResult.user);
    assert.equal(linkResult.user.id, user.id);
  } finally {
    await linkPending.close();
  }

  const identity = userIdentityOps.findByProvider("google", "google", "google-subject");
  assert.ok(identity != null);
  assert.equal(identity.userId, user.id);

  const loginPending = await createPendingGoogleAuth({ mode: "login" });
  try {
    const loginResult = await completeGoogleAuth(loginPending);
    assert.equal(loginResult.linked, false);
    assert.ok(loginResult.user);
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
  assert.ok(userA != null);
  const userB = userOps.createUser("user-b", "unused-hash", "user");
  assert.ok(userB != null);

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
        handleGoogleCallback(
          createAuthRequest({
            query: { state: secondLink.state, code: "authorization-code" },
            headers: { cookie: secondLink.cookie },
            ip: "127.0.0.1",
          }),
        ),
      { status: 409 },
    );
  } finally {
    await secondLink.close();
  }

  const identity = userIdentityOps.findByProvider("google", "google", "google-subject");
  assert.ok(identity != null);
  assert.equal(
    identity.userId,
    userA.id,
    "the conflicting link attempt must not steal the identity",
  );
});

test("a suspended user cannot log in via a linked Google identity", async () => {
  completeOnboarding();
  const user = userOps.createUser("suspended-google-user", "unused-hash", "user");
  assert.ok(user != null);
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

test("a suspended user cannot complete a Google link", async () => {
  completeOnboarding();
  const user = userOps.createUser("suspended-linker", "unused-hash", "user");
  assert.ok(user != null);
  userOps.updateUser(user.id, { status: "suspended" });

  const pending = await createPendingGoogleAuth({ mode: "link", linkUserId: user.id });
  try {
    await assert.rejects(
      () =>
        handleGoogleCallback(
          createAuthRequest({
            query: { state: pending.state, code: "authorization-code" },
            headers: { cookie: pending.cookie },
            ip: "127.0.0.1",
          }),
        ),
      { status: 403, message: "This account has been suspended or disabled" },
    );
  } finally {
    await pending.close();
  }
  assert.equal(userIdentityOps.findByProvider("google", "google", "google-subject"), null);
});

test("Google exchange never leaks passwordHash, for linking or login", async () => {
  completeOnboarding();
  const user = userOps.createUser("gordon-sanitize", "unused-hash", "user");
  assert.ok(user != null);

  const linkPending = await createPendingGoogleAuth({ mode: "link", linkUserId: user.id });
  try {
    const linkResult = await completeGoogleAuth(linkPending);
    assert.equal(Object.hasOwn(linkResult.user ?? {}, "passwordHash"), false);
  } finally {
    await linkPending.close();
  }

  const loginPending = await createPendingGoogleAuth({ mode: "login" });
  try {
    const loginResult = await completeGoogleAuth(loginPending);
    assert.equal(Object.hasOwn(loginResult.user ?? {}, "passwordHash"), false);
  } finally {
    await loginPending.close();
  }
});

test("exchangeGoogleCallback rejects a code that was never issued", () => {
  assert.throws(() => exchangeGoogleCallback("bogus-code", exchangeRequest({ headers: {} })), {
    status: 400,
    message: "Google login session expired",
  });
});

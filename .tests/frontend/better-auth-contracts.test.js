import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createServer } from "vite";

const createStorage = (initial = {}) => {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
};

const withFrontend = async (t) => {
  const originalGlobals = {
    fetch: globalThis.fetch,
    localStorage: globalThis.localStorage,
    sessionStorage: globalThis.sessionStorage,
    window: globalThis.window,
  };
  const vite = await createServer({
    root: "frontend",
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true },
  });

  t.after(async () => {
    await vite.close();
    Object.assign(globalThis, originalGlobals);
  });

  globalThis.localStorage = createStorage();
  globalThis.sessionStorage = createStorage();
  globalThis.window = { location: { origin: "https://aurral.example.com" } };
  return vite;
};

test("local auth uses Better Auth username login and bearer response headers", async (t) => {
  const vite = await withFrontend(t);
  let request;
  globalThis.fetch = async (url, init) => {
    request = { url, init };
    return new Response(JSON.stringify({
      session: { userId: "7" },
      user: { id: "7", name: "Ada Lovelace", email: "ada@example.com", role: "admin" },
    }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "set-auth-token": "better-auth-session-token",
      },
    });
  };

  const { loginApi } = await vite.ssrLoadModule(
    "/src/utils/api/endpoints/auth.js?better-auth-login-contract",
  );
  const result = await loginApi("ada@example.com", "password123");

  assert.equal(request.url, "/api/auth/sign-in/username");
  assert.deepEqual(JSON.parse(request.init.body), {
    username: "ada@example.com",
    password: "password123",
  });
  assert.equal(result.token, "better-auth-session-token");
  assert.equal(globalThis.localStorage.getItem("bearer_token"), "better-auth-session-token");
});

test("session restore and logout use Better Auth contracts", async (t) => {
  const vite = await withFrontend(t);
  globalThis.localStorage.setItem("bearer_token", "session-token");
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init });
    if (url.includes("get-session")) {
      return new Response(JSON.stringify({
        session: { userId: "7" },
        user: { id: "7", name: "Ada Lovelace", email: "ada@example.com" },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const { getMe, logoutApi } = await vite.ssrLoadModule(
    "/src/utils/api/endpoints/auth.js?better-auth-session-contract",
  );
  const session = await getMe();
  await logoutApi();

  assert.equal(requests[0].url, "/api/auth/get-session");
  assert.equal(requests[0].init.headers.Authorization, "Bearer session-token");
  assert.deepEqual(session.user, { id: "7", name: "Ada Lovelace", email: "ada@example.com" });
  assert.equal(requests[1].url, "/api/auth/sign-out");
});

test("OIDC sign-in starts through Better Auth social sign-in", async (t) => {
  const vite = await withFrontend(t);
  let request;
  globalThis.fetch = async (url, init) => {
    request = { url, init };
    return new Response(JSON.stringify({
      url: "https://idp.example.com/authorize?state=state-token",
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const { startOidcLogin } = await vite.ssrLoadModule(
    "/src/utils/api/endpoints/auth.js?better-auth-oidc-contract",
  );
  const redirectUrl = await startOidcLogin("/aurral/");

  assert.equal(request.url, "/api/auth/sign-in/social");
  assert.deepEqual(JSON.parse(request.init.body), {
    provider: "oidc",
    callbackURL: "/aurral/",
    disableRedirect: true,
  });
  assert.equal(redirectUrl, "https://idp.example.com/authorize?state=state-token");
});

test("local account management uses Better Auth admin shapes", async (t) => {
  const vite = await withFrontend(t);
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init });
    const payload = url === "/api/users"
      ? [{ id: "7", name: "Ada Lovelace" }]
      : { users: [{ id: "7", name: "Ada Lovelace" }] };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const { createUser, getUsers, changeMyPassword, deleteUser } = await vite.ssrLoadModule(
    "/src/utils/api/endpoints/auth.js?better-auth-admin-contract",
  );
  await createUser({
    username: "grace",
    password: "password123",
    role: "user",
    permissions: { addArtist: true },
  });
  await changeMyPassword("old-password", "new-password");
  await deleteUser(9);
  const users = await getUsers();

  assert.deepEqual(JSON.parse(requests[0].init.body), {
    username: "grace",
    password: "password123",
    role: "user",
    permissions: { addArtist: true },
  });
  assert.deepEqual(JSON.parse(requests[1].init.body), {
    currentPassword: "old-password",
    newPassword: "new-password",
    revokeOtherSessions: true,
  });
  assert.deepEqual(JSON.parse(requests[2].init.body), { userId: "9" });
  assert.equal(requests[3].url, "/api/users");
  assert.deepEqual(users, [{ id: "7", name: "Ada Lovelace" }]);
});

test("onboarding and login forms expose Better Auth account fields", async () => {
  const onboarding = await readFile("frontend/src/pages/Onboarding.jsx", "utf8");
  const login = await readFile("frontend/src/pages/Login.jsx", "utf8");

  assert.match(onboarding, /id="onboarding-username"/);
  assert.match(onboarding, /auth:\s*\{\s*username: authUsername\.trim\(\)/s);
  assert.doesNotMatch(onboarding, /onboarding-email/);
  assert.match(login, /id="identifier"/);
  assert.match(login, /Username/);
  assert.doesNotMatch(login, /id="username"/);
});

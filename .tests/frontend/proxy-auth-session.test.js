import assert from "node:assert/strict";
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

const withApiClient = async (t) => {
  const originalGlobals = {
    fetch: globalThis.fetch,
    localStorage: globalThis.localStorage,
    sessionStorage: globalThis.sessionStorage,
    window: globalThis.window,
  };
  const vite = await createServer({
    root: "frontend",
    server: { middlewareMode: true },
    appType: "custom",
    optimizeDeps: { noDiscovery: true },
  });

  t.after(async () => {
    await vite.close();
    Object.assign(globalThis, originalGlobals);
  });

  return vite;
};

test("proxy-authenticated requests carry the issued Aurral session token", async (t) => {
  const vite = await withApiClient(t);

  globalThis.sessionStorage = createStorage();
  globalThis.localStorage = createStorage({ auth_token: "session-token" });
  globalThis.window = { location: { origin: "https://aurral.example.com" } };
  let sentAuthorization = null;
  globalThis.fetch = async (_url, init) => {
    sentAuthorization = init.headers.Authorization ?? null;
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };

  const { default: api } = await vite.ssrLoadModule("/src/utils/api/core.js");

  await api.get("/health/bootstrap");
  assert.equal(sentAuthorization, "Bearer session-token");
});

test("an unauthorized response drops the stored session without navigating away", async (t) => {
  const vite = await withApiClient(t);

  const currentUrl = "https://aurral.example.com/discover";
  globalThis.sessionStorage = createStorage({ auth_token: "stale-token" });
  globalThis.localStorage = createStorage({ auth_token: "stale-token" });
  globalThis.window = {
    location: { origin: "https://aurral.example.com", pathname: "/discover", href: currentUrl },
  };
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });

  const { default: api } = await vite.ssrLoadModule("/src/utils/api/core.js");

  await assert.rejects(api.get("/health/bootstrap"), /status code 401/);
  assert.equal(globalThis.localStorage.getItem("auth_token"), null);
  assert.equal(globalThis.sessionStorage.getItem("auth_token"), null);
  assert.equal(globalThis.window.location.href, currentUrl);
});

test("a failed login response keeps the stored session untouched", async (t) => {
  const vite = await withApiClient(t);

  globalThis.sessionStorage = createStorage({ auth_token: "existing-token" });
  globalThis.localStorage = createStorage({ auth_token: "existing-token" });
  globalThis.window = { location: { origin: "https://aurral.example.com", pathname: "/" } };
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: "Invalid username or password" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });

  const { default: api } = await vite.ssrLoadModule("/src/utils/api/core.js");

  await assert.rejects(api.post("/auth/login", { username: "a", password: "b" }), /401/);
  assert.equal(globalThis.localStorage.getItem("auth_token"), "existing-token");
});

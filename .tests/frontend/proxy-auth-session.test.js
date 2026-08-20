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

test("a proxy auth redirect drops the service worker and reloads through the proxy", async (t) => {
  const vite = await withApiClient(t);

  const unregistered = [];
  const deletedCaches = [];
  let reloads = 0;
  globalThis.sessionStorage = createStorage();
  globalThis.localStorage = createStorage({ auth_token: "stale-token" });
  globalThis.window = {
    location: {
      origin: "https://aurral.example.com",
      pathname: "/discover",
      reload: () => {
        reloads += 1;
      },
    },
  };
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      serviceWorker: {
        getRegistrations: async () => [{ unregister: async () => unregistered.push(1) }],
      },
    },
  });
  globalThis.caches = {
    keys: async () => ["aurral-precache"],
    delete: async (key) => deletedCaches.push(key),
  };
  globalThis.fetch = async () => ({
    type: "opaqueredirect",
    status: 0,
    ok: false,
    headers: new Headers(),
    text: async () => "",
  });

  const { default: api } = await vite.ssrLoadModule("/src/utils/api/core.js");

  await assert.rejects(api.get("/health/bootstrap"), /redirected to an authentication provider/);
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(unregistered.length, 1);
  assert.deepEqual(deletedCaches, ["aurral-precache"]);
  assert.equal(reloads, 1);
  assert.equal(globalThis.localStorage.getItem("auth_token"), null);

  t.after(() => {
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    delete globalThis.caches;
  });
});

test("an unauthorized response drops the stored session without navigating away", async (t) => {
  const vite = await withApiClient(t);

  const currentUrl = "https://aurral.example.com/discover";
  let reloads = 0;
  globalThis.sessionStorage = createStorage({ auth_token: "stale-token" });
  globalThis.localStorage = createStorage({ auth_token: "stale-token" });
  globalThis.window = {
    location: {
      origin: "https://aurral.example.com",
      pathname: "/discover",
      href: currentUrl,
      reload: () => {
        reloads += 1;
      },
    },
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
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(reloads, 0);
});

test("a proxy 401 with a nested error body reauthenticates through the proxy", async (t) => {
  const vite = await withApiClient(t);

  let reloads = 0;
  let resolveReload;
  const reloadCompleted = new Promise((resolve) => {
    resolveReload = resolve;
  });
  globalThis.sessionStorage = createStorage({ auth_token: "stale-token" });
  globalThis.localStorage = createStorage({ auth_token: "stale-token" });
  globalThis.window = {
    location: {
      origin: "https://aurral.example.com",
      pathname: "/discover",
      reload: () => {
        reloads += 1;
        resolveReload();
      },
    },
  };
  globalThis.fetch = async () =>
    new Response(JSON.stringify({
      error: { status: 401, message: "Missing/invalid/expired access token" },
    }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });

  const { default: api } = await vite.ssrLoadModule("/src/utils/api/core.js");

  await assert.rejects(api.get("/playlists/import/spotify/playlists"), /status code 401/);
  await reloadCompleted;
  assert.equal(reloads, 1);
  assert.equal(globalThis.localStorage.getItem("auth_token"), null);
  assert.equal(globalThis.sessionStorage.getItem("auth_token"), null);
});

test("a Spotify provider 401 does not drop the Aurral session", async (t) => {
  const vite = await withApiClient(t);

  let reloads = 0;
  globalThis.sessionStorage = createStorage({ auth_token: "valid-token" });
  globalThis.localStorage = createStorage({ auth_token: "valid-token" });
  globalThis.window = {
    location: {
      origin: "https://aurral.example.com",
      pathname: "/discover",
      reload: () => {
        reloads += 1;
      },
    },
  };
  globalThis.fetch = async () =>
    new Response(JSON.stringify({
      error: "Spotify authentication required",
      code: "SPOTIFY_AUTH_REQUIRED",
      message: "Your Spotify connection expired. Connect Spotify again.",
    }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });

  const { default: api } = await vite.ssrLoadModule("/src/utils/api/core.js");

  await assert.rejects(api.get("/playlists/import/spotify/playlists"), /status code 401/);
  assert.equal(reloads, 0);
  assert.equal(globalThis.localStorage.getItem("auth_token"), "valid-token");
  assert.equal(globalThis.sessionStorage.getItem("auth_token"), "valid-token");
});

test("a proxy 401 without an Aurral error body reloads through the proxy", async (t) => {
  const vite = await withApiClient(t);

  let reloads = 0;
  globalThis.sessionStorage = createStorage();
  globalThis.localStorage = createStorage({ auth_token: "stale-token" });
  globalThis.window = {
    location: {
      origin: "https://aurral.example.com",
      pathname: "/discover",
      reload: () => {
        reloads += 1;
      },
    },
  };
  globalThis.fetch = async () =>
    new Response("<html>Authentication required</html>", {
      status: 401,
      headers: { "content-type": "text/html" },
    });

  const { default: api } = await vite.ssrLoadModule("/src/utils/api/core.js");

  await assert.rejects(api.get("/health/bootstrap"), /status code 401/);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(reloads, 1);
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

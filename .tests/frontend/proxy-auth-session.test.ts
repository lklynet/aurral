import assert from "node:assert/strict";
import { test, vi } from "vite-plus/test";

const createStorage = (initial: Record<string, string> = {}) => {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, String(value)),
    removeItem: (key: string) => values.delete(key),
  };
};

const withApiClient = async (t: import("vite-plus/test").TestContext) => {
  vi.resetModules();

  t.onTestFinished(async () => {
    vi.unstubAllGlobals();
  });
};

test("proxy-authenticated requests carry the issued Aurral session token", async (t) => {
  await withApiClient(t);

  vi.stubGlobal("sessionStorage", createStorage());
  vi.stubGlobal("localStorage", createStorage({ auth_token: "session-token" }));
  vi.stubGlobal("window", { location: { origin: "https://aurral.example.com" } });
  let sentAuthorization: string | null = null;
  globalThis.fetch = async (_url, init) => {
    sentAuthorization = new Headers(init?.headers).get("Authorization");
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };

  const { default: api } = await import("../../frontend/src/utils/api/core.ts");

  await api.get("/health/bootstrap");
  assert.equal(sentAuthorization, "Bearer session-token");
});

test("a proxy auth redirect drops the service worker and reloads through the proxy", async (t: import("vite-plus/test").TestContext) => {
  await withApiClient(t);

  const unregistered: number[] = [];
  const deletedCaches: string[] = [];
  let reloads = 0;
  const reloaded = Promise.withResolvers<void>();
  vi.stubGlobal("sessionStorage", createStorage());
  vi.stubGlobal("localStorage", createStorage({ auth_token: "stale-token" }));
  vi.stubGlobal("window", {
    location: {
      origin: "https://aurral.example.com",
      pathname: "/discover",
      reload: () => {
        reloads += 1;
        reloaded.resolve();
      },
    },
  });
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      serviceWorker: {
        getRegistrations: async () => [{ unregister: async () => unregistered.push(1) }],
      },
    },
  });
  vi.stubGlobal("caches", {
    keys: async () => ["aurral-precache"],
    delete: async (key: string) => deletedCaches.push(key),
  });
  vi.stubGlobal("fetch", async () => ({
    type: "opaqueredirect",
    status: 0,
    ok: false,
    headers: new Headers(),
    text: async () => "",
  }));

  const { default: api } = await import("../../frontend/src/utils/api/core.ts");

  await assert.rejects(api.get("/health/bootstrap"), /redirected to an authentication provider/);
  await reloaded.promise;

  assert.equal(unregistered.length, 1);
  assert.deepEqual(deletedCaches, ["aurral-precache"]);
  assert.equal(reloads, 1);
  assert.equal(globalThis.localStorage.getItem("auth_token"), null);

  t.onTestFinished(() => {
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    vi.unstubAllGlobals();
  });
});

test("an unauthorized response drops the stored session without navigating away", async (t) => {
  await withApiClient(t);

  const currentUrl = "https://aurral.example.com/discover";
  let reloads = 0;
  vi.stubGlobal("sessionStorage", createStorage({ auth_token: "stale-token" }));
  vi.stubGlobal("localStorage", createStorage({ auth_token: "stale-token" }));
  vi.stubGlobal("window", {
    location: {
      origin: "https://aurral.example.com",
      pathname: "/discover",
      href: currentUrl,
      reload: () => {
        reloads += 1;
      },
    },
  });
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });

  const { default: api } = await import("../../frontend/src/utils/api/core.ts");

  await assert.rejects(api.get("/health/bootstrap"), /status code 401/);
  assert.equal(globalThis.localStorage.getItem("auth_token"), null);
  assert.equal(globalThis.sessionStorage.getItem("auth_token"), null);
  assert.equal(globalThis.window.location.href, currentUrl);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(reloads, 0);
});

test("a proxy 401 with a nested error body reauthenticates through the proxy", async (t) => {
  await withApiClient(t);

  let reloads = 0;
  const { promise: reloadCompleted, resolve: resolveReload } = Promise.withResolvers<void>();
  vi.stubGlobal("sessionStorage", createStorage({ auth_token: "stale-token" }));
  vi.stubGlobal("localStorage", createStorage({ auth_token: "stale-token" }));
  vi.stubGlobal("window", {
    location: {
      origin: "https://aurral.example.com",
      pathname: "/discover",
      reload: () => {
        reloads += 1;
        resolveReload();
      },
    },
  });
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        error: { status: 401, message: "Missing/invalid/expired access token" },
      }),
      {
        status: 401,
        headers: { "content-type": "application/json" },
      },
    );

  const { default: api } = await import("../../frontend/src/utils/api/core.ts");

  await assert.rejects(api.get("/playlists/import/spotify/playlists"), /status code 401/);
  await reloadCompleted;
  assert.equal(reloads, 1);
  assert.equal(globalThis.localStorage.getItem("auth_token"), null);
  assert.equal(globalThis.sessionStorage.getItem("auth_token"), null);
});

test("a Spotify provider 401 does not drop the Aurral session", async (t) => {
  await withApiClient(t);

  let reloads = 0;
  vi.stubGlobal("sessionStorage", createStorage({ auth_token: "valid-token" }));
  vi.stubGlobal("localStorage", createStorage({ auth_token: "valid-token" }));
  vi.stubGlobal("window", {
    location: {
      origin: "https://aurral.example.com",
      pathname: "/discover",
      reload: () => {
        reloads += 1;
      },
    },
  });
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        error: "Spotify authentication required",
        code: "SPOTIFY_AUTH_REQUIRED",
        message: "Your Spotify connection expired. Connect Spotify again.",
      }),
      {
        status: 401,
        headers: { "content-type": "application/json" },
      },
    );

  const { default: api } = await import("../../frontend/src/utils/api/core.ts");

  await assert.rejects(api.get("/playlists/import/spotify/playlists"), /status code 401/);
  assert.equal(reloads, 0);
  assert.equal(globalThis.localStorage.getItem("auth_token"), "valid-token");
  assert.equal(globalThis.sessionStorage.getItem("auth_token"), "valid-token");
});

test("a proxy 401 without an Aurral error body reloads through the proxy", async (t) => {
  await withApiClient(t);

  let reloads = 0;
  const reloaded = Promise.withResolvers<void>();
  vi.stubGlobal("sessionStorage", createStorage());
  vi.stubGlobal("localStorage", createStorage({ auth_token: "stale-token" }));
  vi.stubGlobal("window", {
    location: {
      origin: "https://aurral.example.com",
      pathname: "/discover",
      reload: () => {
        reloads += 1;
        reloaded.resolve();
      },
    },
  });
  globalThis.fetch = async () =>
    new Response("<html>Authentication required</html>", {
      status: 401,
      headers: { "content-type": "text/html" },
    });

  const { default: api } = await import("../../frontend/src/utils/api/core.ts");

  await assert.rejects(api.get("/health/bootstrap"), /status code 401/);
  await reloaded.promise;
  assert.equal(reloads, 1);
});

test("a failed login response keeps the stored session untouched", async (t) => {
  await withApiClient(t);

  vi.stubGlobal("sessionStorage", createStorage({ auth_token: "existing-token" }));
  vi.stubGlobal("localStorage", createStorage({ auth_token: "existing-token" }));
  vi.stubGlobal("window", { location: { origin: "https://aurral.example.com", pathname: "/" } });
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: "Invalid username or password" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });

  const { default: api } = await import("../../frontend/src/utils/api/core.ts");

  await assert.rejects(api.post("/auth/login", { username: "a", password: "b" }), /401/);
  assert.equal(globalThis.localStorage.getItem("auth_token"), "existing-token");
});

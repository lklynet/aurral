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

test("bearer-authenticated bootstrap does not enable proxy auth", async (t) => {
  const originalSessionStorage = globalThis.sessionStorage;
  const vite = await createServer({
    root: "frontend",
    server: { middlewareMode: true },
    appType: "custom",
    optimizeDeps: { noDiscovery: true },
  });

  t.after(async () => {
    await vite.close();
    globalThis.sessionStorage = originalSessionStorage;
  });

  globalThis.sessionStorage = createStorage({ "aurral:proxy-auth": "1" });
  const { isProxyAuthActive, syncProxyAuthFromBootstrap } = await vite.ssrLoadModule(
    "/src/utils/authRecovery.js",
  );

  syncProxyAuthFromBootstrap({ proxyAuthEnabled: false, user: { id: 1 } });
  assert.equal(isProxyAuthActive(), false);
});

test("proxy-auth API 401 navigates through a fixed reauth route", async (t) => {
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

  globalThis.sessionStorage = createStorage({ "aurral:proxy-auth": "1" });
  globalThis.localStorage = createStorage();
  globalThis.window = { location: { origin: "https://aurral.example.com" } };
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: "Unauthorized", message: "Authentication required" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });

  const { default: api } = await vite.ssrLoadModule("/src/utils/api/core.js");

  for (const [pathname, search] of [
    ["/discover", ""],
    [
      "/outpost.goauthentik.io/start",
      "?rd=https%3A%2F%2Faurral.example.com%2Fapi%2Fauth%2Freauth%3FreturnTo%3D%252Fdiscover",
    ],
  ]) {
    Object.assign(globalThis.window.location, {
      pathname,
      search,
      href: `https://aurral.example.com${pathname}${search}`,
    });
    await assert.rejects(api.get("/discover"), /status code 401/);
    assert.equal(globalThis.window.location.href, "/api/auth/reauth");
  }
});

test("a pending proxy logout navigation is not clobbered by auth recovery", async (t) => {
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

  const logoutUrl = "https://aurral.example.com/outpost.goauthentik.io/sign_out";
  globalThis.sessionStorage = createStorage({ "aurral:proxy-auth": "1" });
  globalThis.localStorage = createStorage();
  globalThis.window = {
    location: {
      origin: "https://aurral.example.com",
      pathname: "/outpost.goauthentik.io/sign_out",
      search: "",
      href: logoutUrl,
    },
  };
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });

  const { beginLogoutNavigation, endLogoutNavigation } = await vite.ssrLoadModule(
    "/src/utils/authRecovery.js",
  );
  const { default: api } = await vite.ssrLoadModule("/src/utils/api/core.js");

  beginLogoutNavigation();
  await assert.rejects(api.get("/health/bootstrap"), /status code 401/);
  assert.equal(globalThis.window.location.href, logoutUrl);

  endLogoutNavigation();
  await assert.rejects(api.get("/health/bootstrap"), /status code 401/);
  assert.equal(globalThis.window.location.href, "/api/auth/reauth");
});

test("proxy-auth WebSocket closure probes ambiguous failures before navigating", async (t) => {
  const originalGlobals = {
    fetch: globalThis.fetch,
    localStorage: globalThis.localStorage,
    sessionStorage: globalThis.sessionStorage,
    WebSocket: globalThis.WebSocket,
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

  globalThis.sessionStorage = createStorage({ "aurral:proxy-auth": "1" });
  globalThis.localStorage = createStorage();
  globalThis.window = {
    location: {
      origin: "https://aurral.example.com",
      pathname: "/discover",
      search: "",
      href: "https://aurral.example.com/discover",
    },
  };
  globalThis.WebSocket = { OPEN: 1, CONNECTING: 0, CLOSING: 2 };

  const { recoverProxyAuthFromWebSocketClose } = await vite.ssrLoadModule(
    "/src/hooks/useWebSocket.js",
  );

  globalThis.fetch = async () => {
    throw new TypeError("Network error");
  };
  assert.equal(await recoverProxyAuthFromWebSocketClose({ code: 1006 }), false);
  assert.equal(
    globalThis.window.location.href,
    "https://aurral.example.com/discover",
  );

  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  assert.equal(await recoverProxyAuthFromWebSocketClose({ code: 1006 }), true);
  assert.equal(globalThis.window.location.href, "/api/auth/reauth");

  globalThis.window.location.href = "https://aurral.example.com/discover";
  assert.equal(await recoverProxyAuthFromWebSocketClose({ code: 4401 }), true);
  assert.equal(globalThis.window.location.href, "/api/auth/reauth");
});

test("a late close from an old WebSocket cannot orphan its replacement", async (t) => {
  const originalGlobals = {
    localStorage: globalThis.localStorage,
    sessionStorage: globalThis.sessionStorage,
    WebSocket: globalThis.WebSocket,
    window: globalThis.window,
  };
  const sockets = [];

  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    constructor() {
      this.readyState = FakeWebSocket.CONNECTING;
      sockets.push(this);
    }

    send() {}

    close() {
      this.readyState = FakeWebSocket.CLOSING;
    }
  }

  globalThis.sessionStorage = createStorage();
  globalThis.localStorage = createStorage();
  globalThis.window = {
    location: {
      protocol: "https:",
      host: "aurral.example.com",
      origin: "https://aurral.example.com",
      pathname: "/discover",
      search: "",
      href: "https://aurral.example.com/discover",
    },
  };
  globalThis.WebSocket = FakeWebSocket;

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

  const { webSocketConnectionForTesting } = await vite.ssrLoadModule(
    "/src/hooks/useWebSocket.js?late-close-test",
  );
  const unsubscribeStatus = webSocketConnectionForTesting.subscribeToStatus(() => {});
  assert.equal(sockets.length, 1);

  const first = sockets[0];
  first.readyState = FakeWebSocket.CLOSING;
  const unsubscribeFirstChannel = webSocketConnectionForTesting.subscribeToChannel(
    "first",
    () => {},
  );
  assert.equal(sockets.length, 2);

  const replacement = sockets[1];
  first.readyState = FakeWebSocket.CLOSED;
  first.onclose?.({ code: 1006 });
  replacement.readyState = FakeWebSocket.OPEN;
  replacement.onopen?.();

  const unsubscribeSecondChannel = webSocketConnectionForTesting.subscribeToChannel(
    "second",
    () => {},
  );
  assert.equal(sockets.length, 2);

  unsubscribeSecondChannel();
  unsubscribeFirstChannel();
  unsubscribeStatus();
});

test("a missed WebSocket heartbeat retires the dead socket for reconnection", async (t) => {
  const originalGlobals = {
    clearTimeout: globalThis.clearTimeout,
    localStorage: globalThis.localStorage,
    sessionStorage: globalThis.sessionStorage,
    setTimeout: globalThis.setTimeout,
    WebSocket: globalThis.WebSocket,
    window: globalThis.window,
  };
  const sockets = [];
  let heartbeatExpired = null;

  class DeadWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;

    constructor() {
      this.readyState = DeadWebSocket.CONNECTING;
      this.closeCalls = 0;
      sockets.push(this);
    }

    send() {}

    close() {
      this.closeCalls += 1;
      this.readyState = DeadWebSocket.CLOSING;
    }
  }

  globalThis.sessionStorage = createStorage();
  globalThis.localStorage = createStorage();
  globalThis.window = {
    location: {
      protocol: "https:",
      host: "aurral.example.com",
      origin: "https://aurral.example.com",
      pathname: "/discover",
      search: "",
      href: "https://aurral.example.com/discover",
    },
  };
  globalThis.WebSocket = DeadWebSocket;

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

  const { webSocketConnectionForTesting } = await vite.ssrLoadModule(
    "/src/hooks/useWebSocket.js?heartbeat-test",
  );
  const unsubscribe = webSocketConnectionForTesting.subscribeToStatus(() => {});
  const current = sockets[0];
  current.readyState = DeadWebSocket.OPEN;

  globalThis.setTimeout = (callback, delay, ...args) => {
    if (delay === 10000) {
      heartbeatExpired = () => callback(...args);
      return 12345;
    }
    return originalGlobals.setTimeout(callback, delay, ...args);
  };
  current.onopen?.();
  globalThis.setTimeout = originalGlobals.setTimeout;

  assert.equal(typeof heartbeatExpired, "function");
  heartbeatExpired();
  assert.equal(current.closeCalls, 1);

  unsubscribe();
});

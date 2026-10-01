import assert from "node:assert/strict";
import test from "node:test";
import { startFrontendServer } from "../helpers/frontendServer.js";

const createStorage = (initial = {}) => {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
};

const browserWindow = () => ({
  location: {
    protocol: "https:",
    host: "aurral.example.com",
    origin: "https://aurral.example.com",
    pathname: "/discover",
    search: "",
    href: "https://aurral.example.com/discover",
  },
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
  globalThis.window = browserWindow();
  globalThis.WebSocket = FakeWebSocket;

  const vite = await startFrontendServer();

  t.after(async () => {
    await vite.close();
    Object.assign(globalThis, originalGlobals);
  });

  const webSocketConnection = await vite.ssrLoadModule(
    "/src/utils/webSocketConnection.js?late-close-test",
  );
  const unsubscribeStatus = webSocketConnection.subscribeToStatus(() => {});
  assert.equal(sockets.length, 1);

  const first = sockets[0];
  first.readyState = FakeWebSocket.CLOSING;
  const unsubscribeFirstChannel = webSocketConnection.subscribeToChannel(
    "first",
    () => {},
  );
  assert.equal(sockets.length, 2);

  const replacement = sockets[1];
  first.readyState = FakeWebSocket.CLOSED;
  first.onclose?.({ code: 1006 });
  replacement.readyState = FakeWebSocket.OPEN;
  replacement.onopen?.();

  const unsubscribeSecondChannel = webSocketConnection.subscribeToChannel(
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
  globalThis.window = browserWindow();
  globalThis.WebSocket = DeadWebSocket;

  const vite = await startFrontendServer();

  t.after(async () => {
    await vite.close();
    Object.assign(globalThis, originalGlobals);
  });

  const webSocketConnection = await vite.ssrLoadModule(
    "/src/utils/webSocketConnection.js?heartbeat-test",
  );
  const unsubscribe = webSocketConnection.subscribeToStatus(() => {});
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

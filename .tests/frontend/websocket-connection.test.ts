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

test("a late close from an old WebSocket cannot orphan its replacement", async (t: import("vite-plus/test").TestContext) => {
  const sockets: FakeWebSocket[] = [];

  class FakeWebSocket {
    readyState = 0;
    onclose?: (event: { code: number }) => void;
    onopen?: () => void;
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

  vi.stubGlobal("sessionStorage", createStorage());
  vi.stubGlobal("localStorage", createStorage());
  vi.stubGlobal("window", browserWindow());
  vi.stubGlobal("WebSocket", FakeWebSocket);

  vi.resetModules();

  t.onTestFinished(async () => {
    vi.unstubAllGlobals();
  });

  const webSocketConnection = await import("../../frontend/src/utils/webSocketConnection.ts");
  const unsubscribeStatus = webSocketConnection.subscribeToStatus(() => {});
  assert.equal(sockets.length, 1);

  const first = sockets[0];
  first.readyState = FakeWebSocket.CLOSING;
  const unsubscribeFirstChannel = webSocketConnection.subscribeToChannel("first", () => {});
  assert.equal(sockets.length, 2);

  const replacement = sockets[1];
  first.readyState = FakeWebSocket.CLOSED;
  first.onclose?.({ code: 1006 });
  replacement.readyState = FakeWebSocket.OPEN;
  replacement.onopen?.();

  const unsubscribeSecondChannel = webSocketConnection.subscribeToChannel("second", () => {});
  assert.equal(sockets.length, 2);

  unsubscribeSecondChannel();
  unsubscribeFirstChannel();
  unsubscribeStatus();
});

test("a missed WebSocket heartbeat retires the dead socket for reconnection", async (t: import("vite-plus/test").TestContext) => {
  const originalGlobals = {
    clearTimeout: globalThis.clearTimeout,
    localStorage: globalThis.localStorage,
    sessionStorage: globalThis.sessionStorage,
    setTimeout: globalThis.setTimeout,
    WebSocket: globalThis.WebSocket,
    window: globalThis.window,
  };
  const sockets: DeadWebSocket[] = [];
  const heartbeat = { expire: null as (() => void) | null };

  class DeadWebSocket {
    readyState = 0;
    closeCalls = 0;
    onopen?: () => void;
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

  vi.stubGlobal("sessionStorage", createStorage());
  vi.stubGlobal("localStorage", createStorage());
  vi.stubGlobal("window", browserWindow());
  vi.stubGlobal("WebSocket", DeadWebSocket);

  vi.resetModules();

  t.onTestFinished(async () => {
    vi.unstubAllGlobals();
  });

  const webSocketConnection = await import("../../frontend/src/utils/webSocketConnection.ts");
  const unsubscribe = webSocketConnection.subscribeToStatus(() => {});
  const current = sockets[0];
  current.readyState = DeadWebSocket.OPEN;

  vi.stubGlobal(
    "setTimeout",
    (callback: (...args: unknown[]) => void, delay: number, ...args: unknown[]) => {
      if (delay === 10000) {
        heartbeat.expire = () => callback(...args);
        return 12345;
      }
      return originalGlobals.setTimeout(callback, delay, ...args);
    },
  );
  current.onopen?.();
  vi.stubGlobal("setTimeout", originalGlobals.setTimeout);

  assert.equal(typeof heartbeat.expire, "function");
  assert.ok(heartbeat.expire);
  heartbeat.expire();
  assert.equal(current.closeCalls, 1);

  unsubscribe();
});

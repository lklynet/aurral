import test, { mock } from "node:test";
import assert from "node:assert/strict";

import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { db }, { dbOps, userOps }, { auth }, { websocketService }] =
  await setupIsolatedBackend(
    "websocket-service",
    "backend/config/db-sqlite.js",
    "backend/db/helpers/index.js",
    "backend/services/betterAuth.js",
    "backend/services/websocketService.js",
  );

class FakeWebSocket {
  constructor() {
    this.readyState = 1;
    this.handlers = new Map();
    this.closed = false;
  }

  once(event, handler) {
    this.handlers.set(event, { handler, once: true });
  }

  on(event, handler) {
    this.handlers.set(event, { handler, once: false });
  }

  off(event, handler) {
    if (this.handlers.get(event)?.handler === handler) this.handlers.delete(event);
  }

  emit(event, ...args) {
    const registration = this.handlers.get(event);
    if (!registration) return;
    if (registration.once) this.handlers.delete(event);
    registration.handler(...args);
  }

  close() {
    this.closed = true;
    this.readyState = 3;
    this.emit("close");
  }

  send() {}
}

test.beforeEach(() => {
  resetDatabase(db);
  dbOps.updateSettings({ onboardingComplete: true, integrations: {}, security: {} });
  userOps.createUser("admin", "hash", "admin");
  websocketService.clients.clear();
});

test.after(async () => {
  websocketService.clients.clear();
  await cleanupIsolatedState(isolatedState);
});

test("does not retain a WebSocket that closes during authentication", async () => {
  let startAuthentication;
  let finishAuthentication;
  const authenticationStarted = new Promise((resolve) => {
    startAuthentication = resolve;
  });
  const authenticationPending = new Promise((resolve) => {
    finishAuthentication = resolve;
  });
  const authMock = mock.method(auth.api, "getSession", async () => {
    startAuthentication();
    await authenticationPending;
    return { user: { id: "1", username: "admin", role: "admin" } };
  });
  const ws = new FakeWebSocket();

  try {
    const connection = websocketService.handleConnection(ws, {
      url: "/ws",
      headers: {},
      socket: { remoteAddress: "127.0.0.1" },
      connection: { remoteAddress: "127.0.0.1" },
    });
    await authenticationStarted;
    ws.close();
    finishAuthentication();
    await connection;

    assert.equal(ws.closed, true);
    assert.equal(websocketService.getStats().totalClients, 0);
  } finally {
    authMock.mock.restore();
  }
});

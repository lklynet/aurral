import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "vite-plus/test";
import {
  completeConnectCallback,
  consumeHostedLoginNotice,
  exchangeServerSession,
  fetchConnectServers,
  readConnectSession,
  setHostedLoginNotice,
  writeConnectSession,
} from "../../frontend/src/hosted/connectAuth.ts";

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.map.set(key, value);
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
  clear() {
    this.map.clear();
  }
}

const originalFetch = globalThis.fetch;
const originalLocalStorage = globalThis.localStorage;
const originalSessionStorage = globalThis.sessionStorage;

beforeEach(() => {
  Object.defineProperty(globalThis, "localStorage", {
    value: new MemoryStorage(),
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "sessionStorage", {
    value: new MemoryStorage(),
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  Object.defineProperty(globalThis, "localStorage", {
    value: originalLocalStorage,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "sessionStorage", {
    value: originalSessionStorage,
    configurable: true,
    writable: true,
  });
});

test("hosted login notices are address-scoped and consumed once", () => {
  setHostedLoginNotice("https://lee-home.aurral.dev", "Sign in with Aurral is off.");
  assert.equal(consumeHostedLoginNotice("https://other.aurral.dev"), null);

  setHostedLoginNotice("https://lee-home.aurral.dev", "Sign in with Aurral is off.");
  assert.equal(
    consumeHostedLoginNotice("https://lee-home.aurral.dev"),
    "Sign in with Aurral is off.",
  );
  assert.equal(consumeHostedLoginNotice("https://lee-home.aurral.dev"), null);
});

test("completeConnectCallback rejects mismatched state and stores valid sessions", async () => {
  sessionStorage.setItem(
    "aurral.connect.pkce",
    JSON.stringify({
      codeVerifier: "verifier-123",
      state: "expected-state",
      redirectUri: "https://music.aurral.org/connect/callback",
    }),
  );
  const wrong = await completeConnectCallback("code-1", "wrong-state");
  assert.equal(wrong.ok, false);

  sessionStorage.setItem(
    "aurral.connect.pkce",
    JSON.stringify({
      codeVerifier: "verifier-123",
      state: "expected-state",
      redirectUri: "https://music.aurral.org/connect/callback",
    }),
  );
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ token: "client-tok", expiresAt: Date.now() + 60_000 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  const ok = await completeConnectCallback("code-1", "expected-state");
  assert.equal(ok.ok, true);
  assert.equal(readConnectSession()?.token, "client-tok");
});

test("fetchConnectServers clears expired session on 401 and exchangeServerSession maps server refusals", async () => {
  writeConnectSession({ token: "client-tok", expiresAt: Date.now() + 60_000, handle: "lee_k" });
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  const unauth = await fetchConnectServers("client-tok");
  assert.deepEqual(unauth, { ok: false, reason: "unauthorized" });
  assert.equal(readConnectSession(), null);

  const server = { instanceId: "inst-1", connectUrl: "https://lee-home.aurral.dev" };
  const mapCase = async (exchangeStatus: number, exchangeBody: Record<string, unknown>) => {
    let step = 0;
    globalThis.fetch = async () => {
      step += 1;
      if (step === 1) {
        return new Response(
          JSON.stringify({ token: "assertion-jwt", expiresAt: Date.now() + 60_000 }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      return new Response(JSON.stringify(exchangeBody), {
        status: exchangeStatus,
        headers: { "content-type": "application/json" },
      });
    };
    return exchangeServerSession("client-tok", server);
  };

  assert.deepEqual(await mapCase(403, { error: "connect_sign_in_disabled" }), {
    ok: false,
    reason: "sign_in_off",
  });
  assert.deepEqual(await mapCase(403, { error: "account_not_linked" }), {
    ok: false,
    reason: "account_not_linked",
  });
  assert.deepEqual(await mapCase(409, { error: "ambiguous_account_link" }), {
    ok: false,
    reason: "ambiguous_link",
  });
  assert.deepEqual(await mapCase(503, { error: "server_offline" }), {
    ok: false,
    reason: "offline",
  });
  assert.deepEqual(await mapCase(429, { error: "rate_limited" }), {
    ok: false,
    reason: "rate_limited",
  });
  assert.deepEqual(
    await mapCase(200, { token: "local-session", user: { id: 1, username: "lee", role: "admin" } }),
    { ok: true, sessionToken: "local-session", username: "lee" },
  );
});

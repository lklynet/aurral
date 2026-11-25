import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import * as v from "valibot";
import { afterAll, afterEach, beforeAll, beforeEach, test, vi } from "vite-plus/test";
import { WebSocket } from "ws";
import { generateEd25519KeyPair, signConnectToken } from "../../lib/connectTokens.ts";
import { TUNNEL_CLOSE_REPLACED } from "../../lib/connectTunnel.ts";
import { createRelayServer } from "../../relay/src/relay.ts";
import {
  applyIsolatedBackendEnv,
  cleanupIsolatedState,
  createIsolatedStateDir,
} from "../helpers/backendTestHarness.ts";

const paths = await createIsolatedStateDir("connect-relay");
applyIsolatedBackendEnv(paths);

const { db } = await import("../../backend/config/db-sqlite.ts");
const { dbOps, userOps } = await import("../../backend/db/helpers/index.ts");
const { getShareInstance, SHARE_ORIGIN } =
  await import("../../backend/services/shareLinks/store.ts");
const { resetConnectAuthCache } = await import("../../backend/services/connect/connectAuth.ts");
const { startConnectListener } = await import("../../backend/services/connect/connectListener.ts");
const { openTunnelSession } = await import("../../backend/services/connect/connectClient.ts");
const { setConnectConfig } = await import("../../backend/services/connect/connectStore.ts");
const { hashPassword } = await import("../../backend/services/passwordHash.ts");

const keyPair = await generateEd25519KeyPair();
const relay = createRelayServer({
  connectDomain: "aurral.dev",
  appOrigin: "https://music.aurral.org",
  hubOrigin: SHARE_ORIGIN,
  publicKeys: [keyPair.publicJwk],
});

let relayPort = 0;
let listener: Awaited<ReturnType<typeof startConnectListener>>;
let adminId = 0;
let instanceId = "";

function rawHttp(
  port: number,
  options: {
    method?: string;
    path: string;
    host: string;
    headers?: Record<string, string>;
    body?: string;
  },
) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>(
    (resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          method: options.method ?? "GET",
          path: options.path,
          headers: {
            host: options.host,
            ...(options.body && { "content-length": String(Buffer.byteLength(options.body)) }),
            ...options.headers,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks).toString("utf8"),
            }),
          );
        },
      );
      req.on("error", reject);
      if (options.body) req.write(options.body);
      req.end();
    },
  );
}

beforeAll(async () => {
  relayPort = await relay.listen(0, "127.0.0.1");
  listener = await startConnectListener();
  instanceId = getShareInstance().id;
  const created = userOps.createUser(
    "lee",
    hashPassword("password123"),
    "admin",
    null,
    true,
    false,
    "password123",
  );
  assert.ok(created);
  adminId = created.id;
  dbOps.updateSettings({
    onboardingComplete: true,
    security: {
      localNetworkBypass: { enabled: true },
      aurralAccounts: true,
    },
  });
  db.prepare(
    "INSERT INTO hub_links (user_id, origin, token, handle, account_id, linked_at, broken) VALUES (?, ?, ?, ?, ?, ?, 0)",
  ).run(adminId, SHARE_ORIGIN, "t".repeat(43), "lee_k", "acct_lee_1", Date.now());
});

afterAll(async () => {
  await listener?.close();
  await relay.close();
  await cleanupIsolatedState(paths);
});

beforeEach(() => {
  resetConnectAuthCache();
  setConnectConfig({
    enabled: true,
    allowHubSignIn: true,
    slug: "lee-home",
    name: "Home Mac",
    connectUrl: "https://lee-home.aurral.dev",
    hubOrigin: SHARE_ORIGIN,
  });
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.href === `${SHARE_ORIGIN}/v1/connect/keys`) {
      return Response.json({ keys: [keyPair.publicJwk] });
    }
    return new Response(null, { status: 404 });
  });
});

afterEach(() => {
  delete process.env.AUTH_PROXY_ENABLED;
  vi.unstubAllGlobals();
});

async function signTicket(slug: string, sub = instanceId, ttlSeconds = 900) {
  const iat = Math.floor(Date.now() / 1000);
  return signConnectToken(keyPair.privateJwk, {
    typ: "aurral-connect-tunnel",
    iss: SHARE_ORIGIN,
    aud: "aurral-relay",
    sub,
    slug,
    connectOrigin: `https://${slug}.aurral.dev`,
    iat,
    exp: iat + ttlSeconds,
  });
}

async function openConnectedTunnel(slug: string, sub = instanceId) {
  const ticket = await signTicket(slug, sub);
  return new Promise<ReturnType<typeof openTunnelSession>>((resolve, reject) => {
    let resolved = false;
    const tunnel = openTunnelSession({
      relayUrl: `ws://127.0.0.1:${relayPort}/tunnel`,
      ticket,
      expiresAt: Date.now() + 900_000,
      connectPort: listener.port,
      onOpen: () => {
        resolved = true;
        resolve(tunnel);
      },
      onClose: (code, reason) => {
        if (!resolved) reject(new Error(`Tunnel closed before opening (${code}): ${reason}`));
      },
    });
  });
}

test("offline server returns 503 with CORS header and root HTML redirects to music.aurral.org", async () => {
  const offline = await rawHttp(relayPort, {
    path: "/api/health/bootstrap",
    host: "lee-home.aurral.dev",
    headers: { origin: "https://music.aurral.org" },
  });
  assert.equal(offline.status, 503);
  assert.equal(offline.headers["access-control-allow-origin"], "https://music.aurral.org");
  assert.equal(
    v.parse(v.object({ error: v.string() }), JSON.parse(offline.body)).error,
    "server_offline",
  );

  const rootRedirect = await rawHttp(relayPort, {
    path: "/",
    host: "lee-home.aurral.dev",
    headers: { accept: "text/html,application/xhtml+xml" },
  });
  assert.equal(rootRedirect.status, 302);
  assert.equal(rootRedirect.headers.location, "https://music.aurral.org");
});

test("Connect listener enforces never-local auth, exchanges Ed25519 assertions once, and serves API, WS, Subsonic, and shares", async () => {
  process.env.AUTH_PROXY_ENABLED = "true";
  const tunnel = await openConnectedTunnel("lee-home");
  try {
    const unauthSettings = await rawHttp(relayPort, {
      path: "/api/settings",
      host: "lee-home.aurral.dev",
      headers: { "x-forwarded-user": "lee" },
    });
    assert.equal(unauthSettings.status, 401);

    const unauthBrowse = await rawHttp(relayPort, {
      path: "/api/filesystem/browse",
      host: "lee-home.aurral.dev",
    });
    assert.equal(unauthBrowse.status, 401);

    const bootstrap = await rawHttp(relayPort, {
      path: "/api/health/bootstrap",
      host: "lee-home.aurral.dev",
      headers: { origin: "https://music.aurral.org", "x-forwarded-user": "lee" },
    });
    assert.equal(bootstrap.status, 200);
    assert.equal(bootstrap.headers["access-control-allow-origin"], "https://music.aurral.org");
    const bootJson = v.parse(
      v.looseObject({
        status: v.string(),
        user: v.optional(v.unknown()),
        token: v.optional(v.string()),
      }),
      JSON.parse(bootstrap.body),
    );
    assert.equal(bootJson.status, "ok");
    assert.equal(bootJson.user, undefined);
    assert.equal(bootJson.token, undefined);

    const iat = Math.floor(Date.now() / 1000);
    const assertion = await signConnectToken(keyPair.privateJwk, {
      typ: "aurral-connect-auth",
      iss: SHARE_ORIGIN,
      aud: instanceId,
      sub: "acct_lee_1",
      handle: "lee_k",
      jti: "jti-unique-connect-1",
      iat,
      exp: iat + 60,
    });

    const exchanged = await rawHttp(relayPort, {
      method: "POST",
      path: "/api/auth/connect-exchange",
      host: "lee-home.aurral.dev",
      headers: { "content-type": "application/json", origin: "https://music.aurral.org" },
      body: JSON.stringify({ assertion }),
    });
    assert.equal(exchanged.status, 200);
    const sessionBody = v.parse(
      v.object({
        token: v.string(),
        user: v.object({ id: v.number(), username: v.string(), role: v.string() }),
      }),
      JSON.parse(exchanged.body),
    );
    assert.equal(sessionBody.user.username, "lee");

    const replayed = await rawHttp(relayPort, {
      method: "POST",
      path: "/api/auth/connect-exchange",
      host: "lee-home.aurral.dev",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assertion }),
    });
    assert.equal(replayed.status, 401);

    const me = await rawHttp(relayPort, {
      path: "/api/auth/me",
      host: "lee-home.aurral.dev",
      headers: { authorization: `Bearer ${sessionBody.token}` },
    });
    assert.equal(me.status, 200);
    assert.equal(
      v.parse(v.object({ user: v.object({ username: v.string() }) }), JSON.parse(me.body)).user
        .username,
      "lee",
    );

    const unauthWsCode = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${relayPort}/ws`, {
        headers: { host: "lee-home.aurral.dev", "x-forwarded-user": "lee" },
      });
      ws.on("close", (code) => resolve(code));
      ws.on("error", reject);
    });
    assert.equal(unauthWsCode, 4401);

    const wsMessages = await new Promise<string[]>((resolve, reject) => {
      const received: string[] = [];
      const ws = new WebSocket(
        `ws://127.0.0.1:${relayPort}/ws?token=${encodeURIComponent(sessionBody.token)}`,
        { headers: { host: "lee-home.aurral.dev" } },
      );
      ws.on("open", () => {
        ws.send(JSON.stringify({ type: "ping" }));
      });
      ws.on("message", (data) => {
        const parsed = v.parse(v.object({ type: v.string() }), JSON.parse(data.toString()));
        received.push(parsed.type);
        if (received.includes("connected") && received.includes("pong")) {
          ws.close();
          resolve(received);
        }
      });
      ws.on("error", reject);
    });
    assert.ok(wsMessages.includes("connected"));
    assert.ok(wsMessages.includes("pong"));

    const salt = "connectsalt";
    const subsonicToken = createHash("md5").update(`password123${salt}`).digest("hex");
    const ping = await rawHttp(relayPort, {
      path: `/rest/ping.view?v=1.16.1&c=test&f=json&u=lee&t=${subsonicToken}&s=${salt}`,
      host: "lee-home.aurral.dev",
    });
    assert.equal(ping.status, 200);
    assert.equal(
      v.parse(
        v.object({ "subsonic-response": v.object({ status: v.string() }) }),
        JSON.parse(ping.body),
      )["subsonic-response"].status,
      "ok",
    );

    const shareWellKnown = await rawHttp(relayPort, {
      path: "/share/.well-known/aurral",
      host: "lee-home.aurral.dev",
    });
    assert.equal(shareWellKnown.status, 200);
    assert.deepEqual(JSON.parse(shareWellKnown.body), { instanceId });

    setConnectConfig({ allowHubSignIn: false });
    const assertion2 = await signConnectToken(keyPair.privateJwk, {
      typ: "aurral-connect-auth",
      iss: SHARE_ORIGIN,
      aud: instanceId,
      sub: "acct_lee_1",
      handle: "lee_k",
      jti: "jti-unique-connect-2",
      iat,
      exp: iat + 60,
    });
    const disabledExchange = await rawHttp(relayPort, {
      method: "POST",
      path: "/api/auth/connect-exchange",
      host: "lee-home.aurral.dev",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assertion: assertion2 }),
    });
    assert.equal(disabledExchange.status, 403);

    setConnectConfig({ allowHubSignIn: true });
    const secondUser = userOps.createUser(
      "second",
      hashPassword("password123"),
      "user",
      null,
      true,
      false,
      "password123",
    );
    assert.ok(secondUser);
    db.prepare(
      "INSERT INTO hub_links (user_id, origin, token, handle, account_id, linked_at, broken) VALUES (?, ?, ?, ?, ?, ?, 0)",
    ).run(secondUser.id, SHARE_ORIGIN, "u".repeat(43), "lee_k", "acct_lee_1", Date.now());
    const assertion3 = await signConnectToken(keyPair.privateJwk, {
      typ: "aurral-connect-auth",
      iss: SHARE_ORIGIN,
      aud: instanceId,
      sub: "acct_lee_1",
      handle: "lee_k",
      jti: "jti-unique-connect-3",
      iat,
      exp: iat + 60,
    });
    const ambiguous = await rawHttp(relayPort, {
      method: "POST",
      path: "/api/auth/connect-exchange",
      host: "lee-home.aurral.dev",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assertion: assertion3 }),
    });
    assert.equal(ambiguous.status, 409);
    db.prepare("DELETE FROM hub_links WHERE user_id = ?").run(secondUser.id);
  } finally {
    tunnel.close();
  }
});

test("duplicate tunnel connection replaces the previous instance with close code 4009", async () => {
  const first = await openConnectedTunnel("dup-box");
  const firstClosed = new Promise<number>((resolve) => {
    first.ws.once("close", (code) => resolve(code));
  });
  const second = await openConnectedTunnel("dup-box");
  try {
    assert.equal(await firstClosed, TUNNEL_CLOSE_REPLACED);
    assert.equal(relay.hasTunnel("dup-box"), true);
  } finally {
    first.close();
    second.close();
  }
});

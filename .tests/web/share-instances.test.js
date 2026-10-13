import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const backendRequire = createRequire(new URL("../../backend/package.json", import.meta.url));
const Database = backendRequire("better-sqlite3");
const { onRequestDelete, onRequestPut } = await import("../../web/functions/api/instances/[id].js");
const { onRequest: sharePage } = await import("../../web/functions/s/[[path]].js");

const INSTANCE_ID = "AbCdEfGhIjKlMnOp";
const SECRET = "s".repeat(43);
const TUNNEL = "https://quiet-river-lamp.trycloudflare.com";
const PAYLOAD = "AQMAU29uZwBBcnRpc3QAQWxidW0";
const TOKEN = "T".repeat(22);

function fakeD1() {
  const sqlite = new Database(":memory:");
  return {
    sqlite,
    prepare(sql) {
      const bound = (values) => ({
        bind: (...next) => bound(next),
        first: async () => sqlite.prepare(sql).get(...values) ?? null,
        run: async () => ({ meta: { changes: sqlite.prepare(sql).run(...values).changes } }),
      });
      return bound([]);
    },
  };
}

function tunnelAnswering(routes) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const handler = routes[String(url)];
    if (!handler) throw new Error(`unexpected request to ${url}`);
    return handler();
  };
  return () => {
    globalThis.fetch = realFetch;
  };
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const put = (db, body, id = INSTANCE_ID) =>
  onRequestPut({
    env: { SHARE_DB: db },
    params: { id },
    request: new Request(`https://aurral.org/api/instances/${id}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  });

const storedUrl = (db) =>
  db.sqlite.prepare("SELECT tunnel_url FROM instances WHERE id = ?").get(INSTANCE_ID)?.tunnel_url ?? null;

test("an instance registers a tunnel only when the tunnel proves it is that instance", async (t) => {
  const db = fakeD1();
  const restore = tunnelAnswering({
    [`${TUNNEL}/share/.well-known/aurral`]: () => json({ instanceId: "someone-else-id1" }),
    ["https://evil.example.com/share/.well-known/aurral"]: () => json({ instanceId: INSTANCE_ID }),
  });
  t.after(restore);

  assert.equal((await put(db, { secret: SECRET, url: "https://evil.example.com" })).status, 400);
  assert.equal((await put(db, { secret: SECRET, url: `${TUNNEL}/path` })).status, 400);
  assert.equal((await put(db, { secret: SECRET, url: TUNNEL })).status, 422);
  assert.equal(storedUrl(db), null);
});

test("the first secret owns the instance and other secrets cannot move or clear it", async (t) => {
  const db = fakeD1();
  const restore = tunnelAnswering({
    [`${TUNNEL}/share/.well-known/aurral`]: () => json({ instanceId: INSTANCE_ID }),
    ["https://other-tunnel-name.trycloudflare.com/share/.well-known/aurral"]: () =>
      json({ instanceId: INSTANCE_ID }),
  });
  t.after(restore);

  assert.equal((await put(db, { secret: SECRET, url: TUNNEL })).status, 204);
  assert.equal(storedUrl(db), TUNNEL);
  const hijack = await put(db, {
    secret: "x".repeat(43),
    url: "https://other-tunnel-name.trycloudflare.com",
  });
  assert.equal(hijack.status, 403);
  const clear = await onRequestDelete({
    env: { SHARE_DB: db },
    params: { id: INSTANCE_ID },
    request: new Request("https://aurral.org", { method: "DELETE", body: JSON.stringify({ secret: "x".repeat(43) }) }),
  });
  assert.equal(clear.status, 403);
  assert.equal(storedUrl(db), TUNNEL);
  assert.notEqual(db.sqlite.prepare("SELECT secret_hash FROM instances").get().secret_hash, SECRET);
});

test("a claim racing the first owner cannot take over the instance", async (t) => {
  const db = fakeD1();
  const RIVAL = "https://rival-tunnel-name.trycloudflare.com";
  let releaseRival;
  const rivalVerified = new Promise((resolve) => {
    releaseRival = resolve;
  });
  const restore = tunnelAnswering({
    [`${TUNNEL}/share/.well-known/aurral`]: () => json({ instanceId: INSTANCE_ID }),
    [`${RIVAL}/share/.well-known/aurral`]: () => rivalVerified.then(() => json({ instanceId: INSTANCE_ID })),
  });
  t.after(restore);

  const rival = put(db, { secret: "x".repeat(43), url: RIVAL });
  assert.equal((await put(db, { secret: SECRET, url: TUNNEL })).status, 204);
  releaseRival();
  assert.equal((await rival).status, 403);
  assert.equal(storedUrl(db), TUNNEL);
});

test("a listen link plays from the registered tunnel, and says so when the tunnel is gone", async (t) => {
  const db = fakeD1();
  let tunnelUp = true;
  const restore = tunnelAnswering({
    [`${TUNNEL}/share/.well-known/aurral`]: () => json({ instanceId: INSTANCE_ID }),
    [`${TUNNEL}/share/${TOKEN}`]: () =>
      tunnelUp
        ? json({
            kind: "track",
            allowDownload: true,
            expiresAt: null,
            tracks: [{ path: "tracks/4/9", title: "Song <b>", durationMs: 61000 }],
          })
        : json({ error: "not_found" }, 404),
  });
  t.after(restore);
  assert.equal((await put(db, { secret: SECRET, url: TUNNEL })).status, 204);

  const open = (segment) =>
    sharePage({
      env: { SHARE_DB: db },
      params: { path: [segment] },
      request: new Request(`https://aurral.org/s/${segment}`),
    });

  const playing = await open(`${PAYLOAD}~${INSTANCE_ID}.${TOKEN}`);
  assert.equal(playing.status, 200);
  assert.equal(playing.headers.get("cache-control"), "private, no-store");
  const html = await playing.text();
  assert.ok(html.includes(`src="${TUNNEL}/share/${TOKEN}/tracks/4/9/stream"`));
  assert.ok(html.includes(`href="${TUNNEL}/share/${TOKEN}/tracks/4/9/download"`));
  assert.ok(!html.includes("Song <b>"));
  assert.ok(!html.includes("available to listen to right now"));

  tunnelUp = false;
  const stopped = await (await open(`${PAYLOAD}~${INSTANCE_ID}.${TOKEN}`)).text();
  assert.ok(stopped.includes("available to listen to right now"));
  assert.ok(!stopped.includes("/stream"));
});

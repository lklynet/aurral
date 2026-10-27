import type BetterSqlite3 from "better-sqlite3";
import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { createRequire } from "node:module";
import { getShareCode } from "../../lib/shareManifest.ts";

const backendRequire = createRequire(new URL("../../backend/package.json", import.meta.url));
const Database: typeof BetterSqlite3 = backendRequire("better-sqlite3");
const { onRequestDelete, onRequestPut } = await import("../../web/functions/api/instances/[id].js");
const { onRequest: sharePage } = await import("../../web/functions/s/[[path]].js");
const { onRequest: hostedShare } = await import("../../web/functions/api/shares/[id]/[token].js");
const { onRequest: resolveShare } = await import("../../web/functions/api/shares/resolve.js");
const { onRequestGet: sharePreview } = await import("../../web/functions/api/shares/preview.js");

const INSTANCE_ID = "AbCdEfGhIjKlMnOp";
const SECRET = "s".repeat(43);
const TUNNEL = "https://quiet-river-lamp.trycloudflare.com";
const PAYLOAD = "AQMAU29uZwBBcnRpc3QAQWxidW0";
const TOKEN = "T".repeat(22);
const SHARE_CODE = getShareCode(TOKEN);

function fakeD1() {
  const sqlite = new Database(":memory:");
  return {
    sqlite,
    prepare(sql: string) {
      const bound = (values: unknown[]) => ({
        bind: (...next: unknown[]) => bound(next),
        first: async () => sqlite.prepare(sql).get(...values) ?? null,
        run: async () => ({ meta: { changes: sqlite.prepare(sql).run(...values).changes } }),
      });
      return bound([]);
    },
  };
}

function tunnelAnswering(routes: Record<string, () => Response | Promise<Response>>) {
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

const json = (body: unknown, status: number = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const put = (
  db: ReturnType<typeof fakeD1>,
  body: { secret: string; url: string },
  id = INSTANCE_ID,
) =>
  onRequestPut({
    env: { SHARE_DB: db },
    params: { id },
    request: new Request(`https://aurral.org/api/instances/${id}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  });

const storedUrl = (db: ReturnType<typeof fakeD1>) =>
  db.sqlite
    .prepare<unknown[], { tunnel_url: string }>("SELECT tunnel_url FROM instances WHERE id = ?")
    .get(INSTANCE_ID)?.tunnel_url ?? null;

test("an instance registers a tunnel only when the tunnel proves it is that instance", async (t: import("vite-plus/test").TestContext) => {
  const db = fakeD1();
  const restore = tunnelAnswering({
    [`${TUNNEL}/share/.well-known/aurral`]: () => json({ instanceId: "someone-else-id1" }),
    ["https://evil.example.com/share/.well-known/aurral"]: () => json({ instanceId: INSTANCE_ID }),
  });
  t.onTestFinished(restore);

  assert.equal((await put(db, { secret: SECRET, url: "https://evil.example.com" })).status, 400);
  assert.equal((await put(db, { secret: SECRET, url: `${TUNNEL}/path` })).status, 400);
  assert.equal((await put(db, { secret: SECRET, url: TUNNEL })).status, 422);
  assert.equal(storedUrl(db), null);
});

test("the first secret owns the instance and other secrets cannot move or clear it", async (t: import("vite-plus/test").TestContext) => {
  const db = fakeD1();
  const restore = tunnelAnswering({
    [`${TUNNEL}/share/.well-known/aurral`]: () => json({ instanceId: INSTANCE_ID }),
    ["https://other-tunnel-name.trycloudflare.com/share/.well-known/aurral"]: () =>
      json({ instanceId: INSTANCE_ID }),
  });
  t.onTestFinished(restore);

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
    request: new Request("https://aurral.org", {
      method: "DELETE",
      body: JSON.stringify({ secret: "x".repeat(43) }),
    }),
  });
  assert.equal(clear.status, 403);
  assert.equal(storedUrl(db), TUNNEL);
  assert.notEqual(
    db.sqlite.prepare<unknown[], { secret_hash: string }>("SELECT secret_hash FROM instances").get()
      ?.secret_hash,
    SECRET,
  );
});

test("a claim racing the first owner cannot take over the instance", async (t: import("vite-plus/test").TestContext) => {
  const db = fakeD1();
  const RIVAL = "https://rival-tunnel-name.trycloudflare.com";
  let releaseRival!: () => void;
  const rivalVerified = new Promise<void>((resolve) => {
    releaseRival = resolve;
  });
  const restore = tunnelAnswering({
    [`${TUNNEL}/share/.well-known/aurral`]: () => json({ instanceId: INSTANCE_ID }),
    [`${RIVAL}/share/.well-known/aurral`]: () =>
      rivalVerified.then(() => json({ instanceId: INSTANCE_ID })),
  });
  t.onTestFinished(restore);

  const rival = put(db, { secret: "x".repeat(43), url: RIVAL });
  assert.equal((await put(db, { secret: SECRET, url: TUNNEL })).status, 204);
  releaseRival();
  assert.equal((await rival).status, 403);
  assert.equal(storedUrl(db), TUNNEL);
});

test("a listen link plays from the registered tunnel, and says so when the tunnel is gone", async (t: import("vite-plus/test").TestContext) => {
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
  t.onTestFinished(restore);
  assert.equal((await put(db, { secret: SECRET, url: TUNNEL })).status, 204);

  const open = (segment: string) =>
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
  assert.ok(!html.includes("Shared files are offline."));

  tunnelUp = false;
  const stopped = await (await open(`${PAYLOAD}~${INSTANCE_ID}.${TOKEN}`)).text();
  assert.ok(stopped.includes("Shared files are offline."));
  assert.ok(!stopped.includes("/stream"));
});

const playlistManifest = {
  kind: "playlist",
  title: "Night drive <test>",
  tracks: [
    { title: "First", artistName: "Artist", path: "tracks/4/9", format: "flac", size: 123 },
    { title: "Unavailable", artistName: "Artist" },
    { title: "First", artistName: "Artist", path: "tracks/4/9", format: "flac", size: 123 },
  ],
};

const publish = (db: ReturnType<typeof fakeD1>, shareFiles = false, secret = SECRET) =>
  hostedShare({
    env: { SHARE_DB: db },
    params: { id: INSTANCE_ID, token: TOKEN },
    request: new Request(`https://aurral.org/api/shares/${INSTANCE_ID}/${TOKEN}`, {
      method: "PUT",
      body: JSON.stringify({ secret, manifest: playlistManifest, shareFiles }),
    }),
  });

test("playlist details remain importable without a tunnel and stopping sharing removes them", async (t: import("vite-plus/test").TestContext) => {
  const db = fakeD1();
  t.onTestFinished(tunnelAnswering({}));
  assert.equal((await publish(db)).status, 204);
  assert.equal(storedUrl(db), null);
  const open = () =>
    sharePage({
      env: { SHARE_DB: db },
      params: { path: [SHARE_CODE] },
      request: new Request(`https://aurral.org/s/${SHARE_CODE}`),
    });
  const page = await open();
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("cache-control"), "private, no-store");
  const html = await page.text();
  assert.ok(html.includes("Night drive &lt;test&gt;"));
  assert.ok(html.includes("Unavailable"));
  assert.ok(!html.includes("/stream"));
  const resolved = await resolveShare({
    env: { SHARE_DB: db },
    request: new Request(`https://aurral.org/api/shares/resolve?share=${SHARE_CODE}`),
  });
  const body = await resolved.json();
  assert.deepEqual(
    body.manifest.tracks.map((track: { title: string }) => track.title),
    ["First", "Unavailable", "First"],
  );
  assert.equal(body.files, null);
  assert.equal(
    (
      await hostedShare({
        env: { SHARE_DB: db },
        params: { id: INSTANCE_ID, token: TOKEN },
        request: new Request("https://aurral.org", {
          method: "DELETE",
          body: JSON.stringify({ secret: SECRET }),
        }),
      })
    ).status,
    204,
  );
  assert.equal((await open()).status, 404);
});

test("publishing details preserves the instance's tunnel and rejects another owner", async (t: import("vite-plus/test").TestContext) => {
  const db = fakeD1();
  t.onTestFinished(
    tunnelAnswering({
      [`${TUNNEL}/share/.well-known/aurral`]: () => json({ instanceId: INSTANCE_ID }),
    }),
  );
  assert.equal((await put(db, { secret: SECRET, url: TUNNEL })).status, 204);
  assert.equal((await publish(db)).status, 204);
  assert.equal(storedUrl(db), TUNNEL);
  assert.equal((await publish(db, true, "x".repeat(43))).status, 403);
});

test("short codes cannot overwrite another share and older hosted URLs still work", async () => {
  const db = fakeD1();
  assert.equal((await publish(db)).status, 204);
  const takeCode = () =>
    hostedShare({
      env: { SHARE_DB: db },
      params: { id: "QbCdEfGhIjKlMnOp", token: `${TOKEN.slice(0, 15)}${"U".repeat(7)}` },
      request: new Request("https://aurral.org", {
        method: "PUT",
        body: JSON.stringify({
          secret: "x".repeat(43),
          manifest: { ...playlistManifest, title: "Collision" },
        }),
      }),
    });
  assert.equal((await takeCode()).status, 409);
  for (const segment of [SHARE_CODE, `${INSTANCE_ID}.${TOKEN}`]) {
    const result = await resolveShare({
      env: { SHARE_DB: db },
      request: new Request(`https://aurral.org/api/shares/resolve?share=${segment}`),
    });
    assert.equal(result.status, 200);
    assert.equal((await result.json()).manifest.title, playlistManifest.title);
  }
  assert.equal(
    (
      await hostedShare({
        env: { SHARE_DB: db },
        params: { id: INSTANCE_ID, token: TOKEN },
        request: new Request("https://aurral.org", {
          method: "DELETE",
          body: JSON.stringify({ secret: SECRET }),
        }),
      })
    ).status,
    204,
  );
  assert.equal((await takeCode()).status, 409);
  const stopped = await resolveShare({
    env: { SHARE_DB: db },
    request: new Request(`https://aurral.org/api/shares/resolve?share=${SHARE_CODE}`),
  });
  assert.equal(stopped.status, 404);
});

test("file access follows live download permission while the playlist snapshot survives an outage", async (t: import("vite-plus/test").TestContext) => {
  const db = fakeD1();
  let allowDownload = false;
  let online = true;
  t.onTestFinished(
    tunnelAnswering({
      [`${TUNNEL}/share/.well-known/aurral`]: () => json({ instanceId: INSTANCE_ID }),
      [`${TUNNEL}/share/${TOKEN}`]: () =>
        online
          ? json({
              kind: "playlist",
              allowDownload,
              tracks: [
                playlistManifest.tracks[0],
                { title: "Unsafe", artistName: "Artist", path: "../api/settings" },
              ],
            })
          : json({}, 404),
    }),
  );
  assert.equal((await put(db, { secret: SECRET, url: TUNNEL })).status, 204);
  assert.equal((await publish(db, true)).status, 204);
  const resolve = async () =>
    (
      await resolveShare({
        env: { SHARE_DB: db },
        request: new Request(`https://aurral.org/api/shares/resolve?share=${SHARE_CODE}`),
      })
    ).json();
  assert.equal((await resolve()).files.allowDownload, false);
  allowDownload = true;
  const downloading = await resolve();
  assert.equal(downloading.files.allowDownload, true);
  assert.equal(downloading.files.tracks.length, 1);
  online = false;
  const offline = await resolve();
  assert.equal(offline.files, null);
  assert.equal(offline.manifest.tracks.length, 3);
});

test("playlist previews are looked up on demand and stop working when sharing ends", async (t: import("vite-plus/test").TestContext) => {
  const db = fakeD1();
  let queries = 0;
  t.onTestFinished(
    tunnelAnswering({
      ["https://api.deezer.com/search/track?limit=10&q=Artist%20track%3A%22First%22"]: () => {
        queries += 1;
        return json({
          data: [
            {
              id: 42,
              title: "First",
              artist: { name: "Artist" },
              preview: "https://example.com/preview.mp3",
            },
          ],
        });
      },
    }),
  );
  await publish(db);
  await sharePage({
    env: { SHARE_DB: db },
    params: { path: [SHARE_CODE] },
    request: new Request(`https://aurral.org/s/${SHARE_CODE}`),
  });
  assert.equal(queries, 0);
  const preview = await sharePreview({
    env: { SHARE_DB: db },
    request: new Request(`https://aurral.org/api/shares/preview?share=${SHARE_CODE}&track=0`),
  });
  assert.equal(preview.status, 302);
  assert.equal(preview.headers.get("location"), "/api/deezer/preview/42");
  assert.equal(queries, 1);
});

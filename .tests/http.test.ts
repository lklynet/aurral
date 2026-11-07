import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";

import { http, isTransientNetworkError } from "../lib/http.ts";
import { useFakeClock } from "./helpers/fakeClock.ts";
import { requireFixture } from "./playlists/fixtures.ts";

useFakeClock();

async function listen(handler: RequestListener) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    [Symbol.asyncDispose]: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("cross-origin redirects drop credential headers but same-origin redirects keep them", async () => {
  const seen: IncomingHttpHeaders[] = [];
  await using target = await listen((req, res) => {
    seen.push(req.headers);
    res.end("ok");
  });
  await using source = await listen((req, res) => {
    seen.push(req.headers);
    const location = req.url === "/start" ? "/same-origin" : `${target.origin}/elsewhere`;
    res.writeHead(302, { location }).end();
  });

  const response = await http.get(`${source.origin}/start`, {
    headers: {
      "X-Api-Key": "secret",
      "X-Gotify-Key": "gotify",
      "X-Plex-Token": "token",
      Accept: "text/plain",
    },
    basicAuth: { username: "user", password: "pass" },
  });

  assert.equal(response.data, "ok");
  assert.equal(seen.length, 3);
  for (const headers of seen.slice(0, 2)) {
    assert.equal(headers["x-api-key"], "secret");
    assert.equal(headers["x-gotify-key"], "gotify");
    assert.equal(headers["x-plex-token"], "token");
    assert.ok(headers.authorization);
  }
  const crossOrigin = requireFixture(seen[2]);
  assert.equal(crossOrigin["x-api-key"], undefined);
  assert.equal(crossOrigin["x-gotify-key"], undefined);
  assert.equal(crossOrigin["x-plex-token"], undefined);
  assert.equal(crossOrigin.authorization, undefined);
  assert.equal(crossOrigin.accept, "text/plain");
});

test("redirects stop with an error after five hops", async () => {
  let requests = 0;
  await using server = await listen((_req, res) => {
    requests += 1;
    res.writeHead(302, { location: `/hop-${requests}` }).end();
  });

  await assert.rejects(http.get(`${server.origin}/start`), { code: "TOO_MANY_REDIRECTS" });
  assert.equal(requests, 6);
});

test("five redirects still reach the final response", async () => {
  await using server = await listen((req, res) => {
    const hop = Number(req.url?.split("-")[1] ?? 0);
    if (hop < 5) res.writeHead(302, { location: `/hop-${hop + 1}` }).end();
    else res.end("done");
  });

  const response = await http.get(`${server.origin}/hop-0`);
  assert.equal(response.data, "done");
});

test("timeoutMs covers the wait for headers, and bodyTimeoutMs bounds the download", async () => {
  let finishBody = () => {};
  await using server = await listen((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"ok":');
    finishBody = () => res.end("true}");
    if (req.url === "/slow") setTimeout(finishBody, 2_000);
  });

  const slow = await http.get(`${server.origin}/slow`, { timeoutMs: 1_000, bodyTimeoutMs: 5_000 });
  assert.deepEqual(slow.data, { ok: true });

  await assert.rejects(
    http.get(`${server.origin}/stalled`, { timeoutMs: 1_000, bodyTimeoutMs: 5_000 }),
    { code: "TIMEOUT" },
  );
  finishBody();
});

test("a dropped connection is a transient network error, so callers retry it", async () => {
  await using server = await listen((req) => req.socket.destroy());

  await assert.rejects(http.get(`${server.origin}/drop`), (error) =>
    isTransientNetworkError(error),
  );
});

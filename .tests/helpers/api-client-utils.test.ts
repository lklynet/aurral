import { listeningAddress } from "./backendTestHarness.ts";
import { asAppError } from "../../lib/errors.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { spawnSync } from "node:child_process";
import v8 from "node:v8";
import { runInNewContext } from "node:vm";
import { test, vi } from "vite-plus/test";
import createCache from "../../backend/services/apiClients/simpleCache.ts";
import createRateLimiter from "../../backend/services/apiClients/rateLimiter.ts";
import axios from "../../lib/axiosFetch.ts";

const settleWithFakeTimers = async (
  promise: Promise<void> | Promise<[void, void, void]> | Promise<[void, void]>,
) => {
  await vi.runAllTimersAsync();
  return promise;
};

test("rate limiter spaces concurrent and sequential request starts", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const limiter = createRateLimiter(30);
  const starts: number[] = [];
  const request = () =>
    limiter.schedule(async () => {
      starts.push(Date.now());
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    });
  await settleWithFakeTimers(Promise.all([request(), request(), request()]));
  await settleWithFakeTimers(request());
  await settleWithFakeTimers(request());
  assert.equal(starts.length, 5);
  for (let index = 1; index < starts.length; index += 1) {
    assert.ok(starts[index] - starts[index - 1] >= 20, `start ${index} came too soon`);
  }
});

test("rate limiter rejects excess queued reservations from a burst", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const limiter = createRateLimiter(20, { maxQueue: 1 });
  const first = limiter.schedule(() => {});
  const queued = limiter.schedule(() => {});

  const overflow = assert.rejects(
    limiter.schedule(() => {}),
    (error) => asAppError(error)?.code === "EQUEUEFULL",
  );
  await settleWithFakeTimers(Promise.all([overflow, first, queued]));
});

test("rate limiter expires queued work before invoking its callback", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const limiter = createRateLimiter(30);
  const first = limiter.schedule(() => {});
  let invoked = false;

  const expired = assert.rejects(
    limiter.schedule(
      () => {
        invoked = true;
      },
      { timeoutMs: 5 },
    ),
    (error) => asAppError(error)?.code === "ETIMEDOUT",
  );
  await settleWithFakeTimers(expired);
  await first;
  assert.equal(invoked, false);
});

test("rate limiter removes aborted queued work", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const limiter = createRateLimiter(30);
  const first = limiter.schedule(() => {});
  const controller = new AbortController();
  let invoked = false;

  const cancelled = limiter.schedule(
    () => {
      invoked = true;
    },
    { signal: controller.signal },
  );
  controller.abort();

  await settleWithFakeTimers(
    Promise.all([assert.rejects(cancelled, { name: "AbortError" }), first]),
  );
  assert.equal(invoked, false);
});

test("TTL cache evicts its oldest entry at the size limit", () => {
  const cache = createCache(300, 2);
  cache.set("first", 1);
  cache.set("second", 2);
  cache.set("third", 3);
  assert.equal(cache.get("first"), undefined);
  assert.equal(cache.get("second"), 2);
  assert.equal(cache.get("third"), 3);
});

test("TTL cache serves stale values during the configured stale window", () => {
  let now = 1_000;
  const cache = createCache(300, 2, { now: () => now });
  cache.set("album", { id: "album-1" }, 10, 20);

  now += 11_000;

  assert.deepEqual(cache.getWithStale("album"), {
    value: { id: "album-1" },
    stale: true,
  });
});

test("TTL cache releases expired entries before they push out live ones", () => {
  let now = 1_000;
  const cache = createCache(300, 3, { now: () => now });
  cache.set("live", 1, 3600);
  cache.set("stale", 2, 10, 600);
  cache.set("expired", 3, 10);

  now += 120_000;
  cache.set("new", 4);

  assert.equal(cache.get("live"), 1);
  assert.deepEqual(cache.getWithStale("stale"), { value: 2, stale: true });
  assert.equal(cache.get("new"), 4);
});

test("TTL cache removes values after the stale window", () => {
  let now = 1_000;
  const cache = createCache(300, 2, { now: () => now });
  cache.set("album", { id: "album-1" }, 10, 20);

  now += 31_000;

  assert.equal(cache.getWithStale("album"), undefined);
});

test("idle TTL caches release expired payloads while keeping stale and live values", async () => {
  v8.setFlagsFromString("--expose-gc");
  const collectGarbage = runInNewContext("gc");
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"], now: 1000 });
  vi.resetModules();
  const { default: createIdleCache } =
    await import("../../backend/services/apiClients/simpleCache.ts");
  const cache = createIdleCache();
  let payload: { id: string } | null = { id: "expired payload" };
  const retained = new WeakRef(payload);
  cache.set("expired", payload, 1);
  cache.set("stale", "offline fallback", 1, 600);
  cache.set("live", "live", 3600);
  payload = null;
  vi.advanceTimersByTime(60001);
  await new Promise(setImmediate);
  for (let attempt = 0; attempt < 5; attempt++) {
    collectGarbage();
    await new Promise(setImmediate);
  }
  assert.equal(retained.deref() === undefined, true, "idle caches must release expired payloads");
  assert.equal(cache.get("live"), "live");
  assert.deepEqual(cache.getWithStale("stale"), { value: "offline fallback", stale: true });
});

test("fetch transport failures expose axios-compatible request metadata", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError("fetch failed");
  };
  try {
    await assert.rejects(
      axios.get("http://lidarr.invalid/api/v1/status"),
      (error: { request?: { url?: string; method?: string } }) =>
        error.request?.url === "http://lidarr.invalid/api/v1/status" &&
        error.request?.method === "GET",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetch timeouts expose an axios-compatible timeout code", async () => {
  const server = http.createServer(() => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = listeningAddress(server);

  try {
    await assert.rejects(
      axios.get(`http://127.0.0.1:${port}`, { timeout: 10 }),
      (error) => asAppError(error)?.code === "ECONNABORTED",
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("uses environment proxy settings when NODE_USE_ENV_PROXY is enabled", async () => {
  let targetHits = 0;
  let proxyHits = 0;
  const target = http.createServer((_request, response) => {
    targetHits += 1;
    response.end("direct");
  });
  const proxy = http.createServer((_request, response) => {
    proxyHits += 1;
    response.end("proxied");
  });
  await Promise.all([
    new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve)),
    new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve)),
  ]);

  const saved = Object.fromEntries(
    [
      "NODE_USE_ENV_PROXY",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "NO_PROXY",
      "http_proxy",
      "https_proxy",
      "no_proxy",
    ].map((name) => [name, process.env[name]]),
  );
  const restoreEnvironment = () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };

  try {
    const proxyUrl = `http://127.0.0.1:${listeningAddress(proxy)!.port}`;
    process.env.NODE_USE_ENV_PROXY = "1";
    process.env.HTTP_PROXY = proxyUrl;
    process.env.HTTPS_PROXY = proxyUrl;
    process.env.http_proxy = proxyUrl;
    process.env.https_proxy = proxyUrl;
    process.env.NO_PROXY = "";
    process.env.no_proxy = "";

    const response = await axios.get(`http://127.0.0.1:${listeningAddress(target)!.port}`);
    assert.equal(response.data, "proxied");
    assert.equal(proxyHits, 1);
    assert.equal(targetHits, 0);

    process.env.NO_PROXY = "127.0.0.1";
    process.env.no_proxy = "127.0.0.1";
    const noProxyResponse = await axios.get(`http://127.0.0.1:${listeningAddress(target)!.port}`);
    assert.equal(noProxyResponse.data, "direct");
    assert.equal(proxyHits, 1);
    assert.equal(targetHits, 1);

    delete process.env.NODE_USE_ENV_PROXY;
    process.env.NO_PROXY = "";
    process.env.no_proxy = "";
    const disabledResponse = await axios.get(`http://127.0.0.1:${listeningAddress(target)!.port}`);
    assert.equal(disabledResponse.data, "direct");
    assert.equal(proxyHits, 1);
    assert.equal(targetHits, 2);
  } finally {
    restoreEnvironment();
    await Promise.all([
      new Promise<void>((resolve) => target.close(() => resolve())),
      new Promise<void>((resolve) => proxy.close(() => resolve())),
    ]);
  }
});

test("public-only transport rejects socket failures without an uncaught exception", () => {
  const moduleUrl = new URL("../../lib/axiosFetch.ts", import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
    import dns from "node:dns/promises";
    import net from "node:net";

    let publicLookups = 0;
    dns.lookup = async () => {
      publicLookups += 1;
      return [{ address: "8.8.8.8", family: 4 }];
    };
    net.Socket.prototype.connect = function (options) {
      options.lookup(options.hostname || options.host, { all: false }, () => {
        this.emit("error", Object.assign(new Error("injected transport failure"), {
          code: "EINJECTED",
        }));
      });
      return this;
    };

    const { default: axios } = await import(${JSON.stringify(moduleUrl)});
    try {
      await axios.get("https://example.test", { publicOnly: true, timeout: 1000 });
      process.exitCode = 2;
    } catch (error) {
      console.log(JSON.stringify({
        code: error.cause?.code || error.code,
        publicLookups,
        request: error.request,
      }));
    }
  `,
    ],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    code: "EINJECTED",
    publicLookups: 1,
    request: { method: "GET", url: "https://example.test" },
  });
});

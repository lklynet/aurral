import assert from "node:assert/strict";
import http from "node:http";
import { spawnSync } from "node:child_process";
import test from "node:test";
import createCache from "../../backend/services/apiClients/simpleCache.js";
import createRateLimiter from "../../backend/services/apiClients/rateLimiter.js";
import axios from "../../lib/axiosFetch.js";

test("rate limiter spaces concurrent request starts", async () => {
  const limiter = createRateLimiter(30);
  const starts = [];
  await Promise.all(
    [1, 2, 3].map(() =>
      limiter.schedule(() => {
        starts.push(Date.now());
      }),
    ),
  );
  assert.ok(starts[1] - starts[0] >= 20);
  assert.ok(starts[2] - starts[1] >= 20);
});

test("rate limiter rejects excess queued reservations from a burst", async () => {
  const limiter = createRateLimiter(20, { maxQueue: 1 });
  const first = limiter.schedule(() => {});
  const queued = limiter.schedule(() => {});

  await assert.rejects(
    limiter.schedule(() => {}),
    (error) => error.code === "EQUEUEFULL",
  );
  await Promise.all([first, queued]);
});

test("rate limiter expires queued work before invoking its callback", async () => {
  const limiter = createRateLimiter(30);
  const first = limiter.schedule(() => {});
  let invoked = false;

  await assert.rejects(
    limiter.schedule(
      () => {
        invoked = true;
      },
      { timeoutMs: 5 },
    ),
    (error) => error.code === "ETIMEDOUT",
  );
  await first;
  assert.equal(invoked, false);
});

test("rate limiter removes aborted queued work", async () => {
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

  await assert.rejects(cancelled, { name: "AbortError" });
  await first;
  await new Promise((resolve) => setTimeout(resolve, 40));
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

test("fetch transport failures expose axios-compatible request metadata", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError("fetch failed");
  };
  try {
    await assert.rejects(
      axios.get("http://lidarr.invalid/api/v1/status"),
      (error) =>
        error.request?.url === "http://lidarr.invalid/api/v1/status" &&
        error.request?.method === "GET",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetch timeouts expose an axios-compatible timeout code", async () => {
  const server = http.createServer((_request, response) => {
    setTimeout(() => response.end("ok"), 100);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    await assert.rejects(
      axios.get(`http://127.0.0.1:${port}`, { timeout: 10 }),
      (error) => error.code === "ECONNABORTED",
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("public-only transport rejects socket failures without an uncaught exception", () => {
  const moduleUrl = new URL("../../lib/axiosFetch.js", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", `
    import dns from "node:dns/promises";
    import net from "node:net";

    let publicLookups = 0;
    dns.lookup = async () => {
      publicLookups += 1;
      return [{ address: "203.0.113.1", family: 4 }];
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
  `], { encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    code: "EINJECTED",
    publicLookups: 1,
    request: { method: "GET", url: "https://example.test" },
  });
});

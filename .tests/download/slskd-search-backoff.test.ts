import { test, beforeEach, afterAll, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  createMockHttpServer,
  resetDatabase,
} from "../helpers/backendTestHarness.ts";
const [state, { SlskdClient }, { db }] = await setupIsolatedBackend(
  "slskd-backoff",
  "backend/services/slskdClient.ts",
  "backend/config/db-sqlite.ts",
);
afterAll(() => cleanupIsolatedState(state));
beforeEach(() => resetDatabase(db));

test("searches from different processes start at least five seconds apart", async () => {
  const started = [];
  let mainStartedAt;
  const server = await createMockHttpServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.method === "POST" && req.url === "/api/v0/searches") started.push(Date.now());
      res.writeHead(201, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  const worker = fork(new URL("../helpers/slskdSearchStartWorker.ts", import.meta.url), [], {
    env: { ...process.env, SLSKD_TEST_URL: server.url },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  try {
    const [message] = await once(worker, "message");
    assert.deepEqual(message, { done: true });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: Date.now() });
    const search = new SlskdClient({ enabled: true, url: server.url }).createSearch("Main search", {
      id: "main-search",
      onSearchCreated: () => {
        mainStartedAt ??= Date.now();
      },
    });
    await vi.advanceTimersByTimeAsync(5000);
    await search;
    assert.equal(started.length, 2);
    assert.ok(
      mainStartedAt - started[0] >= 4500,
      `searches started ${mainStartedAt - started[0]}ms apart`,
    );
  } finally {
    vi.useRealTimers();
    if (worker.exitCode == null) worker.kill();
    await server.close();
  }
});

test("downloads enqueue during cross-process search backoff without bypassing search throttling", async () => {
  let notifyFirstSearch;
  const firstSearch = new Promise((resolve) => {
    notifyFirstSearch = resolve;
  });
  const searches = [];
  const server = await createMockHttpServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/api/v0/searches") {
        const data = JSON.parse(body);
        searches.push(data);
        res.statusCode = searches.length === 1 ? 429 : 201;
        res.end("{}");
        if (searches.length === 1) notifyFirstSearch();
      } else {
        res.statusCode = 201;
        res.end("{}");
      }
    });
  });
  const worker = fork(new URL("../helpers/slskdSearchBackoffWorker.ts", import.meta.url), [], {
    env: { ...process.env, SLSKD_TEST_URL: server.url },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  const workerFinished = once(worker, "message");
  const workerExited = once(worker, "exit");
  const cancelOtherSearch = new AbortController();
  let enqueue;
  let otherSearch;
  try {
    await firstSearch;
    const client = new SlskdClient({ enabled: true, url: server.url });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: Date.now() });
    otherSearch = client.createSearch("Second", {
      id: "following-search",
      signal: cancelOtherSearch.signal,
    });
    let enqueued = false;
    enqueue = client
      .enqueueBatch({ username: "peer", files: [{ filename: "First.flac", size: 1000 }] })
      .finally(() => {
        enqueued = true;
      });
    const enqueueDeadline = performance.now() + 2000;
    while (!enqueued && performance.now() < enqueueDeadline) {
      await new Promise(setImmediate);
      await vi.advanceTimersByTimeAsync(1);
    }
    assert.ok(enqueued, "Download enqueue was blocked by search backoff");
    await enqueue;
    await vi.advanceTimersByTimeAsync(10000);
    assert.equal(searches.length, 1, "another search must not bypass the backoff");
    worker.send("advance");
    const [message] = await workerFinished;
    assert.deepEqual(message, { done: true });
    await vi.advanceTimersByTimeAsync(10000);
    await otherSearch;
    assert.deepEqual(
      searches.map((search) => search.id),
      ["backing-off-search", "backing-off-search", "following-search"],
    );
    assert.ok(
      searches[1].searchTimeout < searches[0].searchTimeout,
      "retry must use the remaining deadline",
    );
  } finally {
    cancelOtherSearch.abort();
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(1000);
    vi.useRealTimers();
    if (worker.exitCode == null) worker.kill();
    await Promise.allSettled([enqueue, otherSearch, workerExited]);
    await server.close();
  }
});

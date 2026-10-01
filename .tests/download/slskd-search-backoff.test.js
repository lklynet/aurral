import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { setupIsolatedBackend, cleanupIsolatedState, createMockHttpServer } from "../helpers/backendTestHarness.js";
const [state, { SlskdClient }] = await setupIsolatedBackend("slskd-backoff", "backend/services/slskdClient.js");
test.after(() => cleanupIsolatedState(state));

test("downloads enqueue during cross-process search backoff without bypassing search throttling", async () => {
  let notifyFirstSearch;
  const firstSearch = new Promise((resolve) => { notifyFirstSearch = resolve; });
  const searches = [];
  const server = await createMockHttpServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
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
  const worker = fork(new URL("../helpers/slskdSearchBackoffWorker.js", import.meta.url), [], {
    env: { ...process.env, SLSKD_TEST_URL: server.url }, stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  const workerFinished = once(worker, "message");
  let enqueue;
  let otherSearch;
  let timer;
  try {
    await firstSearch;
    const client = new SlskdClient({ enabled: true, url: server.url });
    otherSearch = client.createSearch("Second", { id: "following-search" });
    enqueue = client.enqueueBatch({ username: "peer", files: [{ filename: "First.flac", size: 1000 }] });
    await Promise.race([enqueue, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Download enqueue was blocked by search backoff")), 2000);
    })]);
    clearTimeout(timer);
    assert.equal(searches.length, 1, "another search must not bypass the backoff");
    worker.send("advance");
    const [message] = await workerFinished;
    assert.deepEqual(message, { done: true });
    await otherSearch;
    assert.deepEqual(searches.map((search) => search.id), ["backing-off-search", "backing-off-search", "following-search"]);
    assert.ok(searches[1].searchTimeout < searches[0].searchTimeout, "retry must use the remaining deadline");
  } finally {
    clearTimeout(timer);
    if (worker.connected) worker.send("advance");
    await Promise.allSettled([enqueue, otherSearch, workerFinished]);
    if (worker.exitCode == null) worker.kill();
    await server.close();
  }
});

import assert from "node:assert/strict";
import { getEventListeners, setMaxListeners } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vite-plus/test";
import honker from "@russellthehippo/honker-node";

test("Honker scheduler removes abort listeners after each timed wait", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "honker-abort-listener-test-"));
  const db = honker.open(path.join(tempDir, "honker.db"));
  const scheduler = db.scheduler();
  const controller = new AbortController();
  setMaxListeners(0, controller.signal);

  const ticked = Promise.withResolvers();
  let ticks = 0;
  scheduler.tick = () => {
    ticks += 1;
    if (ticks === 20) ticked.resolve();
    return [];
  };
  scheduler.soonest = () => Date.now() / 1000 + 0.001;
  const running = scheduler.run("test-worker", controller.signal);
  let listenerCount;

  try {
    await ticked.promise;
    listenerCount = getEventListeners(controller.signal, "abort").length;
  } finally {
    controller.abort();
    await running;
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  assert.ok(listenerCount <= 1, `scheduler retained ${listenerCount} abort listeners`);
});

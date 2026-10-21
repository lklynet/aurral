import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "vite-plus/test";
import honker from "@russellthehippo/honker-node";

test(
  "Honker scheduler reuses its pending native update wait across timeouts",
  { skip: !fs.existsSync("/proc/self/task") },
  async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "honker-timeout-test-"));
    const db = honker.open(path.join(tempDir, "honker.db"));
    const taskCount = () => fs.readdirSync("/proc/self/task").length;
    const baseline = taskCount();
    const scheduler = db.scheduler();
    const controller = new AbortController();

    scheduler.tick = () => [];
    scheduler.soonest = () => Date.now() / 1000 + 0.001;
    const running = scheduler.run("test-worker", controller.signal);
    let final;

    try {
      await delay(150);
      final = taskCount();
    } finally {
      controller.abort();
      await running;
      db.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }

    assert.ok(final - baseline <= 5, `native task count grew from ${baseline} to ${final}`);
  },
);

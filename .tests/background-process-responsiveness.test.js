import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { fileURLToPath } from "node:url";
import { createBackgroundProcessSupervisor } from "../backend/services/backgroundProcessSupervisor.js";

const fixture = fileURLToPath(new URL("./fixtures/blocking-background-child.mjs", import.meta.url));

test("a blocked background process leaves the web process event loop responsive", async () => {
  let child;
  let ready;
  let done;
  const readyPromise = new Promise((resolve) => {
    ready = resolve;
  });
  const donePromise = new Promise((resolve) => {
    done = resolve;
  });
  const dir = mkdtempSync(join(tmpdir(), "aurral-blocking-child-"));
  const blockingPath = join(dir, "blocking");
  const releasePath = join(dir, "release");
  const watcher = watch(dir);
  const childBlocking = new Promise((resolve) => {
    watcher.on("change", () => existsSync(blockingPath) && resolve());
  });
  const supervisor = createBackgroundProcessSupervisor({
    groups: ["library"],
    findGroupsWithWork: () => ["library"],
    forkProcess: (_entry, _args, options) => {
      child = fork(fixture, [], options);
      return child;
    },
    onMessage(message) {
      if (message?.type === "ready") ready();
      if (message?.type === "done") done(message.released);
    },
  });
  try {
    supervisor.start();
    let startupTimer;
    try {
      await Promise.race([
        readyPromise,
        new Promise((_, reject) => {
          startupTimer = setTimeout(() => reject(new Error("child did not start")), 5000);
        }),
      ]);
    } finally {
      clearTimeout(startupTimer);
    }
    child.send({ type: "block", blockingPath, releasePath });
    await childBlocking;
    await new Promise((resolve) => setTimeout(resolve, 0));
    writeFileSync(releasePath, "");
    assert.equal(await donePromise, true, "the web process must release the blocked child");
  } finally {
    watcher.close();
    await supervisor.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

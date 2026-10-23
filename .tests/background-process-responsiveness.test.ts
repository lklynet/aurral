import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { fileURLToPath } from "node:url";
import { createBackgroundProcessSupervisor } from "../backend/services/backgroundProcessSupervisor.ts";

const fixture = fileURLToPath(new URL("./fixtures/blocking-background-child.mts", import.meta.url));

test("a blocked background process leaves the web process event loop responsive", async () => {
  let child: import("node:child_process").ChildProcess | undefined;
  let ready!: () => void;
  let done!: (value: boolean) => void;
  const readyPromise = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const donePromise = new Promise<boolean>((resolve) => {
    done = resolve;
  });
  const dir = mkdtempSync(join(tmpdir(), "aurral-blocking-child-"));
  const blockingPath = join(dir, "blocking");
  const releasePath = join(dir, "release");
  const watcher = watch(dir);
  const childBlocking = new Promise<void>((resolve) => {
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
      if ("released" in message && typeof message.released === "boolean") done(message.released);
    },
  });
  try {
    supervisor.start();
    let startupTimer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        readyPromise,
        new Promise<void>((_, reject) => {
          startupTimer = setTimeout(() => reject(new Error("child did not start")), 5000);
        }),
      ]);
    } finally {
      clearTimeout(startupTimer);
    }
    assert.ok(child);
    child.send({ type: "block", blockingPath, releasePath });
    await childBlocking;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    writeFileSync(releasePath, "");
    assert.equal(await donePromise, true, "the web process must release the blocked child");
  } finally {
    watcher.close();
    await supervisor.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createBackgroundProcessSupervisor } from "../backend/services/backgroundProcessSupervisor.js";

const fixture = fileURLToPath(new URL("./fixtures/blocking-background-child.mjs", import.meta.url));

test("a blocked background process leaves the web process event loop responsive", async () => {
  let child;
  let ready;
  let done;
  const readyPromise = new Promise((resolve) => { ready = resolve; });
  const donePromise = new Promise((resolve) => { done = resolve; });
  const supervisor = createBackgroundProcessSupervisor({
    groups: ["library"],
    forkProcess: (_entry, _args, options) => {
      child = fork(fixture, [], options);
      return child;
    },
    onMessage(message) {
      if (message?.type === "ready") ready();
      if (message?.type === "done") done();
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
    child.send({ type: "block" });
    const first = await Promise.race([
      new Promise((resolve) => setTimeout(() => resolve("web"), 100)),
      donePromise.then(() => "worker"),
    ]);
    assert.equal(first, "web");
    await donePromise;
  } finally {
    await supervisor.stop();
  }
});

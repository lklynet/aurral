import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const probe = fileURLToPath(new URL("../fixtures/queue-supervisor-probe.mjs", import.meta.url));
for (const scenario of ["fallback", "expiry", "deadline"]) {
  test(`queue supervisor preserves ${scenario} discovery within its recovery budget`, () => {
    const result = spawnSync(process.execPath, [probe, scenario], {
      env: { ...process.env, AURRAL_WORKER_SUPERVISOR_POLL_MS: "" },
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  });
}

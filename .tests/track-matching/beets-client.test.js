import test from "node:test";
import assert from "node:assert/strict";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import {
  runMatcherOperation,
  resetMatcherAvailability,
  isBeetsMatcherAvailable,
} from "../../backend/services/trackMatching/beetsClient.js";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "matcher");
const stub = (name) => path.join(fixturesDir, name);

const hasSystemPython = (() => {
  const probe = spawnSync("python3", ["-c", "print(1)"], { timeout: 5000 });
  return probe.status === 0;
})();

test("beets client speaks the JSON protocol through a stub matcher", { skip: hasSystemPython ? false : "python3 unavailable" }, async () => {
  const outcome = await runMatcherOperation("health", {}, { pythonPath: "python3", scriptPath: stub("stub_ok.py") });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.result.beetsVersion, "stub-1.0.0");
});

test("beets client surfaces structured errors from the matcher", { skip: hasSystemPython ? false : "python3 unavailable" }, async () => {
  const outcome = await runMatcherOperation("rank_tracks", {}, { pythonPath: "python3", scriptPath: stub("stub_fail.py") });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.code, "internal_error");
  assert.equal(outcome.error.message, "stub failure");
});

test("beets client reports bad_response on non-JSON stdout", { skip: hasSystemPython ? false : "python3 unavailable" }, async () => {
  const outcome = await runMatcherOperation("health", {}, { pythonPath: "python3", scriptPath: stub("stub_junk.py") });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.code, "bad_response");
});

test("beets client enforces timeouts and kills the matcher process", { skip: hasSystemPython ? false : "python3 unavailable" }, async () => {
  const started = Date.now();
  const outcome = await runMatcherOperation("health", {}, {
    pythonPath: "python3",
    scriptPath: stub("stub_slow.py"),
    timeoutMs: 400,
  });
  const elapsed = Date.now() - started;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.code, "timeout");
  assert.ok(elapsed < 10000, `timeout enforced in ${elapsed}ms`);
});

test("beets client reports script_unavailable for a missing script", async () => {
  const outcome = await runMatcherOperation("health", {}, {
    pythonPath: "python3",
    scriptPath: "/nonexistent/aurral_matcher.py",
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.code, "script_unavailable");
});

test("beets client reports python_unavailable for a broken interpreter", { skip: hasSystemPython ? false : "python3 unavailable" }, async () => {
  const outcome = await runMatcherOperation("health", {}, {
    pythonPath: "/nonexistent/python-binary",
    scriptPath: stub("stub_ok.py"),
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.code, "python_unavailable");
});

test("availability probe caches its verdict", async () => {
  resetMatcherAvailability();
  const first = await isBeetsMatcherAvailable();
  const second = await isBeetsMatcherAvailable();
  assert.equal(typeof first, "boolean");
  assert.equal(first, second);
  resetMatcherAvailability();
});

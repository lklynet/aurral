import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vite-plus/test";
import type { LogEntry } from "../../backend/services/logger.ts";
import { requireFixture } from "../playlists/fixtures.ts";

const quiet = { log: console.log, warn: console.warn, error: console.error };

beforeEach(() => {
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
});

afterEach(() => {
  Object.assign(console, quiet);
});

async function freshLogger({ debug = false } = {}) {
  vi.resetModules();
  const logger = await import("../../backend/services/logger.ts");
  const entries: LogEntry[] = [];
  logger.startLogSink((item) => entries.push(item), { debugEnabled: () => debug });
  return { ...logger, entries };
}

test("entries carry their request, keep the stack, and mask secrets", async () => {
  const { logger, withLogContext, entries } = await freshLogger();
  const error = new Error("Lidarr rejected token=abc123");

  await withLogContext({ req: "r1" }, async () => {
    await Promise.resolve();
    logger.error("lidarr", "Request failed", {
      endpoint: "/api/v1/album",
      headers: { authorization: "Bearer secret" },
      error,
    });
  });

  const [saved] = entries;
  assert.ok(saved);
  assert.equal(saved.req, "r1");
  assert.equal(saved.proc, "main");
  assert.deepEqual(saved.data, { endpoint: "/api/v1/album", headers: { authorization: "***" } });
  assert.equal(saved.err?.message, "Lidarr rejected token=***");
  assert.match(saved.err?.stack ?? "", /^at /);
  assert.doesNotMatch(JSON.stringify(saved), /abc123|secret/);
});

test("repeats that differ only by ids and counts share a fingerprint", async () => {
  const { logger, entries } = await freshLogger();
  logger.warn("jobs", "Job 812 failed", { reason: 'No files for "Kid A"' });
  logger.warn("jobs", "Job 9001 failed", { reason: 'No files for "Amnesiac"' });
  logger.warn("jobs", "Job 9001 failed", { reason: "Lidarr unreachable" });

  assert.equal(entries[0]?.fp, requireFixture(entries[1]).fp);
  assert.notEqual(requireFixture(entries[1]).fp, requireFixture(entries[2]).fp);
});

test("console output is saved under the category from its tag", async () => {
  const { recordConsoleCall, entries } = await freshLogger();
  recordConsoleCall("warn", ["[BackgroundWorkers] inbox exited (1); restarting"]);
  recordConsoleCall("error", ["plain failure", new Error("boom")]);

  assert.partialDeepStrictEqual(entries, [
    { level: "warn", cat: "background-workers", msg: "inbox exited (1); restarting" },
    { level: "error", cat: "console", msg: "plain failure boom", err: { message: "boom" } },
  ]);
});

test("debug lines are saved only while debug logging is on", async () => {
  const off = await freshLogger();
  off.logger.debug("subsonic", "Authentication failed");
  assert.equal(off.entries.length, 0);

  const on = await freshLogger({ debug: true });
  on.logger.debug("subsonic", "Authentication failed");
  assert.equal(on.entries[0]?.level, "debug");
});

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vite-plus/test";
import {
  createLogWriter,
  readLogEntries,
  readLogProblems,
} from "../../backend/services/logFile.ts";
import type { LogEntry } from "../../backend/services/logger.ts";
import { requireFixture } from "../playlists/fixtures.ts";

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "aurral-logs-"));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const entry = (overrides: Partial<LogEntry> = {}): LogEntry => ({
  ts: new Date().toISOString(),
  level: "info",
  cat: "test",
  msg: "hello",
  proc: "main",
  fp: "fp-hello",
  ...overrides,
});

function writeAll(
  dir: string,
  entries: LogEntry[],
  options?: Parameters<typeof createLogWriter>[1],
) {
  const writer = createLogWriter(dir, options);
  for (const item of entries) {
    writer.append(item);
    writer.flush();
  }
}

test("the log rotates into a fixed set of files and reads back newest first", async () => {
  const dir = tempDir();
  writeAll(
    dir,
    Array.from({ length: 60 }, (_, index) => entry({ msg: `line ${index}` })),
    { maxBytes: 2000, files: 3 },
  );

  assert.deepEqual(readdirSync(dir).sort(), ["aurral.1.log", "aurral.2.log", "aurral.log"]);
  const entries = await readLogEntries(dir, { limit: 1000 });
  assert.equal(entries[0]?.msg, "line 59");
  assert.ok(entries.length < 60);
  assert.ok(
    entries.every((item, index) => index === 0 || item.id < requireFixture(entries[index - 1]).id),
  );
  assert.equal(entries.at(-1)?.msg, `line ${60 - entries.length}`);
});

test("queries filter by level, category, and text, and page with cursors", async () => {
  const dir = tempDir();
  writeAll(dir, [
    entry({ msg: "scan started", cat: "library" }),
    entry({ level: "warn", msg: "slskd search found nothing", cat: "downloads" }),
    entry({ level: "error", msg: "Lidarr returned 503", cat: "lidarr", req: "abc12345" }),
    entry({ level: "debug", msg: "cache hit", cat: "library" }),
  ]);

  const problems = await readLogEntries(dir, { level: "warn", limit: 10 });
  assert.deepEqual(
    problems.map((item) => item.msg),
    ["Lidarr returned 503", "slskd search found nothing"],
  );
  assert.deepEqual(
    (await readLogEntries(dir, { cat: "library", limit: 10 })).map((item) => item.msg),
    ["cache hit", "scan started"],
  );
  assert.deepEqual(
    (await readLogEntries(dir, { q: "SLSKD", limit: 10 })).map((item) => item.msg),
    ["slskd search found nothing"],
  );
  assert.deepEqual(
    (await readLogEntries(dir, { req: "abc12345", limit: 10 })).map((item) => item.msg),
    ["Lidarr returned 503"],
  );

  const [newest, second] = await readLogEntries(dir, { limit: 2 });
  assert.ok(newest && second);
  assert.deepEqual(
    (await readLogEntries(dir, { before: second.id, limit: 10 })).map((item) => item.msg),
    ["slskd search found nothing", "scan started"],
  );
  assert.deepEqual(
    (await readLogEntries(dir, { after: second.id, limit: 10 })).map((item) => item.id),
    [newest.id],
  );
});

test("problems group repeats of one failure with counts and the latest example", async () => {
  const dir = tempDir();
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const lidarr = { level: "error", cat: "lidarr", fp: "fp-lidarr" } as const;
  writeAll(dir, [
    entry({ ...lidarr, msg: "Lidarr returned 503", ts: hourAgo }),
    entry({ level: "warn", cat: "navidrome", msg: "Scan timed out", fp: "fp-navidrome" }),
    entry({ msg: "routine" }),
    entry({ ...lidarr, msg: "Lidarr returned 503", data: { attempt: 2 } }),
  ]);

  const problems = await readLogProblems(dir, { since: Date.now() - 2 * 60 * 60 * 1000 });
  assert.deepEqual(
    problems.map(({ fp, count }) => ({ fp, count })),
    [
      { fp: "fp-lidarr", count: 2 },
      { fp: "fp-navidrome", count: 1 },
    ],
  );
  assert.equal(problems[0]?.firstAt, hourAgo);
  assert.deepEqual(problems[0]?.latest.data, { attempt: 2 });

  const recent = await readLogProblems(dir, { since: Date.now() - 30 * 60 * 1000 });
  assert.equal(recent.find((problem) => problem.fp === "fp-lidarr")?.count, 1);
});

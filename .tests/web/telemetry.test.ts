import type BetterSqlite3 from "better-sqlite3";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { afterEach, test, vi } from "vite-plus/test";
import type { TelemetryReport } from "../../lib/telemetry.ts";

const backendRequire = createRequire(new URL("../../backend/package.json", import.meta.url));
const Database: typeof BetterSqlite3 = backendRequire("better-sqlite3");
const { onRequestPost } = await import("../../web/functions/api/telemetry.js");
const { onRequestGet: getStats } = await import("../../stats/functions/api/stats.js");

const DAY = 24 * 60 * 60 * 1000;

function fakeD1() {
  const sqlite = new Database(":memory:");
  return {
    sqlite,
    prepare(sql: string) {
      const bound = (values: unknown[]) => ({
        bind: (...next: unknown[]) => bound(next),
        first: async () => sqlite.prepare(sql).get(...values) ?? null,
        all: async () => ({ results: sqlite.prepare(sql).all(...values) }),
        run: async () => ({ meta: { changes: sqlite.prepare(sql).run(...values).changes } }),
      });
      return bound([]);
    },
    batch: (statements: { run: () => Promise<unknown> }[]) =>
      Promise.all(statements.map((statement) => statement.run())),
  };
}

const report: TelemetryReport = {
  schema: 1,
  version: "2.20.0",
  docker: true,
  os: "linux",
  arch: "x64",
  scale: { users: "1", tracks: "10k-99k" },
  integrations: ["lidarr"],
  auth: [],
  settings: ["inbox"],
  dateTimeFormat: "browser",
  discovery: "lastfm",
  listening: {},
  playbackServers: {},
  plays: { aurral: "10-99" },
  downloads: { slskd: { done: "10-99", failed: "1" } },
  imports: {},
  appearance: { dark: "1" },
  themes: { aurral: "1" },
  seen: {
    pages: ["discover"],
    devices: [],
    os: [],
    browsers: [],
    subsonicClients: [],
    display: [],
  },
  problems: {},
  deprecations: [],
};

const post = (db: ReturnType<typeof fakeD1>, body: unknown) =>
  onRequestPost({
    env: { TELEMETRY_DB: db },
    request: new Request("https://aurral.org/api/telemetry", {
      method: "POST",
      headers: { "cf-connecting-ip": "203.0.113.9" },
      body: JSON.stringify(body),
    }),
  });

const stored = (db: ReturnType<typeof fakeD1>) =>
  db.sqlite.prepare<[], { report: string }>("SELECT report FROM telemetry_reports").all();

test("a valid report is stored without the sender's address", async () => {
  const db = fakeD1();
  assert.equal((await post(db, report)).status, 204);
  const rows = stored(db);
  assert.equal(rows.length, 1);
  assert.deepEqual(JSON.parse(rows[0]!.report), report);
  assert.doesNotMatch(
    JSON.stringify(db.sqlite.prepare("SELECT * FROM telemetry_reports").all()),
    /203\.0\.113\.9/,
  );
});

test("reports with extra fields, free text, or unofficial versions are refused", async () => {
  const db = fakeD1();
  await post(db, report);
  for (const body of [
    { ...report, hostname: "home-server" },
    { ...report, integrations: ["https://lidarr.home.lan"] },
    { ...report, version: "my-fork" },
    { ...report, scale: { users: 7 } },
    { ...report, seen: { ...report.seen, path: "/music/private" } },
    { ...report, downloads: { slskd: { done: "1" } } },
    Object.fromEntries(Object.entries(report).filter(([key]) => key !== "docker")),
  ]) {
    assert.equal((await post(db, body)).status, 400);
  }
  assert.equal(stored(db).length, 1);
});

afterEach(() => {
  vi.useRealTimers();
});

const statsOn = async (db: ReturnType<typeof fakeD1>, at: number) => {
  vi.setSystemTime(at);
  return (await getStats({ env: { TELEMETRY_DB: db } })).json();
};

test("stats count each server once in the last 3 full days and compare with 30 days ago", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const today = Date.UTC(2026, 10, 4);
  const db = fakeD1();
  vi.setSystemTime(today - 31 * DAY);
  await post(db, { ...report, integrations: [] });
  vi.setSystemTime(today - 2 * DAY);
  await post(db, report);
  await post(db, { ...report, integrations: ["lidarr", "slskd"] });
  vi.setSystemTime(today + 1000);
  await post(db, { ...report, integrations: ["deemix"] });

  const stats = await statsOn(db, today + 2000);
  const count = (facts: { path: string; value: unknown; n: number }[], value: string) =>
    facts.find((fact) => fact.path === "$.integrations" && fact.value === value)?.n ?? 0;

  assert.equal(stats.installs, 2);
  assert.equal(count(stats.facts, "lidarr"), 2);
  assert.equal(count(stats.facts, "slskd"), 1);
  assert.equal(count(stats.facts, "deemix"), 0);
  assert.equal(stats.previous.installs, 1);
  assert.equal(count(stats.previous.facts, "lidarr"), 0);
});

test("stats answer with zero servers before the first report arrives", async () => {
  const stats = await (await getStats({ env: { TELEMETRY_DB: fakeD1() } })).json();
  assert.equal(stats.installs, 0);
  assert.equal(stats.previous.installs, 0);
});

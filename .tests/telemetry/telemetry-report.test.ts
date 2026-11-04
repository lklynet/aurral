import assert from "node:assert/strict";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, test } from "vite-plus/test";
import { TELEMETRY_INTERVAL_MS, isTelemetryReport } from "../../lib/telemetry.ts";
import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.ts";

const previousVersion = process.env.APP_VERSION;
process.env.APP_VERSION = "2.20.0";
const [
  isolatedState,
  { db },
  { dbOps },
  telemetry,
  { buildTelemetryReport, sendTelemetryReport },
  { createLogWriter },
] = await setupIsolatedBackend(
  "telemetry-report",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/services/telemetry.ts"),
  () => import("../../backend/services/telemetryReport.ts"),
  () => import("../../backend/services/logFile.ts"),
);
process.env.APP_VERSION = previousVersion;

const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

const realFetch = globalThis.fetch;
let sent: unknown[] = [];

beforeEach(() => {
  resetDatabase(db);
  db.prepare("DELETE FROM settings WHERE key LIKE 'telemetry%' OR key LIKE 'user:%'").run();
  db.prepare("DELETE FROM users").run();
  dbOps.invalidateSettingsCache();
  sent = [];
  globalThis.fetch = async (_url, init) => {
    sent.push(JSON.parse(String(init?.body)));
    return new Response(null, { status: 204 });
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

afterAll(async () => {
  await cleanupIsolatedState(isolatedState);
});

const addUser = (username: string, role = "user") =>
  Number(
    db
      .prepare("INSERT INTO users (username, password_hash, role) VALUES (?, 'x', ?)")
      .run(username, role).lastInsertRowid,
  );

test("the report fits the schema aurral.org accepts and holds only buckets", async () => {
  const adminId = addUser("zebra", "admin");
  addUser("quokka");
  dbOps.setUserTheme(adminId, {
    version: 2,
    themeId: "mine",
    appearance: "dark",
    themes: [
      { id: "mine", name: "Midnight Velvet", dark: { background: "#000000", accent: "#ff0000" } },
    ],
  });
  db.prepare(
    `INSERT INTO playlist_download_jobs
       (id, artist_name, track_name, playlist_id, status, created_at, completed_at, download_source)
     VALUES ('a', 'Boards of Canada', 'Roygbiv', 'p', 'done', ?, ?, 'slskd'),
            ('b', 'Boards of Canada', 'Dayvan Cowboy', 'p', 'failed', ?, ?, 'slskd')`,
  ).run(Date.now(), Date.now(), Date.now(), Date.now());
  telemetry.setTelemetryEnabled(true);
  telemetry.noteClientSeen("news", true, IPHONE);
  telemetry.noteSubsonicClient("Symfonium");

  const report = await buildTelemetryReport();
  assert.ok(isTelemetryReport(report));

  assert.equal(report.scale.users, "2-9");
  assert.equal(report.scale.admins, "1");
  assert.deepEqual(report.appearance, { dark: "1", system: "1" });
  assert.deepEqual(report.themes, { custom: "1", aurral: "1" });
  assert.deepEqual(report.downloads, { slskd: { done: "1", failed: "1" } });
  assert.deepEqual(report.seen, {
    pages: ["news"],
    devices: ["mobile"],
    os: ["ios"],
    browsers: ["safari"],
    subsonicClients: ["symfonium"],
    display: ["pwa"],
  });
  assert.doesNotMatch(JSON.stringify(report), /zebra|quokka|Midnight|Boards|Roygbiv|Dayvan/);
});

test("problems count every warning, not just the first 200 kinds", async () => {
  const writer = createLogWriter(join(isolatedState.dataDir, "logs"));
  for (let index = 0; index < 1100; index += 1) {
    const msg = `Lidarr returned ${index}`;
    writer.append({
      ts: new Date().toISOString(),
      level: "warn",
      cat: "lidarr",
      msg,
      proc: "main",
      fp: msg,
    });
  }
  writer.flush();

  assert.deepEqual((await buildTelemetryReport()).problems.lidarr, {
    warn: "1k-9k",
    error: "0",
  });
});

test("admins are asked once, and choosing in Settings counts as asked", async () => {
  assert.equal(telemetry.claimTelemetryAsk(), true);
  assert.equal(telemetry.claimTelemetryAsk(), false);

  db.prepare("DELETE FROM settings WHERE key = 'telemetry'").run();
  telemetry.setTelemetryEnabled(false);
  assert.equal(telemetry.claimTelemetryAsk(), false);
});

test("nothing is noted while usage stats are off", async () => {
  telemetry.noteClientSeen("wrapped", false, IPHONE);
  telemetry.setTelemetryEnabled(true);

  assert.deepEqual((await buildTelemetryReport()).seen.pages, []);
});

test("a report goes out once every three days, and only when turned on", async () => {
  const start = Date.now();
  assert.equal(await sendTelemetryReport(start), false);

  telemetry.setTelemetryEnabled(true);
  assert.equal(await sendTelemetryReport(start), true);
  assert.equal(await sendTelemetryReport(start + TELEMETRY_INTERVAL_MS - 1), false);
  assert.equal(await sendTelemetryReport(start + TELEMETRY_INTERVAL_MS), true);

  assert.equal(sent.length, 2);
  assert.ok(sent.every(isTelemetryReport));
});

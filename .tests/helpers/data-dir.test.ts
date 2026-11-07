import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

test("the test runner isolates each process from the repository database", () => {
  const dbPath = process.env.AURRAL_DB_PATH;
  assert.ok(dbPath, "AURRAL_DB_PATH must be set by .tests/setup-env.ts");
  assert.equal(
    path.resolve(dbPath).startsWith(path.resolve("backend", "data")),
    false,
    "concurrent test processes must not share backend/data/aurral.db",
  );
});

test("ensureDataDir creates the resolved directory", async () => {
  const tempDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aurral-data-dir-")), "nested");
  const previous = process.env.AURRAL_DATA_DIR;
  process.env.AURRAL_DATA_DIR = tempDir;
  const { ensureDataDir } = await import("../../backend/config/data-dir.ts");
  assert.equal(ensureDataDir(), path.resolve(tempDir));
  assert.equal(fs.existsSync(tempDir), true);
  if (previous === undefined) delete process.env.AURRAL_DATA_DIR;
  else process.env.AURRAL_DATA_DIR = previous;
});

test("a database only in /app/backend/data is reported, not opened from /config", async () => {
  const { databaseOnlyInLegacyDataDir } = await import("../../backend/config/data-dir.ts");
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "aurral-legacy-data-dir-"));
  const canonical = path.join(base, "config");
  const legacy = path.join(base, "legacy");
  fs.mkdirSync(canonical);
  fs.mkdirSync(legacy);
  const check = () => databaseOnlyInLegacyDataDir({ canonical, legacy });
  const previous = { dataDir: process.env.AURRAL_DATA_DIR, dbPath: process.env.AURRAL_DB_PATH };
  delete process.env.AURRAL_DATA_DIR;
  delete process.env.AURRAL_DB_PATH;
  try {
    assert.equal(check(), false);
    fs.writeFileSync(path.join(legacy, "aurral.db"), "");
    assert.equal(check(), true);
    fs.writeFileSync(path.join(canonical, "aurral.db"), "");
    assert.equal(check(), false);
  } finally {
    if (previous.dataDir !== undefined) process.env.AURRAL_DATA_DIR = previous.dataDir;
    if (previous.dbPath !== undefined) process.env.AURRAL_DB_PATH = previous.dbPath;
    fs.rmSync(base, { recursive: true, force: true });
  }
});

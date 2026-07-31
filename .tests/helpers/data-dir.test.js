import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

test("the test runner isolates each process from the repository database", () => {
  const dbPath = process.env.AURRAL_DB_PATH;
  assert.ok(dbPath, "AURRAL_DB_PATH must be set by .tests/setup-env.js");
  assert.equal(
    path.resolve(dbPath).startsWith(path.resolve("backend", "data")),
    false,
    "concurrent test processes must not share backend/data/aurral.db",
  );
});

test("resolveAurralDataDir prefers AURRAL_DATA_DIR", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aurral-data-dir-"));
  const previous = process.env.AURRAL_DATA_DIR;
  process.env.AURRAL_DATA_DIR = tempDir;
  const { resolveAurralDataDir } = await import(
    "../../backend/config/data-dir.js"
  );
  assert.equal(resolveAurralDataDir(), path.resolve(tempDir));
  if (previous === undefined) delete process.env.AURRAL_DATA_DIR;
  else process.env.AURRAL_DATA_DIR = previous;
});

test("ensureDataDir creates the resolved directory", async () => {
  const tempDir = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "aurral-data-dir-")),
    "nested",
  );
  const previous = process.env.AURRAL_DATA_DIR;
  process.env.AURRAL_DATA_DIR = tempDir;
  const { ensureDataDir } = await import("../../backend/config/data-dir.js");
  assert.equal(ensureDataDir(), path.resolve(tempDir));
  assert.equal(fs.existsSync(tempDir), true);
  if (previous === undefined) delete process.env.AURRAL_DATA_DIR;
  else process.env.AURRAL_DATA_DIR = previous;
});

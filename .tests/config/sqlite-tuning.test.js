import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { applySqliteTuning, resolveSqliteTuning } from "../../backend/config/sqlite-tuning.js";

test("resolveSqliteTuning uses the defaults when nothing is set", () => {
  assert.deepEqual(resolveSqliteTuning({ env: {} }), { cacheMb: 64, mmapMb: 256 });
  assert.deepEqual(resolveSqliteTuning({ env: {}, worker: true }), { cacheMb: 16, mmapMb: 256 });
});

test("resolveSqliteTuning honours environment overrides and ignores bad values", () => {
  const env = { AURRAL_SQLITE_CACHE_MB: "512", AURRAL_SQLITE_MMAP_MB: "0" };
  assert.deepEqual(resolveSqliteTuning({ env }), { cacheMb: 512, mmapMb: 0 });
  assert.deepEqual(resolveSqliteTuning({ env, worker: true }), { cacheMb: 128, mmapMb: 0 });
  assert.deepEqual(
    resolveSqliteTuning({ env: { AURRAL_SQLITE_CACHE_MB: "lots", AURRAL_SQLITE_MMAP_MB: "-5" } }),
    { cacheMb: 64, mmapMb: 256 },
  );
  assert.equal(resolveSqliteTuning({ env: { AURRAL_SQLITE_CACHE_MB: "8" }, worker: true }).cacheMb, 16);
  assert.equal(resolveSqliteTuning({ env: { AURRAL_SQLITE_CACHE_MB: "999999" } }).cacheMb, 16384);
});

test("applySqliteTuning sets the connection pragmas", () => {
  const db = new Database(":memory:");
  try {
    const tuning = applySqliteTuning(db, { env: { AURRAL_SQLITE_CACHE_MB: "32", AURRAL_SQLITE_MMAP_MB: "16" } });
    assert.deepEqual(tuning, { cacheMb: 32, mmapMb: 16 });
    assert.equal(db.pragma("cache_size", { simple: true }), -32768);
    assert.equal(db.pragma("temp_store", { simple: true }), 2);
    assert.equal(db.pragma("busy_timeout", { simple: true }), 500);
    assert.equal(db.pragma("analysis_limit", { simple: true }), 400);
  } finally {
    db.close();
  }
});

test("worker connections wait longer for the write lock than the main thread", () => {
  const db = new Database(":memory:");
  try {
    applySqliteTuning(db, { worker: true, env: {} });
    assert.equal(db.pragma("busy_timeout", { simple: true }), 30000);
  } finally {
    db.close();
  }
});

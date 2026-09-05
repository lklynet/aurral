import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  cleanupIsolatedState,
  importFromRepo,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { db }] = await setupIsolatedBackend(
  "scan-worker-thread",
  "backend/config/db-sqlite.js",
);
const queryService = await importFromRepo("backend/services/libraryQueryService.js");
const { runLibraryScanInWorker, isLibraryScanRunning } =
  await importFromRepo("backend/services/libraryScanRunner.js");

let musicRoot;

test.before(async () => {
  musicRoot = await mkdtemp(path.join(tmpdir(), "aurral-scan-thread-"));
  const filePath = path.join(musicRoot, "Thread Artist", "Thread Album", "01 Thread Track.flac");
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, "fixture");
});

test.after(async () => {
  await rm(musicRoot, { recursive: true, force: true });
  await cleanupIsolatedState(isolatedState);
});

test("a library scan runs in a worker thread and invalidates main-thread caches", async () => {
  // Warm the main-thread cache with the empty library first.
  assert.deepEqual(queryService.getCanonicalArtistKeys(), []);

  const scan = runLibraryScanInWorker({ includeLidarr: false, musicRoot });
  assert.equal(isLibraryScanRunning(), true);
  const result = await scan;

  assert.equal(isLibraryScanRunning(), false);
  assert.equal(result.local.changed, true);
  assert.equal(result.local.filesIndexed, 1);
  assert.equal(result.lidarr.skipped, true);
  assert.equal(
    db.prepare("SELECT status FROM library_scan_runs WHERE source = 'aurral' ORDER BY id DESC LIMIT 1")
      .get()?.status,
    "complete",
  );
  assert.deepEqual(
    queryService.getCanonicalArtistKeys().map((artist) => artist.name),
    ["Thread Artist"],
  );
  assert.ok(db.prepare(
    "SELECT 1 FROM library_search_documents WHERE entity_kind = 'track' AND title = 'Thread Track'",
  ).get());
});

test("a second scan waits for the running one instead of overlapping", async () => {
  const first = runLibraryScanInWorker({ includeLidarr: false, musicRoot });
  const second = runLibraryScanInWorker({ includeLidarr: false, musicRoot });
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(firstResult.local.changed, false);
  assert.equal(secondResult.local.changed, false);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM library_scan_runs WHERE source = 'aurral'").get().count,
    3,
  );
});

test("a worker failure surfaces as a rejected scan", async () => {
  await assert.rejects(
    runLibraryScanInWorker({ includeLidarr: false, musicRoot: "\0invalid" }),
    /ERR_INVALID_ARG_VALUE|invalid|null bytes/i,
  );
  assert.equal(isLibraryScanRunning(), false);
});

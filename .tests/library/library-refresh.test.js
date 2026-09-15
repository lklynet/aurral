import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "node:events";

process.env.NODE_ENV = "test";

const { registerCanonical } = await import(
  "../../backend/routes/library/handlers/canonical.js"
);
const {
  claimScheduledLibraryScanJob,
  clearScheduledLibraryScan,
  getScheduledLibraryScanJobId,
  onLibraryScanFinalFailure,
  onLibraryScanSuccess,
  scheduleLibraryScan,
  stopLibraryScanWorker,
} = await import("../../backend/services/libraryScanWorker.js");
const { dbOps } = await import("../../backend/db/helpers/index.js");
const { db } = await import("../../backend/config/db-sqlite.js");
const { beginLibraryScan, finishLibraryScan } = await import(
  "../../backend/services/libraryMediaStore.js"
);
const { processSystemTask } = await import("../../backend/services/systemTaskWorker.js");
const {
  getLibraryScanQueue,
  SCHEDULED_SYSTEM_TASKS,
} = await import("../../backend/services/honkerDb.js");
const { createLibraryFileWatcher, resolveLibraryWatchRoots } = await import(
  "../../backend/services/libraryFileWatcher.js"
);
const { lidarrClient } = await import("../../backend/services/lidarrClient.js");

test("library scans are not scheduled as a recurring background task", () => {
  assert.equal(
    SCHEDULED_SYSTEM_TASKS.some((task) => task.name === "library-index-refresh"),
    false,
  );
});

test("library bootstrap runs only until the first completed scan", async () => {
  const queue = getLibraryScanQueue();
  db.prepare("DELETE FROM library_scan_runs").run();
  clearScheduledLibraryScan();
  let bootstrapJobId;
  try {
    await processSystemTask({ kind: "library-index-bootstrap" });
    bootstrapJobId = getScheduledLibraryScanJobId();
    assert.ok(bootstrapJobId);
    queue.cancel(bootstrapJobId);
    clearScheduledLibraryScan();

    const scanId = beginLibraryScan({ source: "test" });
    finishLibraryScan(scanId);
    await processSystemTask({ kind: "library-index-bootstrap" });
    assert.equal(getScheduledLibraryScanJobId(), null);
  } finally {
    if (bootstrapJobId) queue.cancel(bootstrapJobId);
    clearScheduledLibraryScan();
    db.prepare("DELETE FROM library_scan_runs WHERE source = 'test'").run();
  }
});

test("library refresh queues a forced scan and exposes its queue status", async () => {
  const existingJobId = Number(dbOps.getJSONSetting("pendingLibraryScanJob")?.jobId);
  if (Number.isSafeInteger(existingJobId)) getLibraryScanQueue().cancel(existingJobId);
  clearScheduledLibraryScan();

  const routes = new Map();
  registerCanonical({
    get(path, ...handlers) {
      routes.set(`GET ${path}`, handlers.at(-1));
    },
    post(path, ...handlers) {
      routes.set(`POST ${path}`, handlers.at(-1));
    },
  });

  let body;
  let statusCode = 200;
  let refreshJobId;
  const response = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(value) {
      body = value;
      return this;
    },
  };

  try {
    await routes.get("POST /refresh")({ user: { id: 1 } }, response);
    assert.equal(statusCode, 202);
    assert.equal(body.queued, true);
    assert.equal(body.status.status, "queued");
    assert.deepEqual(JSON.parse(getLibraryScanQueue().getJob(body.jobId).payload), {
      force: true,
      includeLidarr: true,
    });
    const jobId = body.jobId;
    refreshJobId = jobId;

    body = undefined;
    await routes.get("GET /refresh")({ user: { id: 1 } }, response);
    assert.equal(body.jobId, jobId);
    assert.equal(body.status.status, "queued");

    body = undefined;
    await routes.get("GET /refresh/:jobId")(
      { user: { id: 1 }, params: { jobId } },
      response,
    );
    assert.equal(body.status, "queued");
    body.jobId = jobId;
  } finally {
    if (refreshJobId || body?.jobId) getLibraryScanQueue().cancel(refreshJobId || body.jobId);
    clearScheduledLibraryScan();
    await new Promise((resolve) => setImmediate(resolve));
    await stopLibraryScanWorker();
  }
});

test("library scan scheduling keeps one live job and recovers stale registry entries", () => {
  const queue = getLibraryScanQueue();
  clearScheduledLibraryScan();
  let firstJob;
  let secondJob;
  try {
    firstJob = scheduleLibraryScan();
    const claimed = queue.claimOne("library-scan-test");
    assert.equal(claimed?.id, firstJob);
    assert.equal(claimScheduledLibraryScanJob(firstJob), true);
    assert.equal(scheduleLibraryScan(), firstJob);

    queue.cancel(firstJob);
    secondJob = scheduleLibraryScan();
    assert.notEqual(secondJob, firstJob);
    assert.equal(getScheduledLibraryScanJobId(), secondJob);
  } finally {
    if (firstJob) queue.cancel(firstJob);
    if (secondJob) queue.cancel(secondJob);
    clearScheduledLibraryScan();
  }
});

test("library refresh replaces a scan whose processing claim expired", () => {
  const queue = getLibraryScanQueue();
  clearScheduledLibraryScan();
  let staleJobId;
  let replacementJobId;
  try {
    staleJobId = scheduleLibraryScan();
    const claimed = queue.claimOne("stale-library-scan-test");
    assert.equal(claimed?.id, staleJobId);
    db.prepare("UPDATE _honker_live SET claim_expires_at = ? WHERE id = ?").run(
      Math.floor(Date.now() / 1000) - 1,
      staleJobId,
    );

    replacementJobId = scheduleLibraryScan({ force: true });

    assert.notEqual(replacementJobId, staleJobId);
    assert.equal(queue.getJob(staleJobId), null);
    assert.deepEqual(JSON.parse(queue.getJob(replacementJobId).payload), {
      force: true,
      includeLidarr: true,
    });
  } finally {
    if (staleJobId) queue.cancel(staleJobId);
    if (replacementJobId) queue.cancel(replacementJobId);
    clearScheduledLibraryScan();
  }
});

test("a full refresh upgrades a pending local-only scan", () => {
  const queue = getLibraryScanQueue();
  clearScheduledLibraryScan();
  let jobId;
  try {
    jobId = scheduleLibraryScan({ includeLidarr: false });
    assert.deepEqual(JSON.parse(queue.getJob(jobId).payload), {
      force: false,
      includeLidarr: false,
    });
    assert.equal(scheduleLibraryScan({ includeLidarr: true }), jobId);
    assert.equal(dbOps.getJSONSetting("pendingLibraryScanJob").includeLidarr, true);
  } finally {
    if (jobId) queue.cancel(jobId);
    clearScheduledLibraryScan();
  }
});

test("pending watcher scans merge changed paths into one job", () => {
  const queue = getLibraryScanQueue();
  clearScheduledLibraryScan();
  let jobId;
  try {
    jobId = scheduleLibraryScan({
      includeLidarr: false,
      changedPaths: ["/data/music/Artist/Album/01 Track.flac"],
    });
    assert.equal(scheduleLibraryScan({
      changedPaths: ["/data/music/Artist/Album/02 Track.flac"],
    }), jobId);
    assert.deepEqual(dbOps.getJSONSetting("pendingLibraryScanJob").changedPaths, [
      "/data/music/Artist/Album/01 Track.flac",
      "/data/music/Artist/Album/02 Track.flac",
    ]);
  } finally {
    if (jobId) queue.cancel(jobId);
    clearScheduledLibraryScan();
  }
});

test("watcher paths do not downgrade a queued full scan", () => {
  const queue = getLibraryScanQueue();
  clearScheduledLibraryScan();
  let jobId;
  try {
    jobId = scheduleLibraryScan({ includeLidarr: false });
    assert.equal(scheduleLibraryScan({
      includeLidarr: false,
      changedPaths: ["/data/music/Artist/Album/01 Track.flac"],
    }), jobId);
    assert.equal("changedPaths" in dbOps.getJSONSetting("pendingLibraryScanJob"), false);
  } finally {
    if (jobId) queue.cancel(jobId);
    clearScheduledLibraryScan();
  }
});

test("an oversized active watcher merge requests a full rescan", () => {
  const queue = getLibraryScanQueue();
  clearScheduledLibraryScan();
  let jobId;
  try {
    jobId = scheduleLibraryScan({
      includeLidarr: false,
      changedPaths: ["/data/music/in-flight.flac"],
    });
    assert.equal(queue.claimOne("overflow-library-scan-test")?.id, jobId);
    assert.equal(claimScheduledLibraryScanJob(jobId), true);
    dbOps.setJSONSetting("pendingLibraryScanJob", {
      jobId,
      includeLidarr: false,
      changedPaths: Array.from({ length: 4096 }, (_, index) => `/data/music/${index}.flac`),
      inFlightActive: true,
      inFlightPaths: ["/data/music/in-flight.flac"],
      fullRescanPending: false,
    });

    scheduleLibraryScan({
      includeLidarr: false,
      changedPaths: ["/data/music/overflow.flac"],
    });

    const registry = dbOps.getJSONSetting("pendingLibraryScanJob");
    assert.equal(registry.fullRescanPending, true);
    assert.deepEqual(registry.changedPaths, []);
  } finally {
    if (jobId) queue.cancel(jobId);
    clearScheduledLibraryScan();
  }
});

test("stale targeted scans retain in-flight and pending paths", () => {
  const queue = getLibraryScanQueue();
  clearScheduledLibraryScan();
  let staleJobId;
  let replacementJobId;
  try {
    staleJobId = scheduleLibraryScan({
      includeLidarr: false,
      changedPaths: ["/data/music/initial.flac"],
    });
    assert.equal(queue.claimOne("stale-targeted-library-scan-test")?.id, staleJobId);
    assert.equal(claimScheduledLibraryScanJob(staleJobId), true);
    dbOps.setJSONSetting("pendingLibraryScanJob", {
      jobId: staleJobId,
      includeLidarr: false,
      changedPaths: ["/data/music/pending.flac"],
      inFlightActive: true,
      inFlightPaths: ["/data/music/in-flight.flac"],
      fullRescanPending: false,
    });
    db.prepare("UPDATE _honker_live SET claim_expires_at = ? WHERE id = ?").run(
      Math.floor(Date.now() / 1000) - 1,
      staleJobId,
    );

    replacementJobId = scheduleLibraryScan({
      includeLidarr: false,
      changedPaths: ["/data/music/new.flac"],
    });

    assert.deepEqual(dbOps.getJSONSetting("pendingLibraryScanJob").changedPaths, [
      "/data/music/in-flight.flac",
      "/data/music/pending.flac",
      "/data/music/new.flac",
    ]);
  } finally {
    if (staleJobId) queue.cancel(staleJobId);
    if (replacementJobId) queue.cancel(replacementJobId);
    clearScheduledLibraryScan();
  }
});

test("claiming an unregistered scan does not inherit stale Lidarr mode", () => {
  const queue = getLibraryScanQueue();
  clearScheduledLibraryScan();
  let jobId;
  try {
    jobId = scheduleLibraryScan({ includeLidarr: false });
    dbOps.setJSONSetting("pendingLibraryScanJob", { includeLidarr: true });
    assert.equal(claimScheduledLibraryScanJob(jobId), true);
    assert.deepEqual(dbOps.getJSONSetting("pendingLibraryScanJob"), {
      jobId,
      includeLidarr: false,
    });
  } finally {
    if (jobId) queue.cancel(jobId);
    clearScheduledLibraryScan();
  }
});

test("terminal library scan outcomes clear the persistent registry", () => {
  const queue = getLibraryScanQueue();
  let successJob;
  let failedJob;
  try {
    successJob = scheduleLibraryScan();
    onLibraryScanSuccess(null, { id: successJob });
    assert.equal(getScheduledLibraryScanJobId(), null);

    failedJob = scheduleLibraryScan();
    onLibraryScanFinalFailure({ id: failedJob });
    assert.equal(getScheduledLibraryScanJobId(), null);
  } finally {
    if (successJob) queue.cancel(successJob);
    if (failedJob) queue.cancel(failedJob);
    clearScheduledLibraryScan();
  }
});

test("library file watcher debounces library changes and ignores generated folders", async () => {
  let onChange;
  let scheduled = 0;
  let changedRoots = [];
  let changedPaths = [];
  const watcher = createLibraryFileWatcher({
    roots: [process.cwd()],
    debounceMs: 5,
    watchImpl: (_root, _options, callback) => {
      onChange = callback;
      return { close() {} };
    },
    onChange: (roots, paths) => {
      scheduled += 1;
      changedRoots = roots;
      changedPaths = paths;
    },
  });

  onChange("change", "Artist/Album/track.flac");
  onChange("change", "Artist/Album/track.flac");
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(scheduled, 1);
  assert.deepEqual(changedRoots, [process.cwd()]);
  assert.deepEqual(changedPaths, [
    path.join(process.cwd(), "Artist/Album/track.flac"),
  ]);

  onChange("change", "aurral-weekly-flow/flow/track.flac");
  onChange("change", "_staging/track.flac");
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(scheduled, 1);

  watcher.close();
});

test("library watcher reuses configured roots without querying Lidarr", (t) => {
  const rootPath = path.resolve("/data/music");
  const pathProbe = t.mock.method(fs, "existsSync", () => { throw new Error("Main-thread path probe"); });
  t.mock.method(lidarrClient, "isEnabled", () => true);
  t.mock.method(lidarrClient, "getConfiguredRootFolderPaths", () => [rootPath]);
  const rootRequest = t.mock.method(lidarrClient, "getRootFolders", async () => {
    throw new Error("watcher should not discover roots");
  });

  assert.equal(resolveLibraryWatchRoots().some((root) => root?.path === rootPath), true);
  assert.equal(rootRequest.mock.callCount(), 0);
  assert.equal(pathProbe.mock.callCount(), 0);
});

test("library watcher creates roots without probing the filesystem on the main thread", (t) => {
  t.mock.method(fs, "existsSync", () => { throw new Error("Synchronous filesystem probe"); });
  const roots = [];
  const watcher = createLibraryFileWatcher({
    roots: ["", null, "/slow-root", "/slow-root"],
    watchImpl: (root) => { roots.push(root); return { close() {} }; },
  });
  watcher.close();
  assert.deepEqual(roots, ["/slow-root"]);
});

test("library watcher reports asynchronous errors and ignores callbacks after close", async () => {
  const errors = [];
  let changed;
  let closed = 0;
  const child = new EventEmitter();
  child.close = () => { closed++; };
  const watcher = createLibraryFileWatcher({
    roots: ["/library"],
    debounceMs: 1,
    watchImpl: (_root, _options, callback) => { changed = callback; return child; },
    onError: (error, root) => errors.push({ message: error.message, root }),
    onChange: () => assert.fail("Closed watcher scheduled a scan"),
  });
  child.emit("error", new Error("Watcher timeout"));
  assert.deepEqual(errors, [{ message: "Watcher timeout", root: "/library" }]);
  changed("change", "queued.flac");
  watcher.close();
  changed("change", "late.flac");
  child.emit("error", new Error("Late error"));
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(errors.length, 1);
  assert.equal(closed, 1);
});

test("library watcher scans the resolved local root received from its child", async () => {
  let changed;
  const localRoot = path.resolve("/mapped-library");
  const watched = [];
  const scanned = [];
  const watcher = createLibraryFileWatcher({
    roots: [{ path: "/remote-library", pathMappings: [{ remote: "/remote-library", local: localRoot }] }],
    debounceMs: 1,
    watchImpl: (root, options, callback) => { watched.push({ root, options }); changed = callback; return { close() {} }; },
    onChange: (roots, paths) => scanned.push({ roots, paths }),
  });
  changed("change", "Artist/track.flac", localRoot);
  await new Promise((resolve) => setTimeout(resolve, 15));
  watcher.close();
  assert.equal(watched[0].root, "/remote-library");
  assert.deepEqual(watched[0].options.pathMappings, [{ remote: "/remote-library", local: localRoot }]);
  assert.deepEqual(scanned, [{ roots: [localRoot], paths: [path.join(localRoot, "Artist/track.flac")] }]);
});

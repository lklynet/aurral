import assert from "node:assert/strict";
import test from "node:test";

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
const { createLibraryFileWatcher } = await import(
  "../../backend/services/libraryFileWatcher.js"
);

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

    body = undefined;
    await routes.get("GET /refresh/:jobId")(
      { user: { id: 1 }, params: { jobId } },
      response,
    );
    assert.equal(body.status, "queued");
    body.jobId = jobId;
  } finally {
    if (body?.jobId) getLibraryScanQueue().cancel(body.jobId);
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
  const watcher = createLibraryFileWatcher({
    roots: [process.cwd()],
    debounceMs: 5,
    watchImpl: (_root, _options, callback) => {
      onChange = callback;
      return { close() {} };
    },
    onChange: (roots) => {
      scheduled += 1;
      changedRoots = roots;
    },
  });

  onChange("change", "Artist/Album/track.flac");
  onChange("change", "Artist/Album/track.flac");
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(scheduled, 1);
  assert.deepEqual(changedRoots, [process.cwd()]);

  onChange("change", "aurral-weekly-flow/flow/track.flac");
  onChange("change", "_staging/track.flac");
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(scheduled, 1);

  watcher.close();
});

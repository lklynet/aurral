import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

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
const { createLibraryFileWatcher, isIgnoredChange, planWatcherScan } = await import(
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

test("library scan scheduling keeps one pending job and recovers stale registry entries", () => {
  const queue = getLibraryScanQueue();
  clearScheduledLibraryScan();
  let firstJob;
  let secondJob;
  let thirdJob;
  try {
    firstJob = scheduleLibraryScan();
    assert.equal(scheduleLibraryScan(), firstJob, "requests merge into a queued job");
    const claimed = queue.claimOne("library-scan-test");
    assert.equal(claimed?.id, firstJob);
    assert.equal(claimScheduledLibraryScanJob(firstJob), true);

    // The running job already read its options, so a new request cannot merge
    // into it: it gets a fresh queued job that later requests merge into.
    secondJob = scheduleLibraryScan({ artistIds: [7] });
    assert.notEqual(secondJob, firstJob);
    assert.equal(getScheduledLibraryScanJobId(), secondJob);
    assert.equal(scheduleLibraryScan({ artistIds: [8] }), secondJob);
    assert.deepEqual(
      JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'pendingLibraryScanJob'").get().value).artistIds,
      [7, 8],
    );
    onLibraryScanSuccess(null, { id: firstJob });
    assert.equal(getScheduledLibraryScanJobId(), secondJob, "finishing the old job keeps the new registry");

    queue.cancel(firstJob);
    queue.cancel(secondJob);
    thirdJob = scheduleLibraryScan();
    assert.notEqual(thirdJob, secondJob);
    assert.equal(getScheduledLibraryScanJobId(), thirdJob);
  } finally {
    if (firstJob) queue.cancel(firstJob);
    if (secondJob) queue.cancel(secondJob);
    if (thirdJob) queue.cancel(thirdJob);
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
  let changedDetails = null;
  const watcher = createLibraryFileWatcher({
    roots: [process.cwd()],
    debounceMs: 5,
    watchImpl: (_root, _options, callback) => {
      onChange = callback;
      return { close() {} };
    },
    onChange: (roots, details) => {
      scheduled += 1;
      changedRoots = roots;
      changedDetails = details;
    },
  });

  onChange("change", "Artist/Album/track.flac");
  onChange("change", "Artist/Album/track.flac");
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(scheduled, 1);
  assert.deepEqual(changedRoots, [process.cwd()]);
  assert.deepEqual(changedDetails, {
    paths: [path.join(process.cwd(), "Artist/Album/track.flac")],
    overflow: false,
  });

  onChange("change", "aurral-weekly-flow/flow/track.flac");
  onChange("change", "_staging/track.flac");
  onChange("change", "Artist/Album/cover.jpg");
  onChange("change", "Artist/Album/album.nfo");
  onChange("change", "Artist/Album/.DS_Store");
  onChange("change", "Artist/Album/01 track.flac.partial~");
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(scheduled, 1);

  // A moved or deleted album folder only reports the directory itself.
  onChange("rename", "Artist/Album");
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(scheduled, 2);

  watcher.close();
});

test("library file watcher flushes a burst that never goes quiet after the max wait", async () => {
  let onChange;
  let scheduled = 0;
  const watcher = createLibraryFileWatcher({
    roots: [process.cwd()],
    debounceMs: 20,
    maxWaitMs: 60,
    watchImpl: (_root, _options, callback) => {
      onChange = callback;
      return { close() {} };
    },
    onChange: () => {
      scheduled += 1;
    },
  });

  // A change every 10 ms keeps resetting the 20 ms quiet timer.
  const burst = setInterval(() => onChange("change", "Artist/Album/track.flac"), 10);
  await new Promise((resolve) => setTimeout(resolve, 45));
  assert.equal(scheduled, 0);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(scheduled, 1);
  clearInterval(burst);
  // The burst that continued after the flush is scheduled once it goes quiet.
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(scheduled, 2);

  watcher.close();
});

test("library file watcher never ignores an existing directory named with a period", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-watch-"));
  try {
    await mkdir(path.join(root, "Mr. Bungle", "Disco Volante"), { recursive: true });
    assert.equal(isIgnoredChange(root, "Mr. Bungle"), false);
    assert.equal(isIgnoredChange(root, path.join("Mr. Bungle", "Disco Volante")), false);
    assert.equal(isIgnoredChange(root, path.join("Mr. Bungle", "Disco Volante", "cover.jpg")), true);
    assert.equal(isIgnoredChange(root, path.join("Mr. Bungle", "Disco Volante", "01.flac")), false);
    assert.equal(isIgnoredChange(root, path.join("Mr. Bungle", "Disco Volante", ".partial")), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("artist-scoped scans merge into one job and upgrade to a full scan", () => {
  const queue = getLibraryScanQueue();
  clearScheduledLibraryScan();
  let jobId;
  let secondJob;
  try {
    jobId = scheduleLibraryScan({ artistIds: [11] });
    assert.deepEqual(JSON.parse(queue.getJob(jobId).payload), {
      force: false,
      includeLidarr: true,
      artistIds: [11],
    });
    assert.equal(scheduleLibraryScan({ artistIds: [12, 11] }), jobId);
    assert.deepEqual(dbOps.getJSONSetting("pendingLibraryScanJob"), {
      jobId,
      includeLidarr: true,
      artistIds: [11, 12],
    });

    // A local-only request adds the Aurral root to the scoped job instead of
    // upgrading it to a full Lidarr pull.
    assert.equal(scheduleLibraryScan({ includeLidarr: false }), jobId);
    assert.deepEqual(dbOps.getJSONSetting("pendingLibraryScanJob"), {
      jobId,
      includeLidarr: true,
      artistIds: [11, 12],
      includeLocal: true,
    });
    // A full request upgrades it, and scoped requests then ride along.
    assert.equal(scheduleLibraryScan({ includeLidarr: true }), jobId);
    assert.deepEqual(dbOps.getJSONSetting("pendingLibraryScanJob"), {
      jobId,
      includeLidarr: true,
    });
    assert.equal(scheduleLibraryScan({ artistIds: [13] }), jobId);
    assert.deepEqual(dbOps.getJSONSetting("pendingLibraryScanJob"), {
      jobId,
      includeLidarr: true,
    });

    queue.cancel(jobId);
    secondJob = scheduleLibraryScan({ includeLidarr: false });
    assert.equal(scheduleLibraryScan({ artistIds: [14] }), secondJob);
    assert.deepEqual(dbOps.getJSONSetting("pendingLibraryScanJob"), {
      jobId: secondJob,
      includeLidarr: true,
      artistIds: [14],
      includeLocal: true,
    });
    assert.deepEqual(JSON.parse(queue.getJob(secondJob).payload), {
      force: false,
      includeLidarr: false,
    });
    assert.equal(claimScheduledLibraryScanJob(secondJob), true);
    assert.deepEqual(dbOps.getJSONSetting("pendingLibraryScanJob"), {
      jobId: secondJob,
      includeLidarr: true,
      artistIds: [14],
      includeLocal: true,
    });
  } finally {
    if (jobId) queue.cancel(jobId);
    if (secondJob) queue.cancel(secondJob);
    clearScheduledLibraryScan();
  }
});

test("artist-scoped scans do not count as a completed library scan", async () => {
  const queue = getLibraryScanQueue();
  db.prepare("DELETE FROM library_scan_runs").run();
  clearScheduledLibraryScan();
  let bootstrapJobId;
  try {
    const scanId = beginLibraryScan({ source: "lidarr-artist", rootPath: "artist:1" });
    finishLibraryScan(scanId);
    await processSystemTask({ kind: "library-index-bootstrap" });
    bootstrapJobId = getScheduledLibraryScanJobId();
    assert.ok(bootstrapJobId);
  } finally {
    if (bootstrapJobId) queue.cancel(bootstrapJobId);
    clearScheduledLibraryScan();
    db.prepare("DELETE FROM library_scan_runs WHERE source = 'lidarr-artist'").run();
  }
});

test("the file watcher maps changes to Lidarr artists and rate-limits full pulls", () => {
  const playlistRoot = path.resolve("/srv/media/aurral");
  const lidarrRoot = path.resolve("/srv/media/music");
  const lidarrArtistFolders = [
    { id: 4, localPath: path.join(lidarrRoot, "Adele") },
    { id: 9, localPath: path.join(lidarrRoot, "Various", "Nested Artist") },
  ];
  const base = { playlistRoot, lidarrArtistFolders, fullScanIntervalMs: 3_600_000, now: 10_000_000 };

  // Playlist root only: a local scan.
  assert.deepEqual(
    planWatcherScan({ ...base, changedRoots: [playlistRoot], paths: [path.join(playlistRoot, "a.flac")] }),
    { requests: [{ includeLidarr: false }], fullScheduled: false, deferFull: false },
  );
  // Known artist folders: an artist-scoped re-index, no full pull.
  assert.deepEqual(
    planWatcherScan({
      ...base,
      changedRoots: [lidarrRoot],
      paths: [
        path.join(lidarrRoot, "Adele", "25", "01.flac"),
        path.join(lidarrRoot, "Various", "Nested Artist", "x.flac"),
      ],
    }),
    { requests: [{ artistIds: [4, 9], includeLocal: false }], fullScheduled: false, deferFull: false },
  );
  // Both roots: the scoped job also scans the Aurral root.
  assert.deepEqual(
    planWatcherScan({
      ...base,
      changedRoots: [lidarrRoot, playlistRoot],
      paths: [path.join(lidarrRoot, "Adele", "01.flac"), path.join(playlistRoot, "b.flac")],
    }).requests,
    [{ artistIds: [4], includeLocal: true }],
  );
  // An unknown folder needs a full pull, allowed when none ran recently.
  assert.deepEqual(
    planWatcherScan({ ...base, changedRoots: [lidarrRoot], paths: [path.join(lidarrRoot, "New Artist", "01.flac")] }),
    { requests: [{ includeLidarr: true }], fullScheduled: true, deferFull: false },
  );
  // ...and deferred, keeping the mapped work, when one ran within the interval.
  assert.deepEqual(
    planWatcherScan({
      ...base,
      lastFullScanAt: base.now - 60_000,
      changedRoots: [lidarrRoot],
      paths: [path.join(lidarrRoot, "New Artist", "01.flac"), path.join(lidarrRoot, "Adele", "02.flac")],
    }),
    { requests: [{ artistIds: [4], includeLocal: false }], fullScheduled: false, deferFull: true },
  );
  // An untracked burst counts as unresolved.
  assert.deepEqual(
    planWatcherScan({ ...base, lastFullScanAt: base.now, changedRoots: [lidarrRoot], paths: [], overflow: true }),
    { requests: [], fullScheduled: false, deferFull: true },
  );
});

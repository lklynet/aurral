import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";

const { registerCanonical } = await import(
  "../../backend/routes/library/handlers/canonical.js"
);
const {
  clearScheduledLibraryScan,
  processLibraryScan,
  stopLibraryScanWorker,
} = await import("../../backend/services/libraryScanWorker.js");
const { dbOps } = await import("../../backend/db/helpers/index.js");
const { getLibraryScanQueue } = await import("../../backend/services/honkerDb.js");
const { createLibraryFileWatcher } = await import(
  "../../backend/services/libraryFileWatcher.js"
);

test("background library scans reconcile album availability before completing", async () => {
  const calls = [];
  const lidarrClient = {};

  await processLibraryScan({
    lidarrClient,
    scanConfiguredLibrary: async (options) => {
      calls.push(["scan", options.lidarrClient]);
    },
    syncAlbumSearchHistory: async (client) => {
      calls.push(["history", client]);
    },
    scanLibrary: async () => {
      calls.push(["playlists"]);
    },
    broadcast: (...args) => {
      calls.push(["broadcast", ...args]);
    },
  });

  assert.deepEqual(calls, [
    ["scan", lidarrClient],
    ["history", lidarrClient],
    ["playlists"],
    ["broadcast", "library", { type: "library_scan_completed" }],
  ]);
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
    assert.deepEqual(JSON.parse(getLibraryScanQueue().getJob(body.jobId).payload), { force: true });
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

test("library file watcher debounces library changes and ignores generated folders", async () => {
  let onChange;
  let scheduled = 0;
  const watcher = createLibraryFileWatcher({
    roots: [process.cwd()],
    debounceMs: 5,
    watchImpl: (_root, _options, callback) => {
      onChange = callback;
      return { close() {} };
    },
    onChange: () => {
      scheduled += 1;
    },
  });

  onChange("change", "Artist/Album/track.flac");
  onChange("change", "Artist/Album/track.flac");
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(scheduled, 1);

  onChange("change", "aurral-weekly-flow/flow/track.flac");
  onChange("change", "_staging/track.flac");
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(scheduled, 1);

  watcher.close();
});

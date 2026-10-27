import { signedInAs } from "../helpers/honoApp.ts";
import { testUser } from "../helpers/userFixtures.ts";
import assert from "node:assert/strict";
import { test, vi } from "vite-plus/test";
import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "node:events";

process.env.NODE_ENV = "test";

const { api } = await import("../../backend/routes/api.ts");
const {
  claimScheduledLibraryScanJob,
  beginLibraryScanJob,
  clearScheduledLibraryScan,
  getScheduledLibraryScanJobId,
  onLibraryScanFinalFailure,
  onLibraryScanSuccess,
  scheduleLibraryScan,
  stopLibraryScanWorker,
} = await import("../../backend/services/libraryScanWorker.ts");
const { dbOps } = await import("../../backend/db/helpers/index.ts");
const { db } = await import("../../backend/config/db-sqlite.ts");
const { beginLibraryScan, finishLibraryScan } =
  await import("../../backend/services/libraryMediaStore.ts");
const { processSystemTask } = await import("../../backend/services/systemTaskWorker.ts");
const { getLibraryScanQueue, bootstrapHonkerSchedules, getHonkerDb } =
  await import("../../backend/services/honkerDb.ts");
const { createLibraryFileWatcher, resolveLibraryWatchRoots } =
  await import("../../backend/services/libraryFileWatcher.ts");
const { lidarrClient } = await import("../../backend/services/lidarrClient.ts");

test("library scans are not scheduled as a recurring background task", () => {
  bootstrapHonkerSchedules();
  assert.equal(
    getHonkerDb()
      .scheduler()
      .list()
      .some((task) => task.queue === "library-scan"),
    false,
  );
});

test("library bootstrap runs until the first completed scan, and again while a turned-off Lidarr's music remains", async () => {
  const queue = getLibraryScanQueue();
  db.prepare("DELETE FROM library_scan_runs").run();
  clearScheduledLibraryScan();
  let bootstrapJobId: number | null = null;
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

    db.prepare(
      `INSERT INTO library_management (entity_kind, entity_id, managed_by, created_at, updated_at)
       VALUES ('artist', 987654, 'lidarr', 0, 0)`,
    ).run();
    vi.spyOn(lidarrClient, "isConfigured").mockImplementation(() => true);
    await processSystemTask({ kind: "library-index-bootstrap" });
    assert.equal(getScheduledLibraryScanJobId(), null);
    vi.spyOn(lidarrClient, "isConfigured").mockImplementation(() => false);
    await processSystemTask({ kind: "library-index-bootstrap" });
    bootstrapJobId = getScheduledLibraryScanJobId();
    assert.ok(bootstrapJobId, "a turned-off Lidarr's indexed music is removed after startup");
  } finally {
    db.prepare("DELETE FROM library_management WHERE entity_id = 987654").run();
    if (bootstrapJobId) queue.cancel(bootstrapJobId);
    clearScheduledLibraryScan();
    db.prepare("DELETE FROM library_scan_runs WHERE source = 'test'").run();
  }
});

test("library refresh queues a quick or full scan and exposes its queue status", async () => {
  const existingJobId = Number(
    dbOps.getJSONSetting<{
      jobId?: number;
      includeLidarr?: boolean;
      changedPaths: string[];
      fullRescanPending?: boolean;
    }>("pendingLibraryScanJob")?.jobId,
  );
  if (Number.isSafeInteger(existingJobId)) getLibraryScanQueue().cancel(existingJobId);
  clearScheduledLibraryScan();

  const app = signedInAs(testUser(1)).route("/", api);

  type ScanStatus = NonNullable<
    ReturnType<typeof import("../../backend/services/libraryScanWorker.ts").getLibraryScanStatus>
  >;
  type Queued = { queued: boolean; jobId: number; status: ScanStatus };
  const refresh = async (body?: { mode: string }) => {
    const response = await app.request("/library/refresh", {
      method: "POST",
      ...(body && {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    });
    const payload: Queued = await response.json();
    return { statusCode: response.status, body: payload };
  };
  let refreshJobId: number | undefined;

  const queuedPayload = (jobId: number) =>
    JSON.parse(requireValue(getLibraryScanQueue().getJob(jobId)).payload);

  try {
    assert.equal((await refresh({ mode: "bogus" })).statusCode, 400);
    assert.equal(
      dbOps.getJSONSetting<{
        jobId?: number;
        includeLidarr?: boolean;
        changedPaths: string[];
        fullRescanPending?: boolean;
      }>("pendingLibraryScanJob")?.jobId,
      undefined,
    );

    const quick = await refresh();
    assert.equal(quick.statusCode, 202);
    assert.equal(quick.body.queued, true);
    assert.equal(quick.body.status.status, "queued");
    assert.deepEqual(queuedPayload(quick.body.jobId), {
      force: false,
      includeLidarr: true,
      changedPaths: null,
    });
    getLibraryScanQueue().cancel(quick.body.jobId);
    clearScheduledLibraryScan();

    const full = await refresh({ mode: "full" });
    assert.equal(full.statusCode, 202);
    assert.equal(queuedPayload(full.body.jobId).force, true);
    getLibraryScanQueue().cancel(full.body.jobId);
    clearScheduledLibraryScan();

    const { jobId } = (await refresh({ mode: "quick" })).body;
    assert.equal(queuedPayload(jobId).force, false);
    refreshJobId = jobId;
    assert.equal((await refresh({ mode: "full" })).body.jobId, jobId);
    assert.equal(beginLibraryScanJob(jobId, queuedPayload(jobId)).force, true);

    const current: Queued = await (await app.request("/library/refresh")).json();
    assert.equal(current.jobId, jobId);
    assert.equal(current.status.status, "queued");

    const status: ScanStatus = await (await app.request(`/library/refresh/${jobId}`)).json();
    assert.equal(status.status, "queued");
  } finally {
    if (refreshJobId) getLibraryScanQueue().cancel(refreshJobId);
    clearScheduledLibraryScan();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await stopLibraryScanWorker();
  }
});

test("library scan scheduling keeps one live job and recovers stale registry entries", () => {
  const queue = getLibraryScanQueue();
  clearScheduledLibraryScan();
  let firstJob: number | undefined;
  let secondJob: number | undefined;
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
  let staleJobId: number | undefined;
  let replacementJobId: number | undefined;
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
    assert.deepEqual(JSON.parse(requireValue(queue.getJob(replacementJobId)).payload), {
      force: true,
      includeLidarr: true,
      changedPaths: null,
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
  let jobId: number | undefined;
  try {
    jobId = scheduleLibraryScan({ includeLidarr: false });
    assert.deepEqual(JSON.parse(requireValue(queue.getJob(jobId)).payload), {
      force: false,
      includeLidarr: false,
      changedPaths: null,
    });
    assert.equal(scheduleLibraryScan({ includeLidarr: true }), jobId);
    assert.equal(
      requireValue(
        dbOps.getJSONSetting<{
          jobId?: number;
          includeLidarr?: boolean;
          changedPaths: string[];
          fullRescanPending?: boolean;
        }>("pendingLibraryScanJob"),
      ).includeLidarr,
      true,
    );
  } finally {
    if (jobId) queue.cancel(jobId);
    clearScheduledLibraryScan();
  }
});

test("pending watcher scans merge changed paths into one job", () => {
  const queue = getLibraryScanQueue();
  clearScheduledLibraryScan();
  let jobId: number | undefined;
  try {
    jobId = scheduleLibraryScan({
      includeLidarr: false,
      changedPaths: ["/data/music/Artist/Album/01 Track.flac"],
    });
    assert.equal(
      scheduleLibraryScan({
        changedPaths: ["/data/music/Artist/Album/02 Track.flac"],
      }),
      jobId,
    );
    assert.deepEqual(
      requireValue(
        dbOps.getJSONSetting<{
          jobId?: number;
          includeLidarr?: boolean;
          changedPaths: string[];
          fullRescanPending?: boolean;
        }>("pendingLibraryScanJob"),
      ).changedPaths,
      [
        path.resolve("/data/music/Artist/Album/01 Track.flac"),
        path.resolve("/data/music/Artist/Album/02 Track.flac"),
      ],
    );
  } finally {
    if (jobId) queue.cancel(jobId);
    clearScheduledLibraryScan();
  }
});

test("watcher paths do not downgrade a queued full scan", () => {
  const queue = getLibraryScanQueue();
  clearScheduledLibraryScan();
  let jobId: number | undefined;
  try {
    jobId = scheduleLibraryScan({ includeLidarr: false });
    assert.equal(
      scheduleLibraryScan({
        includeLidarr: false,
        changedPaths: ["/data/music/Artist/Album/01 Track.flac"],
      }),
      jobId,
    );
    assert.equal(
      "changedPaths" in
        requireValue(
          dbOps.getJSONSetting<{
            jobId?: number;
            includeLidarr?: boolean;
            changedPaths: string[];
            fullRescanPending?: boolean;
          }>("pendingLibraryScanJob"),
        ),
      false,
    );
  } finally {
    if (jobId) queue.cancel(jobId);
    clearScheduledLibraryScan();
  }
});

test("an oversized active watcher merge requests a full rescan", () => {
  const queue = getLibraryScanQueue();
  clearScheduledLibraryScan();
  let jobId: number | undefined;
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

    const registry = dbOps.getJSONSetting<{
      jobId?: number;
      includeLidarr?: boolean;
      changedPaths: string[];
      fullRescanPending?: boolean;
    }>("pendingLibraryScanJob");
    assert.equal(requireValue(registry).fullRescanPending, true);
    assert.deepEqual([...requireValue(registry).changedPaths], []);
  } finally {
    if (jobId) queue.cancel(jobId);
    clearScheduledLibraryScan();
  }
});

test("stale targeted scans retain in-flight and pending paths", () => {
  const queue = getLibraryScanQueue();
  clearScheduledLibraryScan();
  let staleJobId: number | undefined;
  let replacementJobId: number | undefined;
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

    assert.deepEqual(
      requireValue(
        dbOps.getJSONSetting<{
          jobId?: number;
          includeLidarr?: boolean;
          changedPaths: string[];
          fullRescanPending?: boolean;
        }>("pendingLibraryScanJob"),
      ).changedPaths,
      [
        path.resolve("/data/music/in-flight.flac"),
        path.resolve("/data/music/pending.flac"),
        path.resolve("/data/music/new.flac"),
      ],
    );
  } finally {
    if (staleJobId) queue.cancel(staleJobId);
    if (replacementJobId) queue.cancel(replacementJobId);
    clearScheduledLibraryScan();
  }
});

test("claiming an unregistered scan does not inherit stale Lidarr mode", () => {
  const queue = getLibraryScanQueue();
  clearScheduledLibraryScan();
  let jobId: number | undefined;
  try {
    jobId = scheduleLibraryScan({ includeLidarr: false });
    dbOps.setJSONSetting("pendingLibraryScanJob", { includeLidarr: true });
    assert.equal(claimScheduledLibraryScanJob(jobId), true);
    assert.deepEqual(
      dbOps.getJSONSetting<{
        jobId?: number;
        includeLidarr?: boolean;
        changedPaths: string[];
        fullRescanPending?: boolean;
      }>("pendingLibraryScanJob"),
      {
        jobId,
        includeLidarr: false,
      },
    );
  } finally {
    if (jobId) queue.cancel(jobId);
    clearScheduledLibraryScan();
  }
});

test("an early replacement claim retains in-flight, pending, and new scan paths", () => {
  const queue = getLibraryScanQueue();
  clearScheduledLibraryScan();
  let staleJobId: number | undefined;
  let replacementJobId: number | undefined;
  try {
    staleJobId = scheduleLibraryScan({
      includeLidarr: true,
      changedPaths: ["/data/music/old.flac"],
    });
    queue.cancel(staleJobId);
    dbOps.setJSONSetting("pendingLibraryScanJob", {
      jobId: staleJobId,
      includeLidarr: true,
      changedPaths: ["/data/music/pending.flac"],
      inFlightActive: true,
      inFlightPaths: ["/data/music/in-flight.flac"],
    });

    const enqueue = queue.enqueue.bind(queue);
    vi.spyOn(queue, "enqueue").mockImplementation((payload, options) => {
      const id = enqueue(payload, options);
      const claimed = queue.claimOne("early-replacement-library-scan-test");
      assert.equal(claimed?.id, id);
      assert.equal(claimScheduledLibraryScanJob(id, claimed.payload), true);
      const begun = beginLibraryScanJob(id, claimed.payload);
      assert.equal(begun.includeLidarr, true);
      assert.deepEqual(begun.changedPaths, [
        path.resolve("/data/music/in-flight.flac"),
        path.resolve("/data/music/pending.flac"),
        path.resolve("/data/music/new.flac"),
      ]);
      return id;
    });

    replacementJobId = scheduleLibraryScan({
      includeLidarr: false,
      changedPaths: ["/data/music/new.flac"],
    });
    assert.equal(getScheduledLibraryScanJobId(), replacementJobId);
    assert.equal(queue.getJob(replacementJobId)?.state, "processing");
  } finally {
    if (staleJobId) queue.cancel(staleJobId);
    if (replacementJobId) queue.cancel(replacementJobId);
    clearScheduledLibraryScan();
  }
});

test("an early first claim uses its targeted payload without stale Lidarr mode", () => {
  const queue = getLibraryScanQueue();
  clearScheduledLibraryScan();
  dbOps.setJSONSetting("pendingLibraryScanJob", { includeLidarr: true });
  let jobId: number | undefined;
  try {
    const enqueue = queue.enqueue.bind(queue);
    vi.spyOn(queue, "enqueue").mockImplementation((payload, options) => {
      const id = enqueue(payload, options);
      const claimed = queue.claimOne("early-first-library-scan-test");
      assert.equal(claimed?.id, id);
      assert.equal(claimScheduledLibraryScanJob(id, claimed.payload), true);
      const begun = beginLibraryScanJob(id, claimed.payload);
      assert.equal(begun.includeLidarr, false);
      assert.deepEqual(begun.changedPaths, [path.resolve("/data/music/new.flac")]);
      return id;
    });
    jobId = scheduleLibraryScan({
      includeLidarr: false,
      changedPaths: ["/data/music/new.flac"],
    });
    assert.equal(getScheduledLibraryScanJobId(), jobId);
  } finally {
    if (jobId) queue.cancel(jobId);
    clearScheduledLibraryScan();
  }
});

test("terminal library scan outcomes clear the persistent registry", () => {
  const queue = getLibraryScanQueue();
  let successJob: number | undefined;
  let failedJob: number | undefined;
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

test("library file watcher debounces library changes and ignores generated folders", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let onChange: (eventType: string, filename: string | null, resolvedRoot?: string) => void = () =>
    assert.fail("Watcher callback not registered");
  let scheduled = 0;
  let changedRoots: string[] = [];
  let changedPaths: string[] = [];
  const watcher = createLibraryFileWatcher({
    roots: [process.cwd()],
    debounceMs: 5,
    watchImpl: (_root, _options, callback) => {
      onChange = (event, filename, root = process.cwd()) => callback(event, filename, root);
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
  vi.runAllTimers();
  assert.equal(scheduled, 1);
  assert.deepEqual(changedRoots, [process.cwd()]);
  assert.deepEqual(changedPaths, [path.join(process.cwd(), "Artist/Album/track.flac")]);

  onChange("change", "aurral-weekly-flow/flow/track.flac");
  onChange("change", "_staging/track.flac");
  vi.runAllTimers();
  assert.equal(scheduled, 1);

  watcher.close();
});

test("library watcher reuses configured roots without querying Lidarr", () => {
  const rootPath = path.resolve("/data/music");
  const pathProbe = vi.spyOn(fs, "existsSync").mockImplementation(() => {
    throw new Error("Main-thread path probe");
  });
  vi.spyOn(lidarrClient, "isConfigured").mockImplementation(() => true);
  vi.spyOn(lidarrClient, "getConfiguredRootFolderPaths").mockImplementation(() => [rootPath]);
  const rootRequest = vi.spyOn(lidarrClient, "getRootFolders").mockImplementation(async () => {
    throw new Error("watcher should not discover roots");
  });

  assert.equal(
    resolveLibraryWatchRoots().some(
      (root) => (typeof root === "string" ? root : root?.path) === rootPath,
    ),
    true,
  );
  assert.equal(rootRequest.mock.calls.length, 0);
  assert.equal(pathProbe.mock.calls.length, 0);
});

test("library watcher creates roots without probing the filesystem on the main thread", () => {
  vi.spyOn(fs, "existsSync").mockImplementation(() => {
    throw new Error("Synchronous filesystem probe");
  });
  const roots: string[] = [];
  const watcher = createLibraryFileWatcher({
    roots: ["", null, "/slow-root", "/slow-root"],
    watchImpl: (root) => {
      roots.push(root);
      return { close() {} };
    },
  });
  watcher.close();
  assert.deepEqual(roots, ["/slow-root"]);
});

test("library watcher reports asynchronous errors and ignores callbacks after close", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const errors: unknown[] = [];
  let changed: (eventType: string, filename: string | null, resolvedRoot?: string) => void = () =>
    assert.fail("Watcher callback not registered");
  let closed = 0;
  const child = Object.assign(new EventEmitter(), {
    close() {
      closed++;
    },
  });
  const watcher = createLibraryFileWatcher({
    roots: ["/library"],
    debounceMs: 1,
    watchImpl: (_root, _options, callback) => {
      changed = (event, filename, root = "/library") => callback(event, filename, root);
      return child;
    },
    onError: (error, root) =>
      errors.push({ message: error instanceof Error ? error.message : String(error), root }),
    onChange: () => assert.fail("Closed watcher scheduled a scan"),
  });
  child.emit("error", new Error("Watcher timeout"));
  assert.deepEqual(errors, [{ message: "Watcher timeout", root: "/library" }]);
  changed("change", "queued.flac");
  watcher.close();
  changed("change", "late.flac");
  child.emit("error", new Error("Late error"));
  vi.runAllTimers();
  assert.equal(errors.length, 1);
  assert.equal(closed, 1);
});

test("library watcher scans the resolved local root received from its child", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let changed: (eventType: string, filename: string | null, resolvedRoot?: string) => void = () =>
    assert.fail("Watcher callback not registered");
  const localRoot = path.resolve("/mapped-library");
  const watched: {
    root: string;
    options: {
      recursive: boolean;
      pathMappings: import("../../backend/services/pathMappings.ts").PathMapping[];
    };
  }[] = [];
  const scanned: { roots: string[]; paths: string[] }[] = [];
  const watcher = createLibraryFileWatcher({
    roots: [
      {
        path: "/remote-library",
        pathMappings: [{ source: "all", remote: "/remote-library", local: localRoot }],
      },
    ],
    debounceMs: 1,
    watchImpl: (root, options, callback) => {
      watched.push({ root, options });
      changed = (event, filename, root = "/library") => callback(event, filename, root);
      return { close() {} };
    },
    onChange: (roots, paths) => scanned.push({ roots, paths }),
  });
  changed("change", "Artist/track.flac", localRoot);
  vi.runAllTimers();
  watcher.close();
  assert.equal(watched[0].root, "/remote-library");
  assert.deepEqual(watched[0].options.pathMappings, [
    { source: "all", remote: "/remote-library", local: localRoot },
  ]);
  assert.deepEqual(scanned, [
    { roots: [localRoot], paths: [path.join(localRoot, "Artist/track.flac")] },
  ]);
});

function createMappedWatcherTest(t: import("vite-plus/test").TestContext) {
  const localRoot = path.resolve("/shared-library");
  const children: (EventEmitter & {
    closed: number;
    close(): void;
    change(filename: string): void;
  })[] = [];
  const scanned: { roots: string[]; paths: string[] }[] = [];
  const errors: unknown[] = [];
  const watcher = createLibraryFileWatcher({
    roots: ["/remote-one", "/remote-two", "/remote-three"].map((remote) => ({
      path: remote,
      pathMappings: [{ source: "all", remote, local: localRoot }],
    })),
    debounceMs: 1,
    watchImpl: (_root, _options, callback) => {
      const child = Object.assign(new EventEmitter(), {
        closed: 0,
        close() {
          child.closed++;
          child.emit("close");
        },
        change(filename: string) {
          callback("change", filename, localRoot);
        },
      });
      children.push(child);
      return child;
    },
    onChange: (roots, paths) => scanned.push({ roots, paths }),
    onError: (error) => errors.push(error),
  });
  t.onTestFinished(() => watcher.close());
  return { localRoot, watcher, children, scanned, errors };
}

for (const firstReady of [0, 1]) {
  test(`library watcher keeps the first ready local-root owner (ready index ${firstReady})`, (t) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { localRoot, watcher, children, scanned, errors } = createMappedWatcherTest(t);
    const owner = children[firstReady];
    const duplicate = children[1 - firstReady];
    owner.emit("ready", localRoot);
    duplicate.emit("ready", localRoot);
    assert.equal(owner.closed, 0);
    assert.equal(duplicate.closed, 1);
    // Closing a duplicate must not release the surviving watcher's root.
    children[2].emit("ready", path.join(localRoot, "."));
    assert.equal(children[2].closed, 1);
    duplicate.change("duplicate.flac");
    duplicate.emit("error", new Error("Late duplicate error"));
    owner.change("kept.flac");
    vi.runAllTimers();
    assert.deepEqual(scanned, [{ roots: [localRoot], paths: [path.join(localRoot, "kept.flac")] }]);
    assert.equal(errors.length, 0);
    watcher.close();
    watcher.close();
    assert.deepEqual(
      children.map((child) => child.closed),
      [1, 1, 1],
    );
    owner.emit("ready", localRoot);
    owner.change("after-close.flac");
    vi.runAllTimers();
    assert.equal(scanned.length, 1);
  });
}

for (const outcome of ["close", "error"]) {
  test(`library watcher releases local-root ownership after ${outcome}`, (t) => {
    const { localRoot, children, errors } = createMappedWatcherTest(t);
    children[0].emit("ready", localRoot);
    if (outcome === "close") children[0].close();
    else children[0].emit("error", new Error("Watcher failed"));
    children[1].emit("ready", localRoot);
    assert.equal(children[1].closed, 0);
    children[2].emit("ready", localRoot);
    assert.equal(children[2].closed, 1);
    assert.equal(errors.length, outcome === "error" ? 1 : 0);
  });
}

function requireValue<T>(value: T | null | undefined): T {
  assert.ok(value != null);
  return value;
}

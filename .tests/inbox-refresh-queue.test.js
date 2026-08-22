import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanupIsolatedState,
  setupIsolatedBackend,
} from "./helpers/backendTestHarness.js";

const [
  isolatedState,
  { db },
  { dbOps, userOps },
  inboxService,
  honkerDb,
  systemTaskWorker,
  { upsertLibraryArtist },
  axios,
] = await setupIsolatedBackend(
  "inbox-refresh-queue",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
  "backend/services/inboxService.js",
  "backend/services/honkerDb.js",
  "backend/services/systemTaskWorker.js",
  "backend/services/libraryMediaStore.js",
  "lib/axiosFetch.js",
);

const {
  enqueueInboxRefreshForUser,
  getInboxForUser,
  getInboxRefreshStatus,
  refreshInboxForUser,
} = inboxService;
const { enqueueHonkerStartupTasks, getHonkerDb, getSystemTaskQueue } = honkerDb;
const { processSystemTask } = systemTaskWorker;

let userId;

function clearRefreshState() {
  const transaction = getHonkerDb().transaction();
  transaction.execute("DELETE FROM _honker_live");
  transaction.commit();
  db.prepare("DELETE FROM inbox_items").run();
  db.prepare("DELETE FROM settings WHERE key LIKE 'inboxRefresh:%'").run();
}

test.before(() => {
  getSystemTaskQueue();
  userId = userOps.createUser("inbox-refresh-user", "password-hash").id;
  upsertLibraryArtist({
    identityKey: "artist:inbox-refresh",
    mbid: "artist-mbid",
    name: "Inbox Refresh Artist",
  });
});

test.beforeEach(() => {
  clearRefreshState();
});

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("GET inbox reads cached rows without creating refresh work", () => {
  const result = getInboxForUser(userId);
  const jobs = getHonkerDb().query(
    "SELECT id FROM _honker_live WHERE queue = 'system-task'",
  );

  assert.equal(result.refreshStatus.status, "idle");
  assert.equal(result.refreshing, false);
  assert.equal(jobs.length, 0);
});

test("manual refreshes deduplicate per user and survive a Honker reopen", async () => {
  const queue = getSystemTaskQueue();
  const originalEnqueue = queue.enqueue;
  queue.enqueue = function enqueueWithFutureRunAt(payload, options = {}) {
    return originalEnqueue.call(this, payload, {
      ...options,
      runAt: Math.floor(Date.now() / 1000) + 120,
    });
  };

  let first;
  let second;
  try {
    first = await enqueueInboxRefreshForUser(userId, { reason: "manual" });
    second = await enqueueInboxRefreshForUser(userId, { reason: "manual" });
  } finally {
    queue.enqueue = originalEnqueue;
  }

  assert.equal(first.queued, true);
  assert.equal(second.queued, false);
  assert.equal(second.jobId, first.jobId);
  assert.equal(
    getHonkerDb().query(
      "SELECT id FROM _honker_live WHERE queue = 'system-task' AND state = 'pending'",
    ).length,
    1,
  );

  honkerDb.closeHonkerDb();
  const statusAfterReopen = getInboxRefreshStatus(userId);
  assert.equal(statusAfterReopen.status, "queued");
  assert.equal(statusAfterReopen.jobId, first.jobId);
});

test("a removed queued refresh is reported stale", async () => {
  const queue = getSystemTaskQueue();
  const originalEnqueue = queue.enqueue;
  queue.enqueue = function enqueueWithFutureRunAt(payload, options = {}) {
    return originalEnqueue.call(this, payload, {
      ...options,
      runAt: Math.floor(Date.now() / 1000) + 120,
    });
  };
  let refresh;
  try {
    refresh = await enqueueInboxRefreshForUser(userId, { reason: "manual" });
  } finally {
    queue.enqueue = originalEnqueue;
  }
  const transaction = getHonkerDb().transaction();
  transaction.execute("DELETE FROM _honker_live WHERE id = ?", [refresh.jobId]);
  transaction.commit();

  const status = getInboxRefreshStatus(userId);
  assert.equal(status.status, "stale");
  assert.equal(status.stale, true);
  assert.match(status.error, /no longer active/i);
});

test("expired inbox leases are reported stale and recovered without overlap", async () => {
  const refresh = await inboxService.enqueueInboxRefreshForUser(userId, { reason: "retry" });
  const jobId = refresh.jobId;
  const expiredAt = Math.floor(Date.now() / 1000) - 10;
  const transaction = getHonkerDb().transaction();
  transaction.execute(
    `UPDATE _honker_live
     SET state = 'processing', worker_id = ?, claim_expires_at = ?
     WHERE id = ?`,
    ["stale-worker", expiredAt, jobId],
  );
  transaction.commit();

  const staleStatus = getInboxRefreshStatus(userId);
  assert.equal(staleStatus.status, "stale");
  assert.equal(staleStatus.stale, true);
  assert.match(staleStatus.error, /no longer active/i);
  assert.equal(
    getHonkerDb().query("SELECT state FROM _honker_live WHERE id = ?", [jobId])[0]?.state,
    "processing",
  );

  const recovered = await inboxService.enqueueInboxRefreshForUser(userId, { reason: "retry" });
  assert.equal(recovered.queued, true);
  assert.notEqual(recovered.jobId, jobId);
  assert.equal(
    getHonkerDb().query(
      `SELECT id FROM _honker_live
       WHERE queue = 'system-task'
         AND (state = 'pending' OR (state = 'processing' AND claim_expires_at > ?))`,
      [Math.floor(Date.now() / 1000)],
    ).length,
    1,
  );
});

test("provider failure preserves rows and marks the inbox stale", async () => {
  const previous = dbOps.upsertInboxItem({
    userId,
    kind: "release",
    sourceKey: "prior:release",
    title: "Previously cached release",
  });
  const originalAxiosGet = axios.default.get;
  const originalTicketmasterKey = process.env.TICKETMASTER_API_KEY;
  process.env.TICKETMASTER_API_KEY = "test-ticketmaster-key";
  axios.default.get = (url, options) => {
    if (String(url).includes("zippopotam.us")) {
      return Promise.resolve({
        data: {
          places: [{
            "place name": "New York",
            state: "New York",
            "state abbreviation": "NY",
            latitude: "40.71",
            longitude: "-74.00",
          }],
        },
      });
    }
    if (String(url).includes("ticketmaster.com")) {
      return Promise.reject(new Error("Ticketmaster unavailable"));
    }
    return originalAxiosGet(url, options);
  };

  try {
    const refreshed = await refreshInboxForUser(userId, {
      force: true,
      ipAddress: "127.0.0.1",
      zipCode: "10001",
    });
    assert.equal(refreshed, false);
    const status = getInboxRefreshStatus(userId);
    assert.equal(status.status, "stale");
    assert.equal(status.stale, true);
    assert.match(status.error, /shows: Ticketmaster unavailable/);
    assert.equal(dbOps.getInboxItem(userId, previous.id)?.title, "Previously cached release");
  } finally {
    axios.default.get = originalAxiosGet;
    if (originalTicketmasterKey === undefined) delete process.env.TICKETMASTER_API_KEY;
    else process.env.TICKETMASTER_API_KEY = originalTicketmasterKey;
  }
});

test("failed refreshes are explicit and a worker retry can complete", async () => {
  const previous = dbOps.upsertInboxItem({
    userId,
    kind: "release",
    sourceKey: "failed:release",
    title: "Retained while refresh fails",
  });
  const originalGetSettings = dbOps.getSettings;
  dbOps.getSettings = () => {
    throw new Error("Inbox provider unavailable");
  };

  try {
    await assert.rejects(
      processSystemTask({ kind: "inbox-refresh", userId }, { id: 9001 }),
      /Inbox provider unavailable/,
    );
    const failed = getInboxRefreshStatus(userId);
    assert.equal(failed.status, "failed");
    assert.equal(failed.stale, true);
    assert.match(failed.error, /Inbox provider unavailable/);
    assert.equal(dbOps.getInboxItem(userId, previous.id)?.title, "Retained while refresh fails");
  } finally {
    dbOps.getSettings = originalGetSettings;
  }

  await processSystemTask({ kind: "inbox-refresh", userId }, { id: 9002 });
  const recovered = getInboxRefreshStatus(userId);
  assert.equal(recovered.status, "complete");
  assert.equal(recovered.stale, false);
  assert.equal(recovered.lastSuccessAt > 0, true);
});

test("startup markers prevent duplicate bootstrap jobs on restart", () => {
  enqueueHonkerStartupTasks();
  enqueueHonkerStartupTasks();
  const kinds = getHonkerDb()
    .query("SELECT payload FROM _honker_live WHERE queue = 'system-task'")
    .map((row) => JSON.parse(row.payload).kind);

  assert.equal(kinds.filter((kind) => kind === "weekly-flow-startup-check").length, 1);
  assert.equal(kinds.filter((kind) => kind === "discovery-bootstrap").length, 1);
  assert.equal(kinds.filter((kind) => kind === "library-index-bootstrap").length, 1);
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  importFromRepo,
} from "../helpers/backendTestHarness.js";

const [
  isolatedState,
  _dbSqlite,
  honkerDb,
  runtime,
  taskStatus,
  operationQueueModule,
] = await setupIsolatedBackend(
  "honker-worker-runtime",
  "backend/config/db-sqlite.js",
  "backend/services/honkerDb.js",
  "backend/services/honkerWorkerRuntime.js",
  "backend/services/honkerTaskStatus.js",
  "backend/services/weeklyFlow/weeklyFlowOperationQueue.js",
);

const STALE_RUNNING_MS = 60 * 60 * 1000;

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("getHonkerQueueDepth counts claimable pending jobs", () => {
  honkerDb.getWeeklyFlowOperationQueue().enqueue({ kind: "noop-test" });
  const depth = honkerDb.getHonkerQueueDepth("weekly-flow-operation");
  assert.equal(depth, 1);
});

test("getHonkerQueueNextClaimAt reports delayed queue work", () => {
  const runAt = Math.floor(Date.now() / 1000) + 120;
  honkerDb.getLibraryScanQueue().enqueue({ kind: "delayed-test" }, { runAt });
  const nextClaimAt = honkerDb.getHonkerQueueNextClaimAt("library-scan");
  assert.equal(nextClaimAt, runAt);
});

test("task status reports queued jobs beyond the live row display limit", async () => {
  const queue = honkerDb.getPipelineQueue();
  const jobIds = [];
  for (let index = 0; index < 501; index += 1) {
    jobIds.push(queue.enqueue({ kind: `queue-count-${index}` }));
  }

  try {
    const status = await taskStatus.getHonkerTaskStatus();
    const worker = status.workers.find((entry) => entry.queue === "slskd-pipeline");
    assert.equal(worker?.queued, 501);
  } finally {
    for (const jobId of jobIds) queue.cancel(jobId);
  }
});

test("withJobHeartbeat extends job claim while work runs", async () => {
  const queue = honkerDb.getLibraryScanQueue();
  const jobId = queue.enqueue({ kind: "heartbeat-test" });
  const job = queue.claimOne(honkerDb.getWorkerId());
  assert.equal(job?.id, jobId);

  let heartbeatCalls = 0;
  const heartbeat = job.heartbeat.bind(job);
  job.heartbeat = (seconds) => {
    heartbeatCalls += 1;
    return heartbeat(seconds);
  };
  await runtime.withJobHeartbeat(job, queue, async () => {
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }, 1);
  assert.ok(heartbeatCalls >= 1);
  job.ack();
});

test("withJobHeartbeat records completed task runs", async () => {
  const queue = honkerDb.getLibraryScanQueue();
  const jobId = queue.enqueue({ kind: "recorded-test" });
  const job = queue.claimOne(honkerDb.getWorkerId());
  assert.equal(job?.id, jobId);

  await runtime.withJobHeartbeat(job, queue, async () => {});
  job.ack();

  const status = await taskStatus.getHonkerTaskStatus();
  const recorded = status.queue.find(
    (entry) =>
      entry.source === "run" &&
      entry.jobId === jobId &&
      entry.queue === "library-scan",
  );
  assert.equal(recorded?.status, "completed");
  assert.match(recorded?.name || "", /Library Scan/);
  assert.ok(status.summary);
  assert.equal(status.summary.healthy, true);
  assert.ok(status.summary.completedCount >= 1);
});

test("task status exposes startedAt and runningForMs for live processing jobs", async () => {
  const queue = honkerDb.getLibraryScanQueue();
  const jobId = queue.enqueue({ kind: "live-started-test" });
  const job = queue.claimOne(honkerDb.getWorkerId());
  assert.equal(job?.id, jobId);

  let resolveWork;
  const work = new Promise((resolve) => {
    resolveWork = resolve;
  });
  const heartbeatPromise = runtime.withJobHeartbeat(job, queue, async () => {
    await work;
  });

  const status = await taskStatus.getHonkerTaskStatus();
  const live = status.queue.find(
    (entry) =>
      entry.source === "live" &&
      entry.jobId === jobId &&
      entry.status === "running",
  );
  assert.ok(live?.startedAt);
  assert.ok(Number(live?.runningForMs) >= 0);
  assert.equal(live?.isStale, false);

  resolveWork();
  await heartbeatPromise;
  job.ack();
});

test("task status marks long-running jobs as stale", async () => {
  const { db } = await importFromRepo("backend/config/db-sqlite.js");
  const queue = honkerDb.getLibraryScanQueue();
  const jobId = queue.enqueue({ kind: "stale-test" });
  const job = queue.claimOne(honkerDb.getWorkerId());
  assert.equal(job?.id, jobId);

  const twoHoursAgo = Math.floor(Date.now() / 1000) - 7200;
  db.prepare(
    `
      INSERT INTO honker_task_runs (
        job_id,
        queue,
        name,
        payload,
        worker_id,
        attempt,
        status,
        queued_at,
        run_at,
        started_at,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)
    `,
  ).run(
    jobId,
    "library-scan",
    "Library Scan",
    JSON.stringify({ kind: "stale-test" }),
    honkerDb.getWorkerId(),
    0,
    twoHoursAgo,
    twoHoursAgo,
    twoHoursAgo,
    twoHoursAgo,
  );

  const status = await taskStatus.getHonkerTaskStatus();
  const live = status.queue.find(
    (entry) =>
      entry.source === "live" &&
      entry.jobId === jobId &&
      entry.status === "running",
  );
  assert.equal(live?.isStale, true);
  assert.ok(Number(live?.runningForMs) >= STALE_RUNNING_MS);

  assert.ok(status.summary.staleCount >= 1);
  assert.equal(status.summary.healthy, false);

  job.ack();
});

test("clearStaleHonkerJobs removes long-running processing jobs", async () => {
  const { db } = await importFromRepo("backend/config/db-sqlite.js");
  const queue = honkerDb.getSystemTaskQueue();
  const jobId = queue.enqueue({ kind: "playlist-startup-migration" });
  const job = queue.claimOne(honkerDb.getWorkerId());
  assert.equal(job?.id, jobId);

  const twoHoursAgo = Math.floor(Date.now() / 1000) - 7200;
  db.prepare(
    `
      INSERT INTO honker_task_runs (
        job_id,
        queue,
        name,
        payload,
        worker_id,
        attempt,
        status,
        queued_at,
        run_at,
        started_at,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)
    `,
  ).run(
    jobId,
    "system-task",
    "Playlist Startup Migration",
    JSON.stringify({ kind: "playlist-startup-migration" }),
    honkerDb.getWorkerId(),
    0,
    twoHoursAgo,
    twoHoursAgo,
    twoHoursAgo,
    twoHoursAgo,
  );

  const before = await taskStatus.getHonkerTaskStatus();
  assert.ok(
    before.queue.some(
      (entry) =>
        entry.jobId === jobId &&
        entry.status === "running" &&
        entry.isStale === true,
    ),
  );

  const result = await taskStatus.clearStaleHonkerJobs();
  assert.ok(result.cleared >= 1);

  const after = await taskStatus.getHonkerTaskStatus();
  assert.equal(
    after.queue.some(
      (entry) => entry.jobId === jobId && entry.status === "running",
    ),
    false,
  );
  assert.equal(after.summary.staleCount, 0);
});

test("task status collapses duplicate scheduled discovery refresh jobs", async () => {
  const queue = honkerDb.getDiscoveryRefreshQueue();
  const runAt = Math.floor(Date.now() / 1000) + 86400;
  queue.enqueue(
    { reason: "scheduled", requestedAt: Date.now(), scheduleOnly: true },
    { runAt },
  );
  queue.enqueue(
    {
      reason: "scheduled",
      requestedAt: Date.now() + 1000,
      scheduleOnly: true,
    },
    { runAt },
  );

  const status = await taskStatus.getHonkerTaskStatus();
  const grouped = status.queue.filter(
    (entry) =>
      entry.queue === "discovery-refresh" &&
      entry.name === "Discovery Auto Refresh",
  );

  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].duplicateCount, 1);
  const worker = status.workers.find(
    (entry) => entry.queue === "discovery-refresh",
  );
  assert.equal(worker?.scheduled, 1);
});

test("task status groups duplicate completed system task runs", async () => {
  const queue = honkerDb.getSystemTaskQueue();
  for (let index = 0; index < 2; index += 1) {
    queue.enqueue({ kind: "discovery-bootstrap" });
    const job = queue.claimOne(honkerDb.getWorkerId());
    assert.ok(job);
    await runtime.withJobHeartbeat(job, queue, async () => {});
    job.ack();
  }

  const status = await taskStatus.getHonkerTaskStatus();
  const grouped = status.queue.filter(
    (entry) =>
      entry.queue === "system-task" &&
      entry.name === "Discovery Startup Check",
  );

  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].duplicateCount, 2);
  assert.equal(grouped[0].payloadSummary, "");
});

test("task run ledger prunes dead jobs older than one hour", async () => {
  const { db } = await importFromRepo("backend/config/db-sqlite.js");
  const twoHoursAgo = Math.floor(Date.now() / 1000) - 7200;
  db.prepare(
    `
      INSERT INTO _honker_dead (
        queue,
        payload,
        priority,
        run_at,
        attempts,
        max_attempts,
        last_error,
        created_at,
        died_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    "slskd-pipeline",
    JSON.stringify({ phase: "finalize" }),
    0,
    twoHoursAgo,
    4,
    5,
    "stale failure",
    twoHoursAgo,
    twoHoursAgo,
  );

  const status = await taskStatus.getHonkerTaskStatus();
  assert.equal(
    status.queue.some((entry) => entry.error === "stale failure"),
    false,
  );
  const remaining = db
    .prepare(
      "SELECT COUNT(*) AS count FROM _honker_dead WHERE last_error = 'stale failure'",
    )
    .get();
  assert.equal(Number(remaining?.count || 0), 0);
});

test("task run ledger prunes entries older than one hour", async () => {
  const { db } = await importFromRepo("backend/config/db-sqlite.js");
  const twoHoursAgo = Math.floor(Date.now() / 1000) - 7200;
  db.prepare(
    `
      INSERT INTO honker_task_runs (
        job_id,
        queue,
        name,
        payload,
        worker_id,
        attempt,
        status,
        queued_at,
        run_at,
        started_at,
        ended_at,
        duration_ms,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    424242,
    "system-task",
    "Stale Task",
    null,
    null,
    0,
    "completed",
    twoHoursAgo,
    twoHoursAgo,
    twoHoursAgo,
    twoHoursAgo,
    100,
    twoHoursAgo,
  );

  const status = await taskStatus.getHonkerTaskStatus();
  assert.equal(
    status.queue.some((entry) => entry.name === "Stale Task"),
    false,
  );
  const remaining = db
    .prepare(
      "SELECT COUNT(*) AS count FROM honker_task_runs WHERE name = 'Stale Task'",
    )
    .get();
  assert.equal(Number(remaining?.count || 0), 0);
});

test("weekly flow operation queue status reflects worker state and depth", () => {
  operationQueueModule.setWeeklyFlowOperationWorkerState({
    running: true,
    currentLabel: "manual-start-flow",
  });
  honkerDb.getWeeklyFlowOperationQueue().enqueue({ kind: "manual-start-flow" });
  const status = operationQueueModule.weeklyFlowOperationQueue.getStatus();
  assert.equal(status.processing, true);
  assert.equal(status.currentLabel, "manual-start-flow");
  assert.ok(status.pending >= 1);
  operationQueueModule.setWeeklyFlowOperationWorkerState({
    running: false,
    currentLabel: null,
  });
});

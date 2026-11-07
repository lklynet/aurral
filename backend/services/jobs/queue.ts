import { randomUUID } from "node:crypto";
import { db } from "../../config/db-sqlite.ts";
import type { JobsRow } from "../../db/rows.ts";
import type { WorkerGroup } from "./groups.ts";

export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

export type JobState = "pending" | "running" | "done" | "failed" | "cancelled";
export type JobRow = Omit<JobsRow, "state"> & { state: JobState };

export const PROCESS_GROUP = process.env.AURRAL_BACKGROUND_WORKER_GROUP || "web";
export const WORKER_ID = `${PROCESS_GROUP}:${randomUUID()}`;

export interface QueueConfig<Payload extends object> {
  name: string;
  group: WorkerGroup;
  leaseMs: number;
  maxAttempts: number;
  retryDelayMs: number;
  backoff?: "fixed" | "exponential";
  timeoutMs: number;
  start: () => Promise<unknown>;
  skipInTest?: boolean;
  priority?: (payload: Payload) => number;
  onAbandoned?: (job: JobRow, reason: string) => unknown;
}

export interface EnqueueOptions<Payload> {
  runAt?: number | null;
  delayMs?: number | null;
  priority?: number | null;
  maxAttempts?: number;
  dedupeKey?: string;
  mergeInto?: (waiting: JsonObject) => Payload | null;
  mergeDelayMs?: number;
}

export type HeartbeatResult = "held" | "cancelled" | "lost";

export interface ClaimedJob<Payload = JsonObject | null> {
  readonly id: number;
  readonly queue: string;
  readonly kind: string;
  readonly payload: Payload;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly createdAt: number;
  readonly runAt: number;
  withPayload<Next>(payload: Next): ClaimedJob<Next>;
  ack(): boolean;
  fail(error: string): boolean;
  retry(delayMs: number, error: string): boolean;
  requeue(options?: { refundAttempt?: boolean }): boolean;
  adjustAttempts(delta: number): boolean;
  heartbeat(): HeartbeatResult;
}

export function parseJobPayload(text: unknown): JsonObject | null {
  try {
    const parsed: unknown = typeof text === "string" ? JSON.parse(text) : text;
    return isJsonObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function payloadKind(queue: string, payload: object) {
  const kind: unknown = Reflect.get(payload, "kind");
  return typeof kind === "string" && kind ? kind : queue;
}

const FENCE = "id = @id AND worker_id = @workerId AND attempts = @attempts AND state = 'running'";
const SETTLED = `CASE WHEN cancel_requested = 1 THEN 'cancelled'
  WHEN attempts >= max_attempts THEN 'failed' ELSE 'pending' END`;

const statements = {
  insert: db.prepare<
    [string, string, string, string | null, number, number, number, number],
    { id: number }
  >(`
    INSERT INTO jobs (queue, kind, payload, dedupe_key, priority, state, run_at, max_attempts, created_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)
    ON CONFLICT (queue, dedupe_key)
      WHERE dedupe_key IS NOT NULL AND state IN ('pending', 'running') DO NOTHING
    RETURNING id
  `),
  activeByKey: db.prepare<[string, string], { id: number }>(
    "SELECT id FROM jobs WHERE queue = ? AND dedupe_key = ? AND state IN ('pending', 'running')",
  ),
  waitingOfKind: db.prepare<[string, string], Pick<JobRow, "id" | "payload">>(
    `SELECT id, payload FROM jobs
     WHERE queue = ? AND kind = ? AND state = 'pending' AND attempts = 0 ORDER BY id`,
  ),
  merge: db.prepare<[string, number, number]>(
    "UPDATE jobs SET payload = ?, run_at = MAX(run_at, ?) WHERE id = ?",
  ),
  expireLeases: db.prepare<{ queue: string; now: number }>(`
    UPDATE jobs SET state = ${SETTLED}, worker_id = NULL, lease_until = NULL,
      finished_at = CASE WHEN cancel_requested = 1 OR attempts >= max_attempts THEN @now END,
      last_error = 'The worker stopped renewing its claim'
    WHERE queue = @queue AND state = 'running' AND lease_until <= @now
  `),
  claim: db.prepare<{ queue: string; workerId: string; now: number; leaseUntil: number }, JobRow>(`
    UPDATE jobs SET state = 'running', worker_id = @workerId, lease_until = @leaseUntil,
      attempts = attempts + 1, started_at = @now
    WHERE id = (
      SELECT id FROM jobs WHERE queue = @queue AND state = 'pending' AND run_at <= @now
      ORDER BY priority DESC, run_at, id LIMIT 1
    )
    RETURNING *
  `),
  ack: db.prepare<{ id: number; workerId: string; attempts: number; now: number }>(
    `UPDATE jobs SET state = 'done', lease_until = NULL, finished_at = @now WHERE ${FENCE}`,
  ),
  fail: db.prepare<{ id: number; workerId: string; attempts: number; now: number; error: string }>(
    `UPDATE jobs SET state = 'failed', lease_until = NULL, finished_at = @now, last_error = @error
     WHERE ${FENCE}`,
  ),
  retry: db.prepare<{
    id: number;
    workerId: string;
    attempts: number;
    now: number;
    runAt: number;
    error: string;
  }>(`
    UPDATE jobs SET
      state = CASE WHEN cancel_requested = 1 THEN 'cancelled' ELSE 'pending' END,
      finished_at = CASE WHEN cancel_requested = 1 THEN @now END,
      worker_id = NULL, lease_until = NULL, run_at = @runAt, last_error = @error
    WHERE ${FENCE}
  `),
  requeue: db.prepare<{
    id: number;
    workerId: string;
    attempts: number;
    now: number;
    refund: number;
  }>(`
    UPDATE jobs SET
      state = CASE WHEN cancel_requested = 1 THEN 'cancelled' ELSE 'pending' END,
      finished_at = CASE WHEN cancel_requested = 1 THEN @now END,
      worker_id = NULL, lease_until = NULL, run_at = @now + 1000,
      attempts = MAX(0, attempts - @refund)
    WHERE ${FENCE}
  `),
  adjustAttempts: db.prepare<{ id: number; workerId: string; attempts: number; delta: number }>(
    `UPDATE jobs SET attempts = MAX(0, attempts + @delta) WHERE ${FENCE}`,
  ),
  heartbeat: db.prepare<
    { id: number; workerId: string; attempts: number; leaseUntil: number },
    Pick<JobRow, "cancel_requested">
  >(`UPDATE jobs SET lease_until = @leaseUntil WHERE ${FENCE} RETURNING cancel_requested`),
  cancel: db.prepare<{ id: number; queue: string; now: number }>(`
    UPDATE jobs SET
      state = CASE state WHEN 'pending' THEN 'cancelled' ELSE state END,
      finished_at = CASE state WHEN 'pending' THEN @now ELSE finished_at END,
      cancel_requested = 1
    WHERE id = @id AND queue = @queue AND state IN ('pending', 'running')
  `),
  getJob: db.prepare<[number, string], JobRow>("SELECT * FROM jobs WHERE id = ? AND queue = ?"),
  listActive: db.prepare<[string], JobRow>(
    "SELECT * FROM jobs WHERE queue = ? AND state IN ('pending', 'running') ORDER BY id",
  ),
  claimable: db.prepare<{ queue: string; now: number }, { found: number }>(`
    SELECT 1 AS found FROM jobs
    WHERE queue = @queue AND (
      (state = 'pending' AND run_at <= @now) OR (state = 'running' AND lease_until <= @now)
    ) LIMIT 1
  `),
  readyCount: db.prepare<[string, number], { count: number }>(
    "SELECT COUNT(*) AS count FROM jobs WHERE queue = ? AND state = 'pending' AND run_at <= ?",
  ),
  queuesWithWork: db.prepare<{ now: number }, Pick<JobRow, "queue">>(`
    SELECT DISTINCT queue FROM jobs
    WHERE (state = 'pending' AND run_at <= @now) OR (state = 'running' AND lease_until <= @now)
  `),
  nextDue: db.prepare<{ queue: string; now: number }, { due: number | null }>(`
    SELECT MIN(due) AS due FROM (
      SELECT MIN(run_at) AS due FROM jobs WHERE queue = @queue AND state = 'pending' AND run_at > @now
      UNION ALL
      SELECT MIN(lease_until) FROM jobs WHERE queue = @queue AND state = 'running'
    )
  `),
  running: db.prepare<[], JobRow>("SELECT * FROM jobs WHERE state = 'running'"),
  settleAbandoned: db.prepare<{ id: number; workerId: string | null; now: number; error: string }>(`
    UPDATE jobs SET state = ${SETTLED}, worker_id = NULL, lease_until = NULL,
      finished_at = CASE WHEN cancel_requested = 1 OR attempts >= max_attempts THEN @now END,
      last_error = @error
    WHERE id = @id AND state = 'running' AND worker_id IS @workerId
  `),
  tryLock: db.prepare<{ name: string; owner: string; now: number; expiresAt: number }>(`
    INSERT INTO job_locks (name, owner, expires_at) VALUES (@name, @owner, @expiresAt)
    ON CONFLICT (name) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at
    WHERE job_locks.expires_at <= @now
  `),
  renewLock: db.prepare<{ name: string; owner: string; now: number; expiresAt: number }>(
    "UPDATE job_locks SET expires_at = @expiresAt WHERE name = @name AND owner = @owner AND expires_at > @now",
  ),
  releaseLock: db.prepare<[string, string]>("DELETE FROM job_locks WHERE name = ? AND owner = ?"),
  lockHeld: db.prepare<[string, number], { found: number }>(
    "SELECT 1 AS found FROM job_locks WHERE name = ? AND expires_at > ?",
  ),
  lockOwned: db.prepare<[string, string, number], { found: number }>(
    "SELECT 1 AS found FROM job_locks WHERE name = ? AND owner = ? AND expires_at > ?",
  ),
  releaseGroupLocks: db.prepare<[string]>("DELETE FROM job_locks WHERE owner LIKE ? || ':%'"),
  releaseAllLocks: db.prepare("DELETE FROM job_locks"),
  pruneFinished: db.prepare<[number]>(
    "DELETE FROM jobs WHERE state IN ('done', 'failed', 'cancelled') AND finished_at < ?",
  ),
};

function claimedJob<Payload>(
  row: JobRow,
  payload: Payload,
  state = { attempts: row.attempts },
): ClaimedJob<Payload> {
  const workerId = row.worker_id ?? WORKER_ID;
  const fence = () => ({ id: row.id, workerId, attempts: state.attempts });
  return {
    id: row.id,
    queue: row.queue,
    kind: row.kind,
    payload,
    get attempts() {
      return state.attempts;
    },
    withPayload: (next) => claimedJob(row, next, state),
    maxAttempts: row.max_attempts,
    createdAt: row.created_at,
    runAt: row.run_at,
    ack: () => statements.ack.run({ ...fence(), now: Date.now() }).changes > 0,
    fail: (error) =>
      statements.fail.run({ ...fence(), now: Date.now(), error: error.slice(0, 2000) }).changes > 0,
    retry: (delayMs, error) => {
      const now = Date.now();
      const changed =
        statements.retry.run({
          ...fence(),
          now,
          runAt: now + Math.max(0, delayMs),
          error: error.slice(0, 2000),
        }).changes > 0;
      if (changed) wakeQueue(row.queue);
      return changed;
    },
    requeue: ({ refundAttempt = true } = {}) => {
      const changed =
        statements.requeue.run({ ...fence(), now: Date.now(), refund: refundAttempt ? 1 : 0 })
          .changes > 0;
      if (changed) wakeQueue(row.queue);
      return changed;
    },
    adjustAttempts: (delta) => {
      const changed = statements.adjustAttempts.run({ ...fence(), delta }).changes > 0;
      if (changed) state.attempts = Math.max(0, state.attempts + delta);
      return changed;
    },
    heartbeat: () => {
      const leaseMs = queues.get(row.queue)?.leaseMs ?? 60_000;
      const held = statements.heartbeat.get({ ...fence(), leaseUntil: Date.now() + leaseMs });
      if (!held) return "lost";
      return held.cancel_requested ? "cancelled" : "held";
    },
  };
}

export type Queue<Payload extends object> = ReturnType<typeof defineQueue<Payload>>;
export type AnyQueue = Omit<Queue<object>, "enqueue" | "priority">;

const queues = new Map<string, AnyQueue>();

export function defineQueue<Payload extends object>(config: QueueConfig<Payload>) {
  const { name, leaseMs, maxAttempts, priority } = config;

  const enqueueTx = db.transaction(
    (payload: Payload, options: EnqueueOptions<Payload>, now: number) => {
      const runAt = options.runAt ?? now + Math.max(0, options.delayMs ?? 0);
      const kind = payloadKind(name, payload);
      if (options.mergeInto) {
        for (const waiting of statements.waitingOfKind.all(name, kind)) {
          const current = parseJobPayload(waiting.payload);
          const merged = current && options.mergeInto(current);
          if (!merged) continue;
          const mergeRunAt = options.mergeDelayMs == null ? runAt : now + options.mergeDelayMs;
          statements.merge.run(JSON.stringify(merged), mergeRunAt, waiting.id);
          return waiting.id;
        }
      }
      const dedupeKey = options.dedupeKey ?? null;
      const inserted = statements.insert.get(
        name,
        kind,
        JSON.stringify(payload),
        dedupeKey,
        options.priority ?? priority?.(payload) ?? 0,
        runAt,
        options.maxAttempts ?? maxAttempts,
        now,
      );
      if (inserted) return inserted.id;
      return statements.activeByKey.get(name, dedupeKey ?? "")!.id;
    },
  );

  const claimTx = db.transaction((workerId: string, now: number) => {
    statements.expireLeases.run({ queue: name, now });
    return statements.claim.get({ queue: name, workerId, now, leaseUntil: now + leaseMs });
  });

  const queue = {
    ...config,
    retryDelayFor(attempts: number) {
      return config.backoff === "exponential"
        ? config.retryDelayMs * 2 ** Math.max(0, attempts - 1)
        : config.retryDelayMs;
    },
    enqueue(payload: Payload, options: EnqueueOptions<Payload> = {}) {
      const id = enqueueTx(payload, options, Date.now());
      if (db.inTransaction) queueMicrotask(() => wakeQueue(name));
      else wakeQueue(name);
      return id;
    },
    claim(workerId: string = WORKER_ID, now = Date.now()) {
      const row = claimTx(workerId, now);
      return row ? claimedJob(row, parseJobPayload(row.payload)) : null;
    },
    getJob(id: number) {
      return statements.getJob.get(id, name) ?? null;
    },
    list() {
      return statements.listActive
        .all(name)
        .map((row) => ({ ...row, payload: parseJobPayload(row.payload) }));
    },
    cancel(id: number) {
      return statements.cancel.run({ id, queue: name, now: Date.now() }).changes > 0;
    },
    hasClaimableJobs(now = Date.now()) {
      return Boolean(statements.claimable.get({ queue: name, now }));
    },
    readyCount(now = Date.now()) {
      return statements.readyCount.get(name, now)?.count ?? 0;
    },
    nextDueAt(now = Date.now()) {
      return statements.nextDue.get({ queue: name, now })?.due ?? null;
    },
  };
  queues.set(name, queue);
  return queue;
}

export function getQueue(name: string) {
  return queues.get(name) ?? null;
}

export function listQueues() {
  return [...queues.values()];
}

export function ownsQueueHere(name: string) {
  const owner = queues.get(name)?.group;
  if (!owner) return false;
  if (process.env.NODE_ENV === "test" && !process.env.AURRAL_BACKGROUND_WORKER_GROUP) return true;
  return owner === process.env.AURRAL_BACKGROUND_WORKER_GROUP;
}

const localWaiters = new Map<string, Set<() => void>>();
let routeWake: ((queue: string) => void) | null = null;

export function configureQueueWake(handler: ((queue: string) => void) | null) {
  routeWake = handler;
}

export function onQueueWake(name: string, listener: () => void) {
  const listeners = localWaiters.get(name) ?? new Set();
  listeners.add(listener);
  localWaiters.set(name, listeners);
  return () => listeners.delete(listener);
}

export function notifyLocalWaiters(name: string) {
  for (const listener of localWaiters.get(name) ?? []) listener();
}

export function wakeQueue(name: string) {
  const queue = queues.get(name);
  if (!queue) return;
  if (ownsQueueHere(name)) {
    notifyLocalWaiters(name);
    if (queue.skipInTest && process.env.NODE_ENV === "test") return;
    queue.start().catch((error) => console.warn(`[jobs] Could not start ${name}:`, error));
    return;
  }
  try {
    if (process.env.AURRAL_BACKGROUND_WORKER_GROUP && process.connected && process.send) {
      process.send({ type: "queue-wake", queue: name });
    } else {
      routeWake?.(name);
    }
  } catch (error) {
    console.warn(`[jobs] Could not wake ${name}:`, error);
  }
}

export function listGroupsWithWork(now = Date.now()) {
  const groups = new Set<WorkerGroup>();
  for (const { queue } of statements.queuesWithWork.all({ now })) {
    const owner = queues.get(queue)?.group;
    if (owner) groups.add(owner);
  }
  return [...groups];
}

const nextWorkStatement = db.prepare<{ now: number }, { due: number | null }>(`
  SELECT MIN(due) AS due FROM (
    SELECT MIN(run_at) AS due FROM jobs WHERE state = 'pending' AND run_at > @now
    UNION ALL
    SELECT MIN(lease_until) FROM jobs WHERE state = 'running' AND lease_until > @now
    UNION ALL
    SELECT MIN(next_run_at) FROM job_schedules
  )
`);

export function getNextWorkAt(now = Date.now()) {
  return nextWorkStatement.get({ now })?.due ?? null;
}

export async function recoverAbandonedJobs(reason: string, group: string | null = null) {
  const abandoned = statements.running
    .all()
    .filter((row) => group == null || queues.get(row.queue)?.group === group);
  for (const row of abandoned) {
    try {
      await queues.get(row.queue)?.onAbandoned?.(row, reason);
    } catch (error) {
      console.warn(`[jobs] Could not clean up ${row.queue} job ${row.id}:`, error);
    }
    statements.settleAbandoned.run({
      id: row.id,
      workerId: row.worker_id,
      now: Date.now(),
      error: reason,
    });
  }
  if (group == null) statements.releaseAllLocks.run();
  else statements.releaseGroupLocks.run(group);
  for (const name of new Set(abandoned.map((row) => row.queue))) wakeQueue(name);
  return abandoned.length;
}

export function pruneFinishedJobs(before: number) {
  return statements.pruneFinished.run(before).changes;
}

export function tryLock(name: string, owner: string, ttlMs: number) {
  const now = Date.now();
  return statements.tryLock.run({ name, owner, now, expiresAt: now + ttlMs }).changes > 0;
}

export function renewLock(name: string, owner: string, ttlMs: number) {
  const now = Date.now();
  return statements.renewLock.run({ name, owner, now, expiresAt: now + ttlMs }).changes > 0;
}

export function releaseLock(name: string, owner: string) {
  statements.releaseLock.run(name, owner);
}

export function isLockHeld(name: string) {
  return Boolean(statements.lockHeld.get(name, Date.now()));
}

export function ownsLock(name: string, owner: string) {
  return Boolean(statements.lockOwned.get(name, owner, Date.now()));
}

const inProcessLockTails = new Map<string, Promise<void>>();

export async function withLock<T>(
  name: string,
  fn: () => T,
  { ttlMs = 120_000, waitTimeoutMs = 300_000, retryDelayMs = 250 } = {},
) {
  const deadline = Date.now() + Math.max(0, waitTimeoutMs);
  const previousTail = inProcessLockTails.get(name) ?? Promise.resolve();
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const tail = previousTail.then(() => gate);
  inProcessLockTails.set(name, tail);
  const timedOut = () => new Error(`Timed out waiting for lock: ${name}`);

  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const gateAcquired = await Promise.race([
      previousTail.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), Math.max(0, deadline - Date.now()));
        timer.unref?.();
      }),
    ]).finally(() => clearTimeout(timer));
    if (!gateAcquired) throw timedOut();

    while (!tryLock(name, WORKER_ID, ttlMs)) {
      if (Date.now() >= deadline) throw timedOut();
      await new Promise((resolve) => setTimeout(resolve, Math.max(50, retryDelayMs)));
    }

    const heartbeat = setInterval(
      () => renewLock(name, WORKER_ID, ttlMs),
      Math.max(1000, Math.floor(ttlMs / 3)),
    );
    try {
      return await fn();
    } finally {
      clearInterval(heartbeat);
      releaseLock(name, WORKER_ID);
    }
  } finally {
    releaseGate();
    if (inProcessLockTails.get(name) === tail) inProcessLockTails.delete(name);
  }
}

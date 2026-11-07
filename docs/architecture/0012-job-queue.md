# The job queue

Status: Accepted

## Problem

Background work ran on Honker, which opened `aurral.db` with its own copy of SQLite next to better-sqlite3. Enqueueing a job wasn't atomic with the app's writes, Aurral read and wrote Honker's private tables, and the npm package had no Windows build. Aurral had also rebuilt most of a queue around it: worker loops, recovery, wakes, and a separate run ledger.

## Decision

Aurral owns a small queue on the better-sqlite3 connection it already has, in `backend/services/jobs/`.

- **Three tables.** `jobs` holds every job and its history, `job_locks` holds named locks with a TTL, and `job_schedules` holds recurring tasks. Times are in milliseconds.
- **One definition per queue.** `defineQueue` in `queues.ts` names the queue, its worker group, lease, attempts, and backoff, and types its payload.
- **Claims and settles are fenced.** A claim is one `UPDATE ... RETURNING` inside `BEGIN IMMEDIATE`, so two processes never get the same job. Ack, retry, and heartbeat match the worker ID and attempt count, so a worker whose lease lapsed can't overwrite a newer claim.
- **Dedupe in one statement.** A unique index on `(queue, dedupe_key)` over pending and running jobs makes enqueue a single `INSERT ... ON CONFLICT`.
- **No polling.** Enqueue wakes the owning worker over IPC. The supervisor sets one timer for the next due job or schedule, and runs due schedules in the main process.
- **Restart recovery is one update.** One Aurral owns a data dir, so at boot every running job is orphaned. Worker IDs are random per process. A queue's `onAbandoned` hook cleans up after its own jobs.

## Traps

- Cancelling a running job only sets `cancel_requested`. The job stays `running` until its worker sees the flag on the next heartbeat and aborts. Code that loops until a job is gone must yield, or it never ends.
- An enqueue inside a transaction wakes its worker after the commit. A wake before the commit would find nothing to claim.
- In tests, the test process owns every queue, so enqueueing starts that queue's worker in-process unless the queue sets `skipInTest`. A test that checks queued state stubs `queue.start` first.
- `groups.ts` must not import the database. Importing `queue.ts` opens `aurral.db`, and the supervisor reads the group list at import time.

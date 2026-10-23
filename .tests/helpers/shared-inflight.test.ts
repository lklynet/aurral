import { test } from "vite-plus/test";
import assert from "node:assert/strict";

import { runSharedInflight } from "../../backend/services/sharedInflight.ts";

test("concurrent consumers share one outbound operation", async () => {
  const inflight = new Map();
  let calls = 0;
  const task = async () => {
    calls += 1;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    return "ok";
  };

  const [left, right] = await Promise.all([
    runSharedInflight(inflight, "same", task),
    runSharedInflight(inflight, "same", task),
  ]);

  assert.equal(left, "ok");
  assert.equal(right, "ok");
  assert.equal(calls, 1);
  assert.equal(inflight.size, 0);
});

test("one cancelled consumer does not abort work still needed by another", async () => {
  const inflight = new Map();
  const first = new AbortController();
  const second = new AbortController();
  let underlyingAborted = false;

  const task = (signal: AbortSignal) =>
    new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => resolve("done"), 15);
      signal.addEventListener(
        "abort",
        () => {
          underlyingAborted = true;
          clearTimeout(timer);
          reject(signal.reason);
        },
        { once: true },
      );
    });

  const cancelled = runSharedInflight(inflight, "same", task, { signal: first.signal });
  const retained = runSharedInflight(inflight, "same", task, { signal: second.signal });
  first.abort();

  await assert.rejects(cancelled, { name: "AbortError" });
  assert.equal(await retained, "done");
  assert.equal(underlyingAborted, false);
});

test("the underlying operation aborts after every consumer leaves", async () => {
  const inflight = new Map();
  const first = new AbortController();
  const second = new AbortController();
  let underlyingAborted = false;

  const task = (signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => {
          underlyingAborted = true;
          reject(signal.reason);
        },
        { once: true },
      );
    });

  const left = runSharedInflight(inflight, "same", task, { signal: first.signal });
  const right = runSharedInflight(inflight, "same", task, { signal: second.signal });
  first.abort();
  second.abort();

  await Promise.allSettled([left, right]);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(underlyingAborted, true);
  assert.equal(inflight.size, 0);
});

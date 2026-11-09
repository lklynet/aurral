import assert from "node:assert/strict";
import http from "node:http";
import { getRequestListener } from "@hono/node-server";
import * as v from "valibot";
import { afterAll, test, vi } from "vite-plus/test";
import {
  cleanupIsolatedState,
  listeningAddress,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.ts";

const [state, { defineQueue }, { createJobWorker }, logs, { watchEventLoop }, { app }] =
  await setupIsolatedBackend(
    "event-loop-watch",
    () => import("../../backend/services/jobs/queue.ts"),
    () => import("../../backend/services/jobs/worker.ts"),
    () => import("../../backend/services/logger.ts"),
    () => import("../../backend/services/eventLoopWatch.ts"),
    () => import("../../backend/app.ts"),
  );

afterAll(() => cleanupIsolatedState(state));

const queue = defineQueue<{ kind: string }>({
  name: "event-loop-watch-jobs",
  group: "maintenance",
  leaseMs: 30_000,
  maxAttempts: 1,
  retryDelayMs: 1000,
  timeoutMs: 30_000,
  skipInTest: true,
  start: async () => undefined,
});

test("work that blocks the event loop and then finishes is still named in the log", async () => {
  const entries: { level: string; msg: string; data?: unknown }[] = [];
  logs.startLogSink((entry) => entries.push(entry));
  let clock = 0;
  using _now = vi.spyOn(performance, "now").mockImplementation(() => clock);
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const stopWatching = watchEventLoop();
  const server = http.createServer(getRequestListener(app.fetch));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const id = queue.enqueue({ kind: "scan" });
    const finished = Promise.withResolvers<void>();
    const worker = createJobWorker(queue, {
      schema: v.looseObject({ kind: v.string() }),
      processJob: () => {
        clock = 6500;
      },
      onJobSuccess: () => finished.resolve(),
    });
    void worker.start();
    await finished.promise;
    await worker.stop();
    await fetch(
      `http://127.0.0.1:${listeningAddress(server).port}/api/library/stream/album-1/track-1?token=secret`,
    );
    vi.advanceTimersToNextTimer();
    assert.partialDeepStrictEqual(
      entries.filter((entry) => entry.msg.startsWith("Stopped responding")),
      [
        {
          level: "warn",
          msg: "Stopped responding for 6.0s",
          data: {
            running: [
              `event-loop-watch-jobs:${id} scan`,
              "GET /api/library/stream/:albumId/:trackId",
            ],
          },
        },
      ],
    );
  } finally {
    stopWatching();
    vi.useRealTimers();
    server.close();
  }
});

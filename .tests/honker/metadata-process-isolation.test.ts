import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { test, afterAll } from "vite-plus/test";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { WorkerMessage } from "../../backend/services/backgroundProcessSupervisor.ts";
import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  createMockHttpServer,
} from "../helpers/backendTestHarness.ts";

const [paths, honker, { dbOps }, { upsertLibraryArtist }, { db }] = await setupIsolatedBackend(
  "metadata-process-isolation",
  () => import("../../backend/services/honkerDb.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/services/libraryMediaStore.ts"),
  () => import("../../backend/config/db-sqlite.ts"),
);
afterAll(() => cleanupIsolatedState(paths));

test(
  "an isolated metadata request does not delay unrelated system tasks",
  { timeout: 10000 },
  async () => {
    let requested!: () => void, release!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
      requested = resolve;
    });
    const responseReleased = new Promise<void>((resolve) => {
      release = resolve;
    });
    const server = await createMockHttpServer(async (request, response) => {
      requested();
      await responseReleased;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ id: String(request.url).split("/").pop(), Albums: [] }));
    });
    const previous = dbOps.getSettings();
    dbOps.updateSettings({
      ...previous,
      integrations: {
        ...previous.integrations,
        metadata: {
          ...previous.integrations?.metadata,
          baseUrl: server.url,
          enableNarrowFallbacks: false,
        },
      },
    });
    const artist = upsertLibraryArtist({
      identityKey: `mbid:${randomUUID()}`,
      mbid: randomUUID(),
      name: "Process Isolation Artist",
    });
    const children: import("node:child_process").ChildProcess[] = [];
    const ready = new Map();
    const finished = new Map();
    const broadcasts: Extract<WorkerMessage, { type: "websocket-broadcast" }>[] = [];
    const startedJobs = new Set();
    function launch(group: string) {
      let resolveReady!: () => void;
      const started = new Promise<void>((resolve) => {
        resolveReady = resolve;
      });
      ready.set(group, started);
      const child = fork(
        fileURLToPath(new URL("../fixtures/metadata-worker-child.mts", import.meta.url)),
        [],
        {
          env: { ...process.env, AURRAL_BACKGROUND_WORKER_GROUP: group },
          stdio: ["ignore", "ignore", "pipe", "ipc"],
        },
      );
      children.push(child);
      child.on("message", (rawMessage) => {
        const message = rawMessage as WorkerMessage;
        if (message.type === "ready") resolveReady();
        if (message.type === "job-started") startedJobs.add(message.jobId);
        if (message.type === "job-finished") finished.get(message.jobId)?.();
        if (message.type === "websocket-broadcast") broadcasts.push(message);
      });
      return child;
    }
    const metadata = launch("release-metadata");
    const downloads = launch("downloads");
    const waitFinished = (id: number) =>
      new Promise<void>((resolve) => {
        finished.set(id, resolve);
      });
    try {
      await Promise.all(ready.values());
      const metadataId = honker
        .getReleaseMetadataQueue()
        .enqueue({ kind: "release-metadata-refresh" });
      const metadataDone = waitFinished(metadataId);
      metadata.send({ type: "queue-wake" });
      await requestStarted;
      assert.equal(honker.getReleaseMetadataQueue().getJob(metadataId)?.state, "processing");
      const taskId = honker.getSystemTaskQueue().enqueue({ kind: "library-index-refresh" });
      const taskDone = waitFinished(taskId);
      downloads.send({ type: "queue-wake" });
      await taskDone;
      assert.equal(honker.getSystemTaskQueue().getJob(taskId), null);
      assert.equal(honker.getReleaseMetadataQueue().getJob(metadataId)?.state, "processing");
      const events = honker.getHonkerDb().updateEvents();
      const legacyId = honker.getSystemTaskQueue().enqueue({ kind: "release-metadata-refresh" });
      const legacyDone = waitFinished(legacyId);
      downloads.send({ type: "queue-wake" });
      try {
        while (
          honker.getSystemTaskQueue().getJob(legacyId)?.state !== "processing" ||
          honker.getSystemTaskQueue().getJob(legacyId)?.attempts !== 0
        )
          await events.next();
        assert.equal(
          startedJobs.has(legacyId),
          false,
          "lease waits must not start the execution watchdog",
        );
      } finally {
        events.close();
      }
      release();
      await metadataDone;
      assert.equal(honker.getReleaseMetadataQueue().getJob(metadataId), null);
      await legacyDone;
      assert.equal(honker.getSystemTaskQueue().getJob(legacyId), null);
      assert.equal(
        broadcasts.filter((message) => message.data?.type === "release_metadata_refreshed").length,
        2,
      );
      assert.equal(
        db
          .prepare<
            unknown[],
            { status: import("../../backend/db/rows.ts").HonkerTaskRunsRow["status"] }
          >("SELECT status FROM honker_task_runs WHERE job_id = ? ORDER BY id DESC LIMIT 1")
          .get(metadataId)?.status,
        "completed",
      );
    } finally {
      release();
      await Promise.all(
        children.map(
          (child) =>
            new Promise<void>((resolve) => {
              child.once("exit", resolve);
              child.send({ type: "shutdown" });
            }),
        ),
      );
      dbOps.updateSettings(previous);
      db.prepare("DELETE FROM library_artists WHERE id = ?").run(artist.id);
      await server.close();
    }
  },
);

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

import { insertJob } from "../helpers/jobs.ts";

const [paths, { releaseMetadataQueue, systemTaskQueue }, { upsertLibraryArtist }, { db }] =
  await setupIsolatedBackend(
    "metadata-process-isolation",
    () => import("../../backend/services/jobs/queues.ts"),
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
    const mbid = randomUUID();
    const artist = upsertLibraryArtist({
      identityKey: `mbid:${mbid}`,
      mbid,
      name: "Process Isolation Artist",
    });
    const server = await createMockHttpServer(async (_request, response) => {
      requested();
      await responseReleased;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          payload: {
            releases: [
              {
                release_group_mbid: randomUUID(),
                release_name: "Isolated Release",
                artist_mbids: [mbid],
                release_group_primary_type: "Album",
                release_date: new Date().toISOString().slice(0, 10),
              },
            ],
          },
        }),
      );
    });
    const children: import("node:child_process").ChildProcess[] = [];
    const ready = new Map();
    const finished = new Map();
    const broadcasts: Extract<WorkerMessage, { type: "websocket-broadcast" }>[] = [];
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
          env: {
            ...process.env,
            AURRAL_BACKGROUND_WORKER_GROUP: group,
            LISTENBRAINZ_MOCK_URL: server.url,
          },
          stdio: ["ignore", "ignore", "pipe", "ipc"],
        },
      );
      children.push(child);
      child.on("message", (rawMessage) => {
        const message = rawMessage as WorkerMessage;
        if (message.type === "ready") resolveReady();
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
      const metadataId = insertJob(db, releaseMetadataQueue.name, {
        kind: "release-metadata-refresh",
      });
      const metadataDone = waitFinished(metadataId);
      metadata.send({ type: "queue-wake" });
      await requestStarted;
      assert.equal(releaseMetadataQueue.getJob(metadataId)?.state, "running");
      const taskId = insertJob(db, systemTaskQueue.name, { kind: "library-index-refresh" });
      const taskDone = waitFinished(taskId);
      downloads.send({ type: "queue-wake" });
      await taskDone;
      assert.equal(systemTaskQueue.getJob(taskId)?.state, "done");
      assert.equal(releaseMetadataQueue.getJob(metadataId)?.state, "running");
      release();
      await metadataDone;
      assert.equal(releaseMetadataQueue.getJob(metadataId)?.state, "done");
      assert.equal(
        broadcasts.filter((message) => message.data?.type === "release_metadata_refreshed").length,
        1,
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
      db.prepare("DELETE FROM library_artists WHERE id = ?").run(artist.id);
      await server.close();
    }
  },
);

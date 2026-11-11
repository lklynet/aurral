type CapturedRequest = {
  method?: string;
  url?: string;
  headers: import("node:http").IncomingHttpHeaders;
  body: Record<string, string | number>;
};
import { requireFixture } from "../playlists/fixtures.ts";
import { listeningAddress } from "../helpers/backendTestHarness.ts";
import { insertJob } from "../helpers/jobs.ts";
import { test, beforeEach, afterAll } from "vite-plus/test";
import assert from "node:assert/strict";
import http from "node:http";
import * as v from "valibot";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.ts";

const [isolatedState, { db }, { dbOps }, notifications, { notificationQueue }] =
  await setupIsolatedBackend(
    "notifications",
    () => import("../../backend/config/db-sqlite.ts"),
    () => import("../../backend/db/helpers/index.ts"),
    () => import("../../backend/services/notificationService.ts"),
    () => import("../../backend/services/jobs/queues.ts"),
  );

const {
  interpolateBody,
  deliverQueuedNotification,
  notifyRequestMade,
  notifyRequestAvailable,
  notifyFlowDone,
  notifyArtistAdded,
  notifyTrackAdded,
  queuedNotificationSchema,
} = notifications;

async function withCaptureServer(
  handler: (server: {
    port: number;
    baseUrl: string;
    requests: CapturedRequest[];
    waitFor: (count: number) => Promise<CapturedRequest[]>;
  }) => Promise<void>,
) {
  const requests: CapturedRequest[] = [];
  let waiters: (() => boolean)[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: Record<string, string | number> = {};
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {}
      requests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body,
      });
      waiters = waiters.filter((settle) => !settle());
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = listeningAddress(server);
  try {
    await handler({
      port,
      baseUrl: `http://127.0.0.1:${port}`,
      requests,
      waitFor: (count: number) =>
        new Promise<CapturedRequest[]>((resolve) => {
          const settle = () => requests.length >= count && (resolve(requests), true);
          if (!settle()) waiters.push(settle);
        }),
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

beforeEach(() => {
  resetDatabase(db);
});

afterAll(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("interpolateBody replaces request and flow placeholders", () => {
  assert.equal(
    interpolateBody(
      '{"album":"$albumName","artist":"$artistName","user":"$username","id":"$userId","event":"$event","flow":"$flowName","path":"$flowPath"}',
      {
        albumName: 'Blue "Train"',
        artistName: "John Coltrane",
        username: "alice",
        userId: "42",
        event: "notifyRequestMade",
        flowName: "Weekly",
        flowPath: "/flows/weekly",
      },
    ),
    '{"album":"Blue \\"Train\\"","artist":"John Coltrane","user":"alice","id":"42","event":"notifyRequestMade","flow":"Weekly","path":"/flows/weekly"}',
  );
});

test("interpolateBody does not rescan substituted placeholder values", () => {
  assert.equal(
    interpolateBody('{"album":"$albumName","user":"$username"}', {
      albumName: "$username",
      username: "alice",
    }),
    '{"album":"$username","user":"alice"}',
  );
});

test("deliverQueuedNotification interpolates request webhook bodies", async () => {
  await withCaptureServer(async ({ baseUrl, waitFor }) => {
    await deliverQueuedNotification({
      kind: "webhook",
      event: "notifyRequestAvailable",
      webhook: {
        url: `${baseUrl}/hook`,
        body: '{"album":"$albumName","by":"$username","event":"$event"}',
        headers: [],
      },
      vars: {
        albumName: "Blue Train",
        artistName: "John Coltrane",
        username: "alice",
        userId: "7",
      },
    });
    const requests = await waitFor(1);
    assert.equal(requests[0]?.method, "POST");
    assert.equal(requests[0]?.url, "/hook");
    assert.deepEqual(requests[0]?.body, {
      album: "Blue Train",
      by: "alice",
      event: "notifyRequestAvailable",
    });
  });
});

test("notifyRequestMade queues Gotify with actor and webhook payload", async () => {
  await withCaptureServer(async ({ baseUrl, waitFor }) => {
    const settings = dbOps.getSettings();
    dbOps.updateSettings({
      integrations: {
        ...settings.integrations,
        gotify: {
          url: baseUrl,
          token: "test-token",
          notifyRequestMade: true,
          notifyRequestAvailable: false,
        },
        webhooks: [
          {
            url: `${baseUrl}/hook`,
            body: '{"album":"$albumName","user":"$username","event":"$event","text":"$message"}',
            headers: [],
            events: ["notifyRequestMade"],
          },
        ],
      },
    });

    await notifyRequestMade({
      albumName: "Blue Train",
      artistName: "John Coltrane",
      user: { id: 7, username: "alice" },
    });

    const requests = await waitFor(2);
    const gotify = requests.find((entry) => entry.url === "/message");
    const webhook = requests.find((entry) => entry.url === "/hook");
    assert.ok(gotify);
    assert.equal(gotify.headers["x-gotify-key"], "test-token");
    assert.equal(gotify.body.title, "Aurral – Request");
    assert.equal(gotify.body.message, "Album requested: Blue Train by John Coltrane (alice)");
    assert.ok(webhook != null);
    assert.deepEqual(webhook.body, {
      album: "Blue Train",
      user: "alice",
      event: "notifyRequestMade",
      text: "Album requested: Blue Train by John Coltrane (alice)",
    });
  });
});

test("each subscribed webhook is queued on its own, carrying only itself", async () => {
  await withCaptureServer(async ({ baseUrl, waitFor }) => {
    dbOps.updateSettings({
      integrations: {
        lidarr: { url: "http://lidarr.test", apiKey: "lidarr-secret" },
        webhooks: [
          { url: `${baseUrl}/discord`, headers: [], events: ["notifyArtistAdded"] },
          { url: `${baseUrl}/autopulse`, headers: [], events: ["notifyTrackAdded"] },
          {
            url: `${baseUrl}/both`,
            headers: [],
            events: ["notifyArtistAdded", "notifyTrackAdded"],
          },
        ],
      },
    });

    insertJob(db, "notifications", { kind: "email" });
    notifyArtistAdded({ artistName: "Slowdive", user: { id: 7, username: "alice" } });

    const queued = notificationQueue.list();
    assert.deepEqual(
      queued.flatMap((job) => {
        const queuedJob = v.safeParse(queuedNotificationSchema, requireFixture(job).payload);
        if (!queuedJob.success || queuedJob.output.kind !== "webhook") return [];
        const { webhook } = queuedJob.output;
        return webhook.url.startsWith(baseUrl) ? [webhook] : [];
      }),
      [
        { url: `${baseUrl}/discord`, headers: [], events: ["notifyArtistAdded"] },
        { url: `${baseUrl}/both`, headers: [], events: ["notifyArtistAdded", "notifyTrackAdded"] },
      ],
    );
    const requests = await waitFor(2);
    assert.deepEqual(requests.map((entry) => entry.url).sort(), ["/both", "/discord"]);
  });
});

test("notifyTrackAdded hands webhooks the file and its folder", async () => {
  await withCaptureServer(async ({ baseUrl, waitFor }) => {
    dbOps.updateSettings({
      integrations: {
        webhooks: [
          {
            url: `${baseUrl}/autopulse`,
            body: '{"path":"$path","folder":"$albumPath","track":"$trackName","text":"$message"}',
            headers: [],
            events: ["notifyTrackAdded"],
          },
        ],
      },
    });

    notifyTrackAdded({
      trackName: "Alison",
      artistName: "Slowdive",
      albumName: "Souvlaki",
      filePath: "/music/Slowdive/Souvlaki/01 - Alison.flac",
    });

    const [request] = await waitFor(1);
    assert.deepEqual(request?.body, {
      path: "/music/Slowdive/Souvlaki/01 - Alison.flac",
      folder: "/music/Slowdive/Souvlaki",
      track: "Alison",
      text: "Track added: Alison by Slowdive",
    });
  });
});

test("notifyRequestAvailable omits actor text when username is missing", async () => {
  await withCaptureServer(async ({ baseUrl, waitFor }) => {
    const settings = dbOps.getSettings();
    dbOps.updateSettings({
      integrations: {
        ...settings.integrations,
        gotify: {
          url: baseUrl,
          token: "test-token",
          notifyRequestMade: false,
          notifyRequestAvailable: true,
        },
        webhooks: [],
      },
    });

    await notifyRequestAvailable({
      albumName: "Blue Train",
      artistName: "John Coltrane",
      user: { id: 7 },
    });

    const requests = await waitFor(1);
    assert.equal(requests[0]?.body.message, "Album available: Blue Train by John Coltrane");
  });
});

test("notifyRequestMade does not queue Gotify when the event toggle is off", async () => {
  await withCaptureServer(async ({ baseUrl, waitFor }) => {
    const settings = dbOps.getSettings();
    dbOps.updateSettings({
      integrations: {
        ...settings.integrations,
        gotify: {
          url: baseUrl,
          token: "test-token",
          notifyRequestMade: false,
          notifyRequestAvailable: false,
        },
        webhooks: [
          {
            url: `${baseUrl}/hook`,
            body: '{"event":"$event"}',
            headers: [],
            events: ["notifyRequestAvailable"],
          },
        ],
      },
    });

    await notifyRequestMade({
      albumName: "Blue Train",
      artistName: "John Coltrane",
      user: { id: 7, username: "alice" },
    });

    await notifyRequestAvailable({ albumName: "Blue Train", artistName: "John Coltrane" });

    const requests = await waitFor(1);
    assert.deepEqual(
      requests.map((entry) => [entry.url, entry.body]),
      [["/hook", { event: "notifyRequestAvailable" }]],
    );
  });
});

test("failed notification delivery is logged without an unhandled rejection", async () => {
  const failedLogs: Record<string, unknown>[][] = [];
  let logged = () => {};
  const unhandled: unknown[] = [];
  const originalError = console.error;
  const onUnhandledRejection = (reason: unknown) => unhandled.push(reason);
  console.error = (...args) => {
    if (!args.map(String).join(" ").includes("Notification delivery failed")) return;
    failedLogs.push(args as Record<string, unknown>[]);
    logged();
  };
  const nextFailedLog = () =>
    new Promise<Record<string, unknown>[]>((resolve) => {
      const seen = failedLogs.length;
      logged = () => failedLogs.length > seen && resolve(requireFixture(failedLogs[seen]));
    });
  process.on("unhandledRejection", onUnhandledRejection);

  const server = http.createServer((_req, res) => {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("receiver-secret");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = listeningAddress(server);
  const webhookUrl = `http://127.0.0.1:${port}/hook?token=receiver-secret`;

  try {
    const settings = dbOps.getSettings();
    dbOps.updateSettings({
      integrations: {
        ...settings.integrations,
        gotify: { ...settings.integrations?.gotify, notifyRequestMade: false },
        webhooks: [
          {
            url: webhookUrl,
            body: '{"album":"$albumName"}',
            headers: [{ key: "Authorization", value: "receiver-secret" }],
            events: ["notifyRequestMade", "notifyRequestAvailable"],
          },
        ],
      },
    });

    const firstFailure = nextFailedLog();
    await notifyRequestMade({ albumName: "Blue Train", artistName: "John Coltrane" });
    const failedLog = await firstFailure;
    assert.deepEqual(failedLog[failedLog.length - 1], {
      kind: "webhooks",
      event: "notifyRequestMade",
      receiver: `127.0.0.1:${port}`,
      status: 500,
      message: `Request to 127.0.0.1:${port} failed with status code 500`,
    });
    assert.doesNotMatch(JSON.stringify(failedLog), /receiver-secret/);

    await new Promise<void>((resolve) => server.close(() => resolve()));
    const secondFailure = nextFailedLog();
    await notifyRequestAvailable({ albumName: "Blue Train", artistName: "John Coltrane" });
    const secondArgs = await secondFailure;
    const secondLog = requireFixture(secondArgs[secondArgs.length - 1]);
    assert.deepEqual(
      {
        kind: secondLog.kind,
        event: secondLog.event,
        status: secondLog.status,
      },
      { kind: "webhooks", event: "notifyRequestAvailable", status: null },
    );
    assert.equal(unhandled.length, 0);
  } finally {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    process.off("unhandledRejection", onUnhandledRejection);
    console.error = originalError;
  }
});

test("notifyFlowDone uses display name and track library path placeholders", async () => {
  await withCaptureServer(async ({ baseUrl, waitFor }) => {
    const settings = dbOps.getSettings();
    dbOps.updateSettings({
      integrations: {
        ...settings.integrations,
        gotify: {
          url: baseUrl,
          token: "test-token",
          notifyFlowDone: true,
        },
        webhooks: [
          {
            url: `${baseUrl}/hook`,
            body: '{"name":"$flowName","path":"$flowPath"}',
            headers: [],
            events: ["notifyFlowDone"],
          },
        ],
      },
    });

    const playlistId = "c0c01bc3-72ca-4110-8ab6-681f132a6e63";
    const flowPath = `/data/downloads/aurral/_flows/${playlistId}`;
    await notifyFlowDone(playlistId, { completed: 3, failed: 1 }, flowPath, "Late Night");

    const requests = await waitFor(2);
    const gotify = requests.find((entry) => entry.url === "/message");
    const webhook = requests.find((entry) => entry.url === "/hook");
    assert.ok(gotify);
    assert.equal(gotify.headers["x-gotify-key"], "test-token");
    assert.match(String(gotify.body.message), /Flow "Late Night"/);
    assert.doesNotMatch(String(gotify.body.message), /c0c01bc3-72ca-4110-8ab6-681f132a6e63/);
    assert.ok(webhook != null);
    assert.deepEqual(webhook.body, {
      name: "Late Night",
      path: flowPath,
    });
    assert.ok(webhook != null);
    assert.doesNotMatch(webhook.body.path, /_playlists/);
  });
});

test("an Aurral album request is available once its last track is filed", async () => {
  const { downloadTracker } =
    await import("../../backend/services/downloadJobs/downloadTracker.ts");
  const { recordPipelineJobSuccess } = await import("../../backend/services/pipelineHelpers.ts");
  const { recordAlbumRequested } = await import("../../backend/services/aurralHistoryService.ts");
  downloadTracker.clearAll();
  await withCaptureServer(async ({ baseUrl, waitFor }) => {
    dbOps.updateSettings({
      integrations: {
        webhooks: [
          {
            url: `${baseUrl}/beets`,
            body: '{"album":"$albumName","folder":"$albumPath"}',
            headers: [],
            events: ["notifyRequestAvailable"],
          },
        ],
      },
    });
    const requestGroupId = "souvlaki-request";
    recordAlbumRequested({
      albumId: "77",
      albumName: "Souvlaki",
      artistName: "Slowdive",
      requestGroupId,
    });
    const queue = (trackName: string) =>
      requireFixture(
        downloadTracker.addJob(
          { artistName: "Slowdive", trackName, albumName: "Souvlaki", requestGroupId },
          "library",
        ),
      );
    const first = queue("Alison");
    const second = queue("Machine Gun");
    const file = (jobId: string, name: string) =>
      recordPipelineJobSuccess({
        downloadTracker,
        job: requireFixture(downloadTracker.getJob(jobId)),
        committedFinalPath: `/music/Slowdive/Souvlaki/${name}`,
      });

    await file(first, "01 - Alison.flac");
    assert.equal(dbOps.getAlbumRequestByGroup(requestGroupId)?.statusLabel, "Requested");

    await file(second, "02 - Machine Gun.flac");
    assert.equal(dbOps.getAlbumRequestByGroup(requestGroupId)?.statusLabel, "Downloaded");
    const [request] = await waitFor(1);
    assert.deepEqual(request?.body, { album: "Souvlaki", folder: "/music/Slowdive/Souvlaki" });
  });
});

test("an Aurral album request with a failed track is not announced as available", async () => {
  const { downloadTracker } =
    await import("../../backend/services/downloadJobs/downloadTracker.ts");
  const { recordPipelineJobSuccess } = await import("../../backend/services/pipelineHelpers.ts");
  const { recordAlbumRequested } = await import("../../backend/services/aurralHistoryService.ts");
  downloadTracker.clearAll();
  const requestGroupId = "pygmalion-request";
  recordAlbumRequested({
    albumId: "78",
    albumName: "Pygmalion",
    artistName: "Slowdive",
    requestGroupId,
  });
  const queue = (trackName: string) =>
    requireFixture(
      downloadTracker.addJob(
        { artistName: "Slowdive", trackName, albumName: "Pygmalion", requestGroupId },
        "library",
      ),
    );
  const failed = queue("Rutti");
  const filed = queue("Crazy for You");
  downloadTracker.setFailed(failed, "No source had it");

  await recordPipelineJobSuccess({
    downloadTracker,
    job: requireFixture(downloadTracker.getJob(filed)),
    committedFinalPath: "/music/Slowdive/Pygmalion/02 - Crazy for You.flac",
  });

  assert.equal(dbOps.getAlbumRequestByGroup(requestGroupId)?.statusLabel, "Requested");
});

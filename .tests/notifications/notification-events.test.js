import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { db }, { dbOps }, notifications] = await setupIsolatedBackend(
  "notifications",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
  "backend/services/notificationService.js",
);

const { interpolateBody, deliverQueuedNotification, notifyRequestMade, notifyRequestAvailable } =
  notifications;

async function withCaptureServer(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body = raw;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {}
      requests.push({
        method: req.method,
        url: req.url,
        body,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    await handler({
      port,
      baseUrl: `http://127.0.0.1:${port}`,
      requests,
      waitFor: async (count, timeoutMs = 5000) => {
        const started = Date.now();
        while (requests.length < count) {
          if (Date.now() - started > timeoutMs) {
            throw new Error(
              `Timed out waiting for ${count} requests; got ${requests.length}`,
            );
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        return requests;
      },
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test.beforeEach(() => {
  resetDatabase(db);
});

test.after(async () => {
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

test("deliverQueuedNotification skips disabled webhook events", async () => {
  await withCaptureServer(async ({ baseUrl, requests }) => {
    await deliverQueuedNotification({
      kind: "webhooks",
      event: "notifyRequestMade",
      integrations: {
        webhookEvents: { notifyRequestMade: false },
        webhooks: [{ url: `${baseUrl}/hook`, body: '{"ok":true}', headers: [] }],
      },
      vars: { albumName: "Blue Train" },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(requests.length, 0);
  });
});

test("deliverQueuedNotification interpolates request webhook bodies", async () => {
  await withCaptureServer(async ({ baseUrl, waitFor }) => {
    await deliverQueuedNotification({
      kind: "webhooks",
      event: "notifyRequestAvailable",
      integrations: {
        webhookEvents: { notifyRequestAvailable: true },
        webhooks: [
          {
            url: `${baseUrl}/hook`,
            body: '{"album":"$albumName","by":"$username","event":"$event"}',
            headers: [],
          },
        ],
      },
      vars: {
        albumName: "Blue Train",
        artistName: "John Coltrane",
        username: "alice",
        userId: "7",
      },
    });
    const requests = await waitFor(1);
    assert.equal(requests[0].method, "POST");
    assert.equal(requests[0].url, "/hook");
    assert.deepEqual(requests[0].body, {
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
        webhookEvents: {
          notifyRequestMade: true,
          notifyRequestAvailable: false,
        },
        webhooks: [
          {
            url: `${baseUrl}/hook`,
            body: '{"album":"$albumName","user":"$username","event":"$event"}',
            headers: [],
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
    const gotify = requests.find((entry) => entry.url.startsWith("/message"));
    const webhook = requests.find((entry) => entry.url === "/hook");
    assert.ok(gotify);
    assert.equal(gotify.body.title, "Aurral – Request");
    assert.equal(
      gotify.body.message,
      "Album requested: Blue Train by John Coltrane (alice)",
    );
    assert.deepEqual(webhook.body, {
      album: "Blue Train",
      user: "alice",
      event: "notifyRequestMade",
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
        webhookEvents: {
          notifyRequestMade: false,
          notifyRequestAvailable: false,
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
    assert.equal(requests[0].body.message, "Album available: Blue Train by John Coltrane");
  });
});

test("notifyRequestMade does not queue Gotify when the event toggle is off", async () => {
  await withCaptureServer(async ({ baseUrl, requests }) => {
    const settings = dbOps.getSettings();
    dbOps.updateSettings({
      integrations: {
        ...settings.integrations,
        gotify: {
          url: baseUrl,
          token: "test-token",
          notifyRequestMade: false,
        },
        webhookEvents: {
          notifyRequestMade: false,
        },
        webhooks: [
          {
            url: `${baseUrl}/hook`,
            body: '{"event":"$event"}',
            headers: [],
          },
        ],
      },
    });

    await notifyRequestMade({
      albumName: "Blue Train",
      artistName: "John Coltrane",
      user: { id: 7, username: "alice" },
    });

    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(requests.length, 0);
  });
});

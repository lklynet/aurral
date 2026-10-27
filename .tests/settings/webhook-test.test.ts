type CapturedRequest = {
  method?: string;
  url?: string;
  headers: import("node:http").IncomingHttpHeaders;
  body: unknown;
};
import { listeningAddress } from "../helpers/backendTestHarness.ts";
import { signedInAs } from "../helpers/honoApp.ts";
import { testUser } from "../helpers/userFixtures.ts";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test, beforeEach, afterAll } from "vite-plus/test";

import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.ts";

const [isolatedState, { db }, { dbOps }, notifications, { api }] = await setupIsolatedBackend(
  "webhook-test",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/services/notificationService.ts"),
  () => import("../../backend/routes/api.ts"),
);

const { sendWebhookTest } = notifications;

const app = signedInAs(testUser(1, { role: "admin" })).route("/", api);

async function testWebhook(body: unknown) {
  const response = await app.request("/settings/webhook/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { statusCode: response.status, payload: await response.json() };
}

async function withReceiver(
  statusCode: number,
  callback: (receiver: { url: string; requests: CapturedRequest[] }) => Promise<void>,
) {
  const requests: CapturedRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const rawBody = Buffer.concat(chunks).toString("utf8");
      let body: unknown = rawBody;
      try {
        body = rawBody ? JSON.parse(rawBody) : null;
      } catch {}
      requests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body,
      });
      res.writeHead(statusCode, { "content-type": "text/plain" });
      res.end("receiver response");
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = listeningAddress(server);
    await callback({ url: `http://127.0.0.1:${port}/hook`, requests });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

beforeEach(() => {
  resetDatabase(db);
});

afterAll(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("webhook test route sends GET directly with disabled event toggles and does not save config", async () => {
  const savedWebhook = {
    url: "http://saved.example/hook",
    body: "saved body",
    headers: [{ key: "X-Saved", value: "true" }],
  };
  dbOps.updateSettings({
    integrations: {
      webhooks: [savedWebhook],
      webhookEvents: { notifyRequestMade: false },
    },
  });

  await withReceiver(200, async ({ url, requests }) => {
    const response = await testWebhook({
      url,
      body: "",
      headers: [{ key: "X-Test-Webhook", value: "get" }],
      webhookEvents: { notifyRequestMade: false },
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.payload, { success: true, message: "Test webhook sent" });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, "GET");
    assert.equal(requests[0].url, "/hook");
    assert.equal(requests[0].headers["x-test-webhook"], "get");
    assert.equal(requests[0].body, null);
  });

  assert.deepEqual(dbOps.getSettings().integrations.webhooks, [savedWebhook]);
  assert.deepEqual(dbOps.getSettings().integrations.webhookEvents, {
    notifyRequestMade: false,
  });
});

test("direct webhook test sends POST headers and fixed placeholder values without event toggles", async () => {
  await withReceiver(200, async ({ url, requests }) => {
    await sendWebhookTest({
      url,
      body: JSON.stringify({
        event: "$event",
        flow: "$flowName",
        path: "$flowPath",
        album: "$albumName",
        artist: "$artistName",
        user: "$username",
        id: "$userId",
      }),
      headers: [{ key: "X-Test-Webhook", value: "post" }],
    });

    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, "POST");
    assert.equal(requests[0].url, "/hook");
    assert.equal(requests[0].headers["x-test-webhook"], "post");
    assert.equal(requests[0].headers["content-type"], "application/json");
    assert.deepEqual(requests[0].body, {
      event: "webhookTest",
      flow: "Aurral webhook test",
      path: "/aurral/test-webhook",
      album: "Test album",
      artist: "Test artist",
      user: "webhook-test-user",
      id: "webhook-test-user",
    });
  });
});

test("webhook test route rejects missing, invalid, and blocked URLs", async () => {
  const cases = [
    [{}, "URL is required"],
    [{ url: "not a URL" }, "Invalid URL format"],
    [{ url: "ftp://example.com/hook" }, "Only HTTP and HTTPS URLs are allowed"],
    [{ url: "http://169.254.169.254/hook" }, "Target host is blocked"],
  ];

  for (const [body, error] of cases) {
    const response = await testWebhook(body);
    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.payload, { error });
  }
});

test("webhook test route returns receiver failures as useful JSON", async () => {
  await withReceiver(503, async ({ url }) => {
    const response = await testWebhook({ url, body: "", headers: [] });

    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.payload, {
      error: "Webhook test failed",
      message: "Request failed with status code 503",
    });
  });
});

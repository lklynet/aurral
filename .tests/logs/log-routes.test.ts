import assert from "node:assert/strict";
import type { Server } from "node:http";
import { join } from "node:path";
import { afterAll, beforeAll, test } from "vite-plus/test";
import type { RequestUser } from "../../backend/middleware/requestUser.ts";
import type { LogEntry } from "../../backend/services/logger.ts";
import { listen, signedInAs } from "../helpers/honoApp.ts";
import axios from "../../lib/axiosFetch.ts";
import {
  cleanupIsolatedState,
  createMockHttpServer,
  listeningAddress,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.ts";

const [
  isolatedState,
  { dbOps, userOps },
  { app },
  { api },
  { getApiKey },
  { createLogWriter },
  loggerModule,
  { logOutgoingFailures },
] = await setupIsolatedBackend(
  "log-routes",
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/app.ts"),
  () => import("../../backend/routes/api.ts"),
  () => import("../../backend/middleware/auth.ts"),
  () => import("../../backend/services/logFile.ts"),
  () => import("../../backend/services/logger.ts"),
  () => import("../../backend/services/logs.ts"),
);

const member: RequestUser = { id: 7, username: "member", role: "user", permissions: {} };
const reported: LogEntry[] = [];
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  userOps.createUser("owner", "password-hash", "admin");
  dbOps.updateSettings({ onboardingComplete: true });
  const writer = createLogWriter(join(isolatedState.dataDir, "logs"));
  const line = (overrides: Partial<LogEntry>): LogEntry => ({
    ts: new Date().toISOString(),
    level: "info",
    cat: "library",
    msg: "Scan finished",
    proc: "main",
    fp: "fp-scan",
    ...overrides,
  });
  writer.append(line({}));
  writer.append(line({ level: "error", cat: "lidarr", msg: "Lidarr returned 503", fp: "fp-503" }));
  writer.append(line({ level: "error", cat: "lidarr", msg: "Lidarr returned 503", fp: "fp-503" }));
  writer.flush();
  loggerModule.startLogSink((entry) => reported.push(entry));
  server = await listen(app);
  baseUrl = `http://127.0.0.1:${listeningAddress(server).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await cleanupIsolatedState(isolatedState);
});

const withKey = (path: string, init: RequestInit = {}) =>
  fetch(`${baseUrl}/api${path}`, {
    ...init,
    headers: { "x-api-key": getApiKey(), "content-type": "application/json", ...init.headers },
  });

test("an API key reads entries, problems, and the export", async () => {
  const list = await withKey("/logs?level=warn");
  assert.equal(list.status, 200);
  const { entries, debug } = await list.json();
  assert.equal(debug, false);
  assert.deepEqual(
    entries.map((entry: LogEntry) => entry.msg),
    ["Lidarr returned 503", "Lidarr returned 503"],
  );

  const problems = await (await withKey("/logs/problems")).json();
  assert.partialDeepStrictEqual(problems.problems, [{ fp: "fp-503", count: 2 }]);

  const exported = await withKey("/logs/export");
  assert.match(exported.headers.get("content-disposition") ?? "", /aurral-logs-.*\.txt/);
  const text = await exported.text();
  assert.match(text, /^Aurral /);
  assert.match(text, /ERROR \[lidarr\] Lidarr returned 503/);
  assert.match(text, /INFO {2}\[library\] Scan finished/);
});

test("the export lists integrations set up with only an API key", async () => {
  dbOps.updateSettings({
    integrations: { ...dbOps.getSettings().integrations, lastfm: { apiKey: "lastfm-key" } },
  });
  const text = await (await withKey("/logs/export")).text();
  assert.match(text, /^Integrations: .*\blastfm\b/m);
});

test("only admins read logs or change debug logging", async () => {
  assert.equal((await fetch(`${baseUrl}/api/logs`)).status, 401);
  const asMember = signedInAs(member).route("/", api);
  assert.equal((await asMember.request("/logs")).status, 403);
  assert.equal((await asMember.request("/logs/problems")).status, 403);
  const toggle = { method: "PUT", body: JSON.stringify({ enabled: true }) };
  assert.equal((await asMember.request("/logs/debug", toggle)).status, 403);

  assert.deepEqual(await (await withKey("/logs/debug", toggle)).json(), { debug: true });
  assert.equal((await (await withKey("/logs")).json()).debug, true);
  await withKey("/logs/debug", { method: "PUT", body: JSON.stringify({ enabled: false }) });
});

test("any signed-in user can report a browser error", async () => {
  const asMember = signedInAs(member).route("/", api);
  const response = await asMember.request("/logs/client", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      source: "react",
      name: "TypeError",
      message: "Cannot read properties of undefined (reading 'mbid')",
      stack: "TypeError: x\n    at ArtistDetails (index-abc.js:1:2)",
      page: "/artist/123",
    }),
  });

  assert.equal(response.status, 204);
  assert.partialDeepStrictEqual(reported.at(-1), {
    level: "error",
    cat: "browser",
    data: { source: "react", page: "/artist/123", user: "member" },
    err: { name: "TypeError", stack: "at ArtistDetails (index-abc.js:1:2)" },
  });
});

test("failed integration calls are saved without their query string or path tokens", async () => {
  logOutgoingFailures();
  const lidarr = await createMockHttpServer((_request, response) => {
    response.writeHead(503).end("busy");
  });
  try {
    await assert.rejects(axios.get(`${lidarr.url}/api/v1/album?apikey=hunter2`));
    await assert.rejects(
      axios.post(`${lidarr.url}/api/webhooks/123456789/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789`, {}),
    );
  } finally {
    await lidarr.close();
  }

  const [saved, webhook] = reported.slice(-2);
  assert.doesNotMatch(JSON.stringify(webhook), /AbCdEf/);
  assert.partialDeepStrictEqual(webhook, { data: { path: "/api/webhooks/123456789/***" } });
  assert.partialDeepStrictEqual(saved, {
    level: "warn",
    cat: "http",
    msg: `GET ${new URL(lidarr.url).host} returned 503`,
    data: { path: "/api/v1/album" },
  });
  assert.doesNotMatch(JSON.stringify(saved), /hunter2/);
});

test("a failed connection is saved with the network error behind it", async () => {
  logOutgoingFailures();
  const closed = await createMockHttpServer(() => {});
  await closed.close();

  await assert.rejects(axios.get(`${closed.url}/feed`));

  assert.partialDeepStrictEqual(reported.at(-1), {
    level: "warn",
    msg: `GET ${new URL(closed.url).host} failed`,
    data: { code: "ECONNREFUSED" },
  });
  assert.match(JSON.stringify(reported.at(-1)), /fetch failed: connect ECONNREFUSED/);
});

test("failures from one host group as one problem whatever the network said", async () => {
  logOutgoingFailures();
  const flaky = await createMockHttpServer((request) => request.socket.destroy());
  await assert.rejects(axios.get(`${flaky.url}/feed`));
  await flaky.close();
  await assert.rejects(axios.get(`${flaky.url}/feed`));

  const [dropped, refused] = reported.slice(-2);
  assert.ok(dropped && refused);
  assert.notDeepEqual(dropped.data, refused.data);
  assert.equal(dropped.fp, refused.fp);
});

test("starting fresh hides earlier problems until it is undone", async () => {
  const asMember = signedInAs(member).route("/", api);
  assert.equal((await asMember.request("/logs/fresh", { method: "POST" })).status, 403);

  const { freshSince } = await (await withKey("/logs/fresh", { method: "POST" })).json();
  assert.deepEqual((await (await withKey("/logs/problems")).json()).problems, []);
  const exported = await (await withKey("/logs/export?level=warn")).text();
  assert.match(exported, /Started fresh at /);
  assert.doesNotMatch(exported, /Lidarr returned 503/);

  const writer = createLogWriter(join(isolatedState.dataDir, "logs"));
  writer.append({
    ts: new Date(Date.parse(freshSince) + 1).toISOString(),
    level: "warn",
    cat: "slskd",
    msg: "slskd is unreachable",
    proc: "main",
    fp: "fp-slskd",
  });
  writer.flush();
  const after = await (await withKey("/logs/problems")).json();
  assert.equal(after.freshSince, freshSince);
  assert.deepEqual(
    after.problems.map((problem: { fp: string }) => problem.fp),
    ["fp-slskd"],
  );

  await withKey("/logs/fresh", { method: "DELETE" });
  const restored = await (await withKey("/logs/problems")).json();
  assert.equal(restored.freshSince, null);
  assert.deepEqual(restored.problems.map((problem: { fp: string }) => problem.fp).sort(), [
    "fp-503",
    "fp-slskd",
  ]);
});

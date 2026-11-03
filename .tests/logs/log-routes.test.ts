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

test("failed integration calls are saved without their query string", async () => {
  logOutgoingFailures();
  const lidarr = await createMockHttpServer((_request, response) => {
    response.writeHead(503).end("busy");
  });
  try {
    await assert.rejects(axios.get(`${lidarr.url}/api/v1/album?apikey=hunter2`));
  } finally {
    await lidarr.close();
  }

  const saved = reported.at(-1);
  assert.partialDeepStrictEqual(saved, {
    level: "warn",
    cat: "http",
    msg: `GET ${new URL(lidarr.url).host} returned 503`,
    data: { path: "/api/v1/album" },
  });
  assert.doesNotMatch(JSON.stringify(saved), /hunter2/);
});

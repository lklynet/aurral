import { requireFixture } from "../playlists/fixtures.ts";
import assert from "node:assert/strict";
import { EventEmitter, on } from "node:events";
import http from "node:http";
import path from "node:path";
import { test, beforeAll, afterAll } from "vite-plus/test";

import bcrypt from "bcrypt";

import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
  startServerProcess,
} from "../helpers/backendTestHarness.ts";

const [isolatedState, { db }, { dbOps, userOps }] = await setupIsolatedBackend(
  "navidrome-settings-api",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
);

let aurral: {
  child: import("node:child_process").ChildProcessByStdio<
    null,
    import("node:stream").Readable,
    import("node:stream").Readable
  >;
  port: number;
  logs: () => string;
  stop(): Promise<void>;
};
let authToken: string;
let navidrome: http.Server<typeof http.IncomingMessage, typeof http.ServerResponse>;
let navidromeUrl: string;
type NavidromeRequest = {
  method: string | undefined;
  url: URL;
  body: Record<string, unknown> | null;
};
const navidromeRequests: NavidromeRequest[] = [];
const navidromeEvents = new EventEmitter();

async function apiFetch(path: string, options: RequestInit = {}) {
  const response = await fetch(`http://127.0.0.1:${aurral.port}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${authToken}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let payload: ReturnType<typeof dbOps.getSettings> | string | null = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  return { response, payload };
}

async function waitForNavidromeRequest(startIndex: number, method: string, pathname: string) {
  const matches = (request: NavidromeRequest) =>
    request.method === method && request.url.pathname === pathname;
  const seen = navidromeRequests.slice(startIndex).find(matches);
  if (seen) return seen;
  const signal = AbortSignal.timeout(5000);
  for await (const [request] of on(navidromeEvents, "request", { signal })) {
    if (matches(request)) return request;
  }
}

beforeAll(async () => {
  resetDatabase(db);
  dbOps.updateSettings({ integrations: {}, onboardingComplete: true });
  userOps.createUser("admin", bcrypt.hashSync("password123", 4), "admin");

  const libraries: { id: string; name?: string; path?: string }[] = [];
  navidrome = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    let requestBody = "";
    req.on("data", (chunk) => {
      requestBody += chunk;
    });
    req.on("end", () => {
      let body: Record<string, unknown> | null = null;
      try {
        body = requestBody ? JSON.parse(requestBody) : null;
      } catch {}
      const request = { method: req.method, url, body };
      navidromeRequests.push(request);
      navidromeEvents.emit("request", request);
      res.writeHead(200, { "Content-Type": "application/json" });
      if (url.pathname === "/auth/login") {
        res.end(JSON.stringify({ token: "test-token" }));
        return;
      }
      if (url.pathname === "/api/library" && req.method === "GET") {
        res.end(JSON.stringify(libraries));
        return;
      }
      if (url.pathname === "/api/library" && req.method === "POST") {
        const library = { id: `library-${libraries.length + 1}`, ...body };
        libraries.push(library);
        res.end(JSON.stringify(library));
        return;
      }
      res.end(JSON.stringify({ "subsonic-response": { status: "ok", version: "1.16.1" } }));
    });
  });
  await new Promise<void>((resolve) => navidrome.listen(0, "127.0.0.1", resolve));
  const address = navidrome.address();
  assert.ok(address && typeof address === "object");
  navidromeUrl = `http://127.0.0.1:${address.port}`;

  aurral = await startServerProcess();
  const login = await fetch(`http://127.0.0.1:${aurral.port}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "password123" }),
  });
  authToken = (await login.json()).token;
  assert.equal(login.status, 200);
});

afterAll(async () => {
  await aurral?.stop();
  await new Promise<void>((resolve) => navidrome?.close(() => resolve()));
  await cleanupIsolatedState(isolatedState);
});

test("admin can update and test Navidrome after onboarding", async () => {
  const credentials = {
    url: navidromeUrl,
    username: "local-user",
    password: "local-password",
  };
  const requestStartIndex = navidromeRequests.length;
  const libraryMapping = {
    source: "navidrome",
    remote: "/music-aurral",
    local: path.join(isolatedState.baseDir, "weekly-flow"),
  };
  const saved = await apiFetch("/api/settings", {
    method: "POST",
    body: JSON.stringify({
      pathMappings: [
        { ...libraryMapping, source: "lidarr", remote: "/unrelated-library" },
        libraryMapping,
      ],
      integrations: {
        navidrome: {
          ...credentials,
          m3uPathMode: "remote",
          pathMappings: [{ local: "/aurral", remote: "/music" }],
        },
      },
    }),
  });
  assert.equal(saved.response.status, 200, JSON.stringify(saved.payload));
  assert.ok(saved.payload && typeof saved.payload === "object");
  assert.equal(requireFixture(saved.payload.integrations.navidrome).url, navidromeUrl);
  assert.equal(requireFixture(saved.payload.integrations.navidrome).username, "local-user");
  assert.equal(
    Object.hasOwn(requireFixture(saved.payload.integrations.navidrome), "m3uPathMode"),
    false,
  );
  assert.equal(
    Object.hasOwn(requireFixture(saved.payload.integrations.navidrome), "pathMappings"),
    false,
  );
  assert.ok(
    saved.payload.pathMappings.some(
      (mapping) =>
        mapping.source === libraryMapping.source &&
        mapping.remote === libraryMapping.remote &&
        mapping.local === libraryMapping.local,
    ),
  );
  const libraryRequest = await waitForNavidromeRequest(requestStartIndex, "POST", "/api/library");
  await waitForNavidromeRequest(requestStartIndex, "GET", "/api/library");
  assert.deepEqual(libraryRequest?.body, {
    name: "Aurral Playlists",
    path: "/music-aurral",
  });

  const tested = await apiFetch("/api/settings/navidrome/test", {
    method: "POST",
    body: JSON.stringify(credentials),
  });
  assert.equal(tested.response.status, 200, JSON.stringify(tested.payload));
  assert.deepEqual(tested.payload, {
    success: true,
    message: "Connection successful",
  });
  const pingRequests = navidromeRequests.filter(({ url }) => url.pathname === "/rest/ping");
  assert.equal(pingRequests.length, 1);
  assert.equal(pingRequests[0].url.searchParams.get("u"), "local-user");
});

test("admin can configure persistent yt-dlp staging outside the download folder", async () => {
  const current = await apiFetch("/api/settings");
  assert.equal(current.response.status, 200, JSON.stringify(current.payload));
  assert.ok(current.payload && typeof current.payload === "object");
  assert.equal(
    requireFixture(current.payload.integrations.ytdlp).stagingPath,
    path.join(isolatedState.dataDir, "_staging"),
  );

  const stagingPath = path.join(isolatedState.baseDir, "mounted-staging");
  const saved = await apiFetch("/api/settings", {
    method: "POST",
    body: JSON.stringify({ integrations: { ytdlp: { stagingPath } } }),
  });
  assert.equal(saved.response.status, 200, JSON.stringify(saved.payload));
  assert.ok(saved.payload && typeof saved.payload === "object");
  assert.equal(requireFixture(saved.payload.integrations.ytdlp).stagingPath, stagingPath);
});

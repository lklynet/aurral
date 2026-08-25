import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import test from "node:test";

import bcrypt from "bcrypt";

import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
  startServerProcess,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { db }, { dbOps, userOps }] = await setupIsolatedBackend(
  "navidrome-settings-api",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
);

let aurral;
let authToken;
let navidrome;
let navidromeUrl;
const navidromeRequests = [];

async function apiFetch(path, options = {}) {
  const response = await fetch(`http://127.0.0.1:${aurral.port}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${authToken}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  return { response, payload };
}

test.before(async () => {
  resetDatabase(db);
  dbOps.updateSettings({ integrations: {}, onboardingComplete: true });
  userOps.createUser("admin", bcrypt.hashSync("password123", 4), "admin");

  navidrome = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    let requestBody = "";
    req.on("data", (chunk) => {
      requestBody += chunk;
    });
    req.on("end", () => {
      let body = null;
      try {
        body = requestBody ? JSON.parse(requestBody) : null;
      } catch {}
      navidromeRequests.push({ method: req.method, url, body });
      res.writeHead(200, { "Content-Type": "application/json" });
      if (url.pathname === "/auth/login") {
        res.end(JSON.stringify({ token: "test-token" }));
        return;
      }
      if (url.pathname === "/api/library" && req.method === "GET") {
        res.end(JSON.stringify([]));
        return;
      }
      if (url.pathname === "/api/library" && req.method === "POST") {
        res.end(JSON.stringify({ id: "library-1", ...body }));
        return;
      }
      res.end(JSON.stringify({ "subsonic-response": { status: "ok", version: "1.16.1" } }));
    });
  });
  await new Promise((resolve) => navidrome.listen(0, "127.0.0.1", resolve));
  navidromeUrl = `http://127.0.0.1:${navidrome.address().port}`;

  aurral = await startServerProcess();
  const login = await fetch(`http://127.0.0.1:${aurral.port}/api/auth/sign-in/username`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "password123" }),
  });
  authToken = login.headers.get("set-auth-token");
  assert.equal(login.status, 200);
});

test.after(async () => {
  await aurral?.stop();
  await new Promise((resolve) => navidrome?.close(resolve));
  await cleanupIsolatedState(isolatedState);
});

test("admin can update and test Navidrome after onboarding", async () => {
  const credentials = {
    url: navidromeUrl,
    username: "local-user",
    password: "local-password",
  };
  const saved = await apiFetch("/api/settings", {
    method: "POST",
    body: JSON.stringify({
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
  assert.equal(saved.payload.integrations.navidrome.url, navidromeUrl);
  assert.equal(saved.payload.integrations.navidrome.username, "local-user");
  assert.equal(Object.hasOwn(saved.payload.integrations.navidrome, "m3uPathMode"), false);
  assert.equal(Object.hasOwn(saved.payload.integrations.navidrome, "pathMappings"), false);
  const libraryRequest = navidromeRequests.find(
    ({ method, url }) => method === "POST" && url.pathname === "/api/library",
  );
  assert.deepEqual(libraryRequest?.body, {
    name: "Aurral Playlists",
    path: path.join(isolatedState.baseDir, "weekly-flow"),
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
  assert.equal(
    current.payload.integrations.ytdlp.stagingPath,
    path.join(isolatedState.dataDir, "_staging"),
  );

  const stagingPath = path.join(isolatedState.baseDir, "mounted-staging");
  const saved = await apiFetch("/api/settings", {
    method: "POST",
    body: JSON.stringify({ integrations: { ytdlp: { stagingPath } } }),
  });
  assert.equal(saved.response.status, 200, JSON.stringify(saved.payload));
  assert.equal(saved.payload.integrations.ytdlp.stagingPath, stagingPath);
});

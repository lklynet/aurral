import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
  startServerProcess,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { db }, { dbOps, userOps }, { hashPassword }] =
  await setupIsolatedBackend(
    "subsonic-contract",
    "backend/config/db-sqlite.js",
    "backend/db/helpers/index.js",
    "backend/middleware/passwordHash.js",
  );

let aurral;

function subsonicUrl(method, params = {}) {
  const query = new URLSearchParams({
    u: "alice",
    p: "password123",
    v: "1.16.1",
    c: "contract-test",
    ...params,
  });
  return `http://127.0.0.1:${aurral.port}/rest/${method}.view?${query}`;
}

async function request(method, params) {
  const response = await fetch(subsonicUrl(method, params));
  const contentType = response.headers.get("content-type") || "";
  const body = await response.text();
  return {
    response,
    contentType,
    body,
    json: contentType.includes("json") ? JSON.parse(body)["subsonic-response"] : null,
  };
}

test.before(async () => {
  resetDatabase(db);
  dbOps.updateSettings({ integrations: {}, onboardingComplete: true });
  userOps.createUser("alice", hashPassword("password123"), "user");
  aurral = await startServerProcess();
});

test.after(async () => {
  await aurral?.stop();
  await cleanupIsolatedState(isolatedState);
});

test("authenticates an Aurral user and returns JSON or XML envelopes", async () => {
  const json = await request("ping", { f: "json" });
  assert.equal(json.response.status, 200);
  assert.equal(json.json.status, "ok");
  assert.equal(json.json.version, "1.16.1");
  assert.equal(json.json.type, "Aurral");
  assert.equal(typeof json.json.serverVersion, "string");
  assert.equal(Object.hasOwn(json.json, "error"), false);

  const encoded = await request("ping", {
    p: `enc:${Buffer.from("password123").toString("hex")}`,
    f: "json",
  });
  assert.equal(encoded.json.status, "ok");

  const xml = await request("ping");
  assert.equal(xml.response.status, 200);
  assert.match(xml.contentType, /application\/xml/);
  assert.match(xml.body, /<subsonic-response[^>]+status="ok"/);
  assert.match(xml.body, /xmlns="http:\/\/subsonic\.org\/restapi"/);
});

test("returns the Subsonic invalid-credentials error", async () => {
  const result = await request("ping", { p: "wrong-password", f: "json" });
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.json.error, {
    code: 40,
    message: "Wrong username or password",
  });
  assert.equal(result.json.status, "failed");
});

test("returns protocol errors for unsupported authentication and requests", async () => {
  const token = await request("ping", { p: "", t: "token", s: "salt", f: "json" });
  assert.equal(token.json.error.code, 41);

  const unsupported = await request("getArtists", { f: "json" });
  assert.deepEqual(unsupported.json.error, {
    code: 0,
    message: "Unsupported request: getartists",
  });

  const unsupportedFormat = await request("ping", { f: "jsonp" });
  assert.match(unsupportedFormat.contentType, /application\/xml/);
  assert.match(unsupportedFormat.body, /code="0"/);
});

test("keeps the Subsonic contract after a process restart", async () => {
  await aurral.stop();
  aurral = await startServerProcess();
  const result = await request("ping", { f: "json" });
  assert.equal(result.json.status, "ok");
});

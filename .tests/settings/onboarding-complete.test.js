import assert from "node:assert/strict";
import test from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import express from "express";
import {
  cleanupIsolatedState,
  createMockHttpServer,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { db }, { dbOps, userOps }, { default: onboardingRouter }] =
  await setupIsolatedBackend(
    "onboarding-complete",
    "backend/config/db-sqlite.js",
    "backend/db/helpers/index.js",
    "backend/routes/onboarding.js",
  );

const lidarrRequests = [];
const lidarr = await createMockHttpServer((req, res) => {
  lidarrRequests.push(req.url);
  res.setHeader("content-type", "application/json");
  if (req.url.startsWith("/api/v1/qualityprofile")) {
    return res.end(JSON.stringify([{ id: 7, name: "Lossless" }]));
  }
  if (req.url.startsWith("/api/v1/metadataprofile")) {
    return res.end(JSON.stringify([{ id: 3, name: "Standard" }]));
  }
  res.end("[]");
});

const app = express();
app.use(express.json());
app.use("/api/onboarding", onboardingRouter);
const server = await new Promise((resolve) => {
  const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
});
const baseUrl = `http://127.0.0.1:${server.address().port}`;

const admin = { authUser: "owner", authPassword: "Correct-Horse-42!" };

async function complete(body) {
  const response = await fetch(`${baseUrl}/api/onboarding/complete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test.beforeEach(() => {
  resetDatabase(db);
  dbOps.updateSettings({ onboardingComplete: false });
  lidarrRequests.length = 0;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await lidarr.close();
  db.close();
  await cleanupIsolatedState(isolatedState);
});

test("completes onboarding without Lidarr and stores no Lidarr settings", async () => {
  const result = await complete({ ...admin, security: { localNetworkBypass: { enabled: false } } });

  assert.equal(result.status, 200);
  const settings = dbOps.getSettings();
  assert.equal(settings.onboardingComplete, true);
  assert.equal(settings.integrations?.lidarr?.url || "", "");
  assert.equal(settings.integrations?.lidarr?.apiKey || "", "");
  assert.notEqual(settings.integrations?.lidarr?.enabled, true);
  assert.deepEqual(userOps.getAllUsers().map((user) => [user.username, user.role]), [["owner", "admin"]]);
  assert.deepEqual(lidarrRequests, []);
});

test("stores the Aurral download folder when onboarding without Lidarr", async () => {
  const downloadFolderPath = join(isolatedState.baseDir, "aurral-library");

  const result = await complete({ ...admin, lidarr: null, downloadFolderPath });

  assert.equal(result.status, 200);
  assert.equal(dbOps.getSettings().downloadFolderPath, downloadFolderPath);
});

test("rejects an invalid download folder and leaves onboarding open", async () => {
  const notAFolder = join(isolatedState.baseDir, "not-a-folder");
  await writeFile(notAFolder, "");

  const result = await complete({ ...admin, downloadFolderPath: notAFolder });

  assert.equal(result.status, 400);
  assert.notEqual(dbOps.getSettings().onboardingComplete, true);
  assert.deepEqual(userOps.getAllUsers(), []);
});

test("rejects a partial Lidarr connection and stores nothing", async () => {
  const result = await complete({ ...admin, lidarr: { url: lidarr.url } });

  assert.equal(result.status, 400);
  const settings = dbOps.getSettings();
  assert.notEqual(settings.onboardingComplete, true);
  assert.equal(settings.integrations?.lidarr?.url || "", "");
  assert.deepEqual(userOps.getAllUsers(), []);
});

test("connected onboarding stores Lidarr and picks its first profiles", async () => {
  const result = await complete({
    ...admin,
    lidarr: { url: `${lidarr.url}/`, apiKey: " key ", defaultMonitorOption: "none", searchOnAdd: false },
  });

  assert.equal(result.status, 200);
  const stored = dbOps.getSettings().integrations.lidarr;
  assert.equal(stored.url, lidarr.url);
  assert.equal(stored.apiKey, "key");
  assert.equal(stored.qualityProfileId, 7);
  assert.equal(stored.metadataProfileId, 3);
});

for (const [name, body] of [
  ["without Lidarr", admin],
  ["with Lidarr", { ...admin, lidarr: { url: "http://lidarr.invalid", apiKey: "key", qualityProfileId: 1, metadataProfileId: 1 } }],
]) {
  test(`refuses onboarding ${name} after setup is complete`, async () => {
    dbOps.updateSettings({ ...dbOps.getSettings(), onboardingComplete: true });

    const result = await complete(body);

    assert.equal(result.status, 403);
    assert.deepEqual(userOps.getAllUsers(), []);
  });
}

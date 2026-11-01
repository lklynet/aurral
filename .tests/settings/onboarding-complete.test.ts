import assert from "node:assert/strict";
import { test, beforeEach, afterAll } from "vite-plus/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { signedInAs } from "../helpers/honoApp.ts";
import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.ts";

const [isolatedState, { db }, { dbOps, userOps }, { api }, { readOnlyFolderPaths }] =
  await setupIsolatedBackend(
    "onboarding-complete",
    () => import("../../backend/config/db-sqlite.ts"),
    () => import("../../backend/db/helpers/index.ts"),
    () => import("../../backend/routes/api.ts"),
    () => import("../../backend/services/libraryFolders.ts"),
  );

const app = signedInAs(undefined).route("/", api);

const admin = { authUser: "owner", authPassword: "Correct-Horse-42!" };

async function complete(body: unknown) {
  const response = await app.request("/onboarding/complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

beforeEach(() => {
  resetDatabase(db);
  dbOps.updateSettings({ onboardingComplete: false });
});

afterAll(async () => {
  db.close();
  await cleanupIsolatedState(isolatedState);
});

test("creates the admin, stores the Library folder, and signs the admin in", async () => {
  const downloadFolderPath = join(isolatedState.baseDir, "aurral-library");

  const result = await complete({ ...admin, downloadFolderPath });

  assert.equal(result.status, 200);
  assert.equal(typeof result.body.token, "string");
  const settings = dbOps.getSettings();
  assert.equal(settings.onboardingComplete, true);
  assert.equal(settings.downloadFolderPath, downloadFolderPath);
  assert.equal(settings.integrations?.lidarr?.url || "", "");
  assert.deepEqual(
    userOps.getAllUsers().map((user) => [user.username, user.role]),
    [["owner", "admin"]],
  );
});

test("reads existing music in place", async () => {
  const music = join(isolatedState.baseDir, "existing-music");
  await mkdir(music, { recursive: true });

  const result = await complete({
    ...admin,
    downloadFolderPath: join(isolatedState.baseDir, "aurral-library"),
    existingMusic: { path: music, mode: "read-in-place" },
  });

  assert.equal(result.status, 200);
  assert.deepEqual(readOnlyFolderPaths(), [music]);
});

for (const [name, body] of [
  ["Library folder", { downloadFolderPath: "not-a-folder" }],
  ["existing music folder", { existingMusic: { path: "/missing/music", mode: "read-in-place" } }],
] as const) {
  test(`rejects an invalid ${name} and leaves onboarding open`, async () => {
    const notAFolder = join(isolatedState.baseDir, "not-a-folder");
    await writeFile(notAFolder, "");

    const result = await complete({
      ...admin,
      ...body,
      ...("downloadFolderPath" in body ? { downloadFolderPath: notAFolder } : {}),
    });

    assert.equal(result.status, 400);
    assert.notEqual(dbOps.getSettings().onboardingComplete, true);
    assert.deepEqual(userOps.getAllUsers(), []);
  });
}

test("refuses onboarding after setup is complete", async () => {
  dbOps.updateSettings({ ...dbOps.getSettings(), onboardingComplete: true });

  const result = await complete(admin);

  assert.equal(result.status, 403);
  assert.deepEqual(userOps.getAllUsers(), []);
});

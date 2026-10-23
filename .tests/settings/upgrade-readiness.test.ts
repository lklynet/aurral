import { requireFixture } from "../playlists/fixtures.ts";
import { createRouteHarness, createResponse } from "../library/routeHarness.ts";
import assert from "node:assert/strict";
import path from "node:path";
import { test, beforeEach, afterAll } from "vite-plus/test";

import { cleanupIsolatedState, setupIsolatedBackend } from "../helpers/backendTestHarness.ts";

const [
  isolatedState,
  { db },
  { dbOps, userOps },
  { registerUpgradeReadiness },
  honkerDb,
  { resolveDownloadRoot },
  { noteDeprecatedUsage },
] = await setupIsolatedBackend(
  "upgrade-readiness",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/routes/settings/handlers/upgradeReadiness.ts"),
  () => import("../../backend/services/honkerDb.ts"),
  () => import("../../backend/services/downloadPaths.ts"),
  () => import("../../backend/services/deprecatedUsage.ts"),
);

type Readiness = ReturnType<
  typeof import("../../backend/services/upgradeReadiness.ts").checkUpgradeReadiness
>;
const routes = createRouteHarness(registerUpgradeReadiness);

async function call(route: string) {
  const response = createResponse<Readiness & { queued?: boolean }>();
  await routes.get(route)({}, response);
  return response;
}

const root = () => path.resolve(resolveDownloadRoot());
const blockerKinds = (body: Readiness) => body.blockers.map((blocker) => blocker.kind);

function finishMigrations() {
  dbOps.setJSONSetting(honkerDb.STORED_DATA_MIGRATION_SETTING, {
    version: honkerDb.STORED_DATA_MIGRATION_VERSION,
  });
  dbOps.setJSONSetting(honkerDb.IDENTITY_MARKER_MIGRATION_SETTING, {
    version: honkerDb.IDENTITY_MARKER_MIGRATION_VERSION,
  });
  dbOps.setJSONSetting(honkerDb.PLAYLIST_STARTUP_MIGRATION_SETTING, {
    version: honkerDb.PLAYLIST_STARTUP_MIGRATION_VERSION,
    rootPath: root(),
  });
  dbOps.setJSONSetting("aurralDownloadFolderMigration", {
    rootPath: root(),
    status: "complete",
    items: {},
  });
}

const queuedKinds = () =>
  honkerDb
    .getHonkerDb()
    .query("SELECT payload FROM _honker_live ORDER BY id")
    .map((row) => JSON.parse(row.payload).kind);

beforeEach(() => {
  for (const key of [
    honkerDb.STORED_DATA_MIGRATION_SETTING,
    honkerDb.IDENTITY_MARKER_MIGRATION_SETTING,
    honkerDb.PLAYLIST_STARTUP_MIGRATION_SETTING,
    "aurralDownloadFolderMigration",
    "aurral3Readiness",
  ]) {
    dbOps.setJSONSetting(key, null);
  }
  db.prepare("DELETE FROM users").run();
  userOps.createUser("admin", "hash", "admin", null);
  const tx = honkerDb.getHonkerDb().transaction();
  tx.execute("DELETE FROM _honker_live");
  tx.commit();
});

afterAll(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("an install that has not finished the 2.x updates is not ready", async () => {
  const response = await call("GET /upgrade-readiness");

  assert.ok(response.body != null);
  assert.equal(response.body.ready, false);
  assert.deepEqual(blockerKinds(response.body), [
    "stored-data",
    "identity-markers",
    "download-folder",
  ]);
  assert.ok(response.body != null);
  assert.ok(response.body.blockers.every((blocker) => blocker.message));
  assert.deepEqual(
    requireFixture(dbOps.getJSONSetting<Readiness>("aurral3Readiness")).blockers,
    blockerKinds(response.body),
  );
  assert.equal(requireFixture(dbOps.getJSONSetting<Readiness>("aurral3Readiness")).ready, false);
});

test("files waiting for review block readiness and are listed relative to the Downloads Folder", async () => {
  finishMigrations();
  const retained = path.join(
    root(),
    "aurral-weekly-flow",
    "playlist",
    "Artist",
    "Album",
    "Partial.flac.part",
  );
  dbOps.setJSONSetting("aurralDownloadFolderMigration", {
    rootPath: root(),
    status: "needs-review",
    items: {
      [retained]: { status: "retained", reason: "partial file" },
      [path.join(root(), "done.flac")]: { status: "complete" },
    },
  });

  const response = await call("GET /upgrade-readiness");

  assert.deepEqual(blockerKinds(response.body), ["download-folder-review"]);
  assert.ok(response.body != null);
  const [blocker] = response.body.blockers;
  assert.ok(blocker.kind === "download-folder-review");
  assert.deepEqual(blocker.items, [
    {
      path: path.join("aurral-weekly-flow", "playlist", "Artist", "Album", "Partial.flac.part"),
      reason: "partial file",
    },
  ]);
  assert.equal(blocker.totalItems, 1);
});

test("an old single password without accounts blocks readiness", async () => {
  finishMigrations();
  db.prepare("DELETE FROM users").run();
  dbOps.updateSettings({
    integrations: { general: { authUser: "owner", authPassword: "secret" } },
  });

  const response = await call("GET /upgrade-readiness");

  assert.deepEqual(blockerKinds(response.body), ["single-password"]);
  dbOps.updateSettings({ integrations: {} });
});

test("a finished install is stamped ready and still lists what it uses that 3.0 removes", async () => {
  finishMigrations();
  noteDeprecatedUsage("weekly-flow-channel");

  const response = await call("GET /upgrade-readiness");

  assert.ok(response.body != null);
  assert.equal(response.body.ready, true);
  assert.ok(response.body != null);
  assert.deepEqual([...response.body.blockers], []);
  assert.ok(response.body != null);
  assert.ok(response.body.warnings.some((warning) => warning.kind === "weekly-flow-channel"));
  assert.equal(requireFixture(dbOps.getJSONSetting<Readiness>("aurral3Readiness")).ready, true);
});

test("checking again queues the tasks for the remaining blockers once", async () => {
  finishMigrations();
  dbOps.setJSONSetting(honkerDb.IDENTITY_MARKER_MIGRATION_SETTING, null);
  dbOps.setJSONSetting("aurralDownloadFolderMigration", {
    rootPath: root(),
    status: "needs-review",
    items: {},
  });

  const first = await call("POST /upgrade-readiness/recheck");
  await call("POST /upgrade-readiness/recheck");

  assert.equal(first.statusCode, 202);
  assert.deepEqual(queuedKinds().sort(), [
    "identity-marker-migration",
    "playlist-startup-migration",
    "upgrade-readiness-check",
  ]);
});

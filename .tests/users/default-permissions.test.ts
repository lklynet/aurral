import { test, beforeEach, afterAll } from "vite-plus/test";
import assert from "node:assert/strict";

import { setupIsolatedBackend, cleanupIsolatedState } from "../helpers/backendTestHarness.ts";

const [isolatedState, { db }, { userOps, dbOps }, { createSystemProvisionedUser }] =
  await setupIsolatedBackend(
    "default-permissions",
    () => import("../../backend/config/db-sqlite.ts"),
    () => import("../../backend/db/helpers/index.ts"),
    () => import("../../backend/middleware/auth.ts"),
  );

const setDefaults = (defaultPermissions: Record<string, boolean>) =>
  dbOps.updateSettings({
    security: { localNetworkBypass: { enabled: false }, defaultPermissions },
  });

beforeEach(() => {
  db.prepare("DELETE FROM users").run();
  dbOps.updateSettings({ security: { localNetworkBypass: { enabled: false } } });
});

afterAll(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("new accounts start from the admin's default permissions", () => {
  setDefaults({ accessFlow: true, addAlbum: false });

  const sso = createSystemProvisionedUser("sso-user", "user");
  assert.equal(sso?.permissions.accessFlow, true);
  assert.equal(sso?.permissions.addAlbum, false);
  assert.equal(sso?.permissions.addArtist, true);

  const chosen = userOps.createUser("chosen", "hash", "user", { accessFlow: false });
  assert.equal(chosen?.permissions.accessFlow, false);
  assert.equal(chosen?.permissions.addAlbum, false);
});

test("changing the defaults leaves existing users alone", () => {
  const existing = userOps.createUser("existing", "hash");
  assert.ok(existing);

  setDefaults({ accessFlow: true, deleteTrack: true });

  const stored = userOps.getUserById(existing.id);
  assert.equal(stored?.permissions.accessFlow, false);
  assert.equal(stored?.permissions.deleteTrack, false);
});

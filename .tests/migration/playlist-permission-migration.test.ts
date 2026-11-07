import { test, afterAll } from "vite-plus/test";
import assert from "node:assert/strict";
import { cleanupIsolatedState, setupIsolatedBackend } from "../helpers/backendTestHarness.ts";

const [state, { db }, { userOps }, { dbOps }, { renamePlaylistPermission }] =
  await setupIsolatedBackend(
    "playlist-permission-migration",
    () => import("../../backend/config/db-sqlite.ts"),
    () => import("../../backend/db/helpers/users.ts"),
    () => import("../../backend/db/helpers/index.ts"),
    () => import("../../backend/config/playlist-permission-migration.ts"),
  );
afterAll(() => cleanupIsolatedState(state));

test("accessFlow becomes accessPlaylists in stored users and default permissions", () => {
  const setPermissions = db.prepare<[string, number]>(
    "UPDATE users SET permissions = ? WHERE id = ?",
  );
  const stored = [
    { accessFlow: true, addAlbum: false },
    { accessFlow: false },
    { accessFlow: "true" },
    { accessPlaylists: true, accessFlow: false },
  ].map((permissions, index) => {
    const user = userOps.createUser(`member-${index}`, "hash", "user");
    assert.ok(user != null);
    setPermissions.run(JSON.stringify(permissions), user.id);
    return user.id;
  });
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('security', ?)").run(
    JSON.stringify({ defaultPermissions: { accessFlow: true, addArtist: false } }),
  );

  renamePlaylistPermission(db);
  renamePlaylistPermission(db);
  dbOps.invalidateSettingsCache();

  assert.deepEqual(
    stored.map((id) => userOps.getUserById(id)?.permissions),
    [
      { accessPlaylists: true, addAlbum: false },
      { accessPlaylists: false },
      { accessPlaylists: false },
      { accessPlaylists: true },
    ],
  );
  assert.deepEqual(dbOps.getSettings().security.defaultPermissions, {
    accessPlaylists: true,
    addArtist: false,
  });
});

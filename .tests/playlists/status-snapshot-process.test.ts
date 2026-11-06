import { requireFixture } from "./fixtures.ts";
import { test, afterAll } from "vite-plus/test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { setupIsolatedBackend, cleanupIsolatedState } from "../helpers/backendTestHarness.ts";

const [
  state,
  { db },
  { dbOps },
  { flowPlaylistConfig },
  { downloadTracker },
  { getPlaylistStatusSnapshot, getPlaylistsContainingTrack },
] = await setupIsolatedBackend(
  "status-snapshot-process",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/services/playlists/flowPlaylistConfig.ts"),
  () => import("../../backend/services/downloadJobs/downloadTracker.ts"),
  () => import("../../backend/services/playlists/playlistStatusSnapshot.ts"),
);

afterAll(() => cleanupIsolatedState(state));

function writeFromAnotherProcess(sql: string, parameters: (string | null)[]) {
  const script = `
    import { createRequire } from 'node:module';
    const require = createRequire(new URL('./backend/config/db-sqlite.ts', 'file://' + process.cwd() + '/'));
    const Database = require('better-sqlite3');
    const db = new Database(process.argv[1]);
    db.prepare(process.argv[2]).run(...JSON.parse(process.argv[3]));
    db.close();
  `;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script, state.dbPath, sql, JSON.stringify(parameters)],
    {
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr);
}

test("production snapshots refresh persisted membership and access changes without IPC", () => {
  dbOps.updateSettings({ integrations: {}, flows: [], sharedPlaylists: [] });
  const playlist = flowPlaylistConfig.createStaticPlaylist({ name: "Original", ownerUserId: 1 });
  const jobId = downloadTracker.addJob(
    { artistName: "Artist", trackName: "Original track" },
    playlist.id,
  );
  const previousMode = process.env.NODE_ENV;
  process.env.NODE_ENV = "development";
  try {
    const user = { id: 1, role: "user", username: "test", permissions: {} };
    const read = () => getPlaylistStatusSnapshot({ user });
    const containing = (trackName: string, artistName = "Artist") =>
      getPlaylistsContainingTrack(user, { artistName, trackName });
    const first = read().sharedPlaylists.find((entry) => entry.id === playlist.id);
    assert.ok(first != null);
    assert.equal(first.name, "Original");
    assert.deepEqual(read().sharedPlaylists, read().sharedPlaylists);
    assert.deepEqual(containing("Original track"), [{ id: playlist.id, jobId }]);

    writeFromAnotherProcess(
      "UPDATE playlist_download_jobs SET track_name = ?, status = ? WHERE id = ?",
      ["Changed track", "failed", jobId],
    );
    const updated = read();
    assert.deepEqual(containing("Original track"), []);
    assert.deepEqual(containing("Changed track"), [{ id: playlist.id, jobId }]);
    assert.equal(updated.sharedPlaylistStats[playlist.id]?.failed, 1);

    const stored = JSON.parse(
      requireFixture(
        db
          .prepare<unknown[], { value: import("../../backend/db/rows.ts").SettingsRow["value"] }>(
            "SELECT value FROM settings WHERE key = 'sharedPlaylists'",
          )
          .get(),
      ).value,
    );
    stored[0].name = "Renamed elsewhere";
    stored[0].tracks = [{ artistName: "Manual artist", trackName: "Manual track" }];
    writeFromAnotherProcess("UPDATE settings SET value = ? WHERE key = ?", [
      JSON.stringify(stored),
      "sharedPlaylists",
    ]);
    const renamed = requireFixture(read().sharedPlaylists[0]);
    assert.equal(renamed.name, "Renamed elsewhere");
    assert.deepEqual(containing("Manual track", "Manual artist"), [
      { id: playlist.id, jobId: null },
    ]);

    writeFromAnotherProcess("DELETE FROM playlist_download_jobs WHERE id = ?", [jobId]);
    assert.deepEqual(containing("Changed track"), []);
    assert.deepEqual(containing("Manual track", "Manual artist"), [
      { id: playlist.id, jobId: null },
    ]);

    stored[0].ownerUserId = 2;
    writeFromAnotherProcess("UPDATE settings SET value = ? WHERE key = ?", [
      JSON.stringify(stored),
      "sharedPlaylists",
    ]);
    assert.deepEqual([...read().sharedPlaylists], []);

    writeFromAnotherProcess("UPDATE settings SET value = ? WHERE key = ?", [
      "[]",
      "sharedPlaylists",
    ]);
    assert.deepEqual([...getPlaylistStatusSnapshot().sharedPlaylists], []);
  } finally {
    process.env.NODE_ENV = previousMode;
  }
});

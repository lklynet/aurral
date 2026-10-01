import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { setupIsolatedBackend, cleanupIsolatedState } from "../helpers/backendTestHarness.js";

const [state, { db }, { dbOps }, { flowPlaylistConfig }, { downloadTracker }, { getWeeklyFlowStatusSnapshot }] =
  await setupIsolatedBackend(
    "status-snapshot-process",
    "backend/config/db-sqlite.js",
    "backend/db/helpers/index.js",
    "backend/services/weeklyFlow/weeklyFlowPlaylistConfig.js",
    "backend/services/weeklyFlow/weeklyFlowDownloadTracker.js",
    "backend/services/weeklyFlow/weeklyFlowStatusSnapshot.js",
  );

test.after(() => cleanupIsolatedState(state));

function writeFromAnotherProcess(sql, parameters) {
  const script = `
    import { createRequire } from 'node:module';
    const require = createRequire(new URL('./backend/config/db-sqlite.js', 'file://' + process.cwd() + '/'));
    const Database = require('better-sqlite3');
    const db = new Database(process.argv[1]);
    db.prepare(process.argv[2]).run(...JSON.parse(process.argv[3]));
    db.close();
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script, state.dbPath, sql, JSON.stringify(parameters)], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
}

test("production snapshots refresh persisted membership and access changes without IPC", () => {
  dbOps.updateSettings({ integrations: {}, flows: [], sharedPlaylists: [] });
  const playlist = flowPlaylistConfig.createSharedPlaylist({ name: "Original", ownerUserId: 1 });
  const jobId = downloadTracker.addJob({ artistName: "Artist", trackName: "Original track" }, playlist.id);
  const previousMode = process.env.NODE_ENV;
  process.env.NODE_ENV = "development";
  try {
    const read = () => getWeeklyFlowStatusSnapshot({ user: { id: 1, role: "user" } });
    const first = read().sharedPlaylists.find((entry) => entry.id === playlist.id);
    assert.equal(first.name, "Original");
    assert.equal(first.trackEntries.length, 1);
    assert.deepEqual(read().sharedPlaylists, read().sharedPlaylists);
    first.trackEntries[0].identity = "caller mutation";
    first.trackIdentities.push("caller mutation");
    assert.equal(read().sharedPlaylists[0].trackIdentities.length, 1);
    assert.notEqual(read().sharedPlaylists[0].trackEntries[0].identity, "caller mutation");

    writeFromAnotherProcess("UPDATE playlist_download_jobs SET track_name = ?, status = ? WHERE id = ?", ["Changed track", "failed", jobId]);
    const updated = read();
    assert.notEqual(updated.sharedPlaylists[0].trackIdentities[0], first.trackIdentities[0]);
    assert.equal(updated.sharedPlaylistStats[playlist.id].failed, 1);

    const stored = JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'sharedPlaylists'").get().value);
    stored[0].name = "Renamed elsewhere";
    stored[0].tracks = [{ artistName: "Manual artist", trackName: "Manual track" }];
    writeFromAnotherProcess("UPDATE settings SET value = ? WHERE key = ?", [JSON.stringify(stored), "sharedPlaylists"]);
    const renamed = read().sharedPlaylists[0];
    assert.equal(renamed.name, "Renamed elsewhere");
    assert.equal(renamed.trackIdentities.length, 2);

    writeFromAnotherProcess("DELETE FROM playlist_download_jobs WHERE id = ?", [jobId]);
    assert.equal(read().sharedPlaylists[0].trackIdentities.length, 1);
    assert.deepEqual(read().sharedPlaylists[0].trackEntries, []);

    stored[0].ownerUserId = 2;
    writeFromAnotherProcess("UPDATE settings SET value = ? WHERE key = ?", [JSON.stringify(stored), "sharedPlaylists"]);
    assert.deepEqual(read().sharedPlaylists, []);

    writeFromAnotherProcess("UPDATE settings SET value = ? WHERE key = ?", ["[]", "sharedPlaylists"]);
    assert.deepEqual(getWeeklyFlowStatusSnapshot().sharedPlaylists, []);
  } finally {
    process.env.NODE_ENV = previousMode;
  }
});

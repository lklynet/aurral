import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { setupIsolatedBackend, cleanupIsolatedState } from "../helpers/backendTestHarness.js";
import { addStaticPlaylistJobs } from "../helpers/staticPlaylistJobs.js";

const [state, { db }, { dbOps }, { flowPlaylistConfig }, { downloadTracker }, { getPlaylistStatusSnapshot }] =
  await setupIsolatedBackend(
    "status-snapshot-process",
    "backend/config/db-sqlite.js",
    "backend/db/helpers/index.js",
    "backend/services/playlists/flowPlaylistConfig.js",
    "backend/services/downloadJobs/downloadTracker.js",
    "backend/services/playlists/playlistStatusSnapshot.js",
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
  dbOps.updateSettings({ integrations: {}, flows: [], staticPlaylists: [] });
  const playlist = flowPlaylistConfig.createStaticPlaylist({ name: "Original", ownerUserId: 1 });
  const [jobId] = addStaticPlaylistJobs({ downloadTracker, flowPlaylistConfig }, playlist.id, [
    { artistName: "Artist", trackName: "Original track" },
  ]);
  const previousMode = process.env.NODE_ENV;
  process.env.NODE_ENV = "development";
  try {
    const read = () => getPlaylistStatusSnapshot({ user: { id: 1, role: "user" } });
    const first = read().staticPlaylists.find((entry) => entry.id === playlist.id);
    assert.equal(first.name, "Original");
    assert.equal(first.trackEntries.length, 1);
    assert.deepEqual(read().staticPlaylists, read().staticPlaylists);
    first.trackEntries[0].identity = "caller mutation";
    first.trackIdentities.push("caller mutation");
    assert.equal(read().staticPlaylists[0].trackIdentities.length, 1);
    assert.notEqual(read().staticPlaylists[0].trackEntries[0].identity, "caller mutation");

    writeFromAnotherProcess("UPDATE download_jobs SET track_name = ?, status = ? WHERE id = ?", ["Changed track", "failed", jobId]);
    const updated = read();
    assert.notEqual(updated.staticPlaylists[0].trackIdentities[0], first.trackIdentities[0]);
    assert.equal(updated.staticPlaylistStats[playlist.id].failed, 1);

    const stored = JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'staticPlaylists'").get().value);
    stored[0].name = "Renamed elsewhere";
    stored[0].tracks.push({ artistName: "Manual artist", trackName: "Manual track" });
    writeFromAnotherProcess("UPDATE settings SET value = ? WHERE key = ?", [JSON.stringify(stored), "staticPlaylists"]);
    const renamed = read().staticPlaylists[0];
    assert.equal(renamed.name, "Renamed elsewhere");
    assert.ok(renamed.trackIdentities.some((identity) => identity.includes("manual track")));
    assert.equal(renamed.trackEntries.length, 1);

    writeFromAnotherProcess("DELETE FROM download_jobs WHERE id = ?", [jobId]);
    assert.equal(read().staticPlaylists[0].trackIdentities.some((identity) => identity.includes("changed track")), false);
    assert.deepEqual(read().staticPlaylists[0].trackEntries, []);

    stored[0].ownerUserId = 2;
    writeFromAnotherProcess("UPDATE settings SET value = ? WHERE key = ?", [JSON.stringify(stored), "staticPlaylists"]);
    assert.deepEqual(read().staticPlaylists, []);

    writeFromAnotherProcess("UPDATE settings SET value = ? WHERE key = ?", ["[]", "staticPlaylists"]);
    assert.deepEqual(getPlaylistStatusSnapshot().staticPlaylists, []);
  } finally {
    process.env.NODE_ENV = previousMode;
  }
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, test } from "vite-plus/test";
import {
  applyIsolatedBackendEnv,
  cleanupIsolatedState,
  createIsolatedStateDir,
} from "../helpers/backendTestHarness.ts";

const state = await createIsolatedStateDir("retired-flows");
applyIsolatedBackendEnv(state);
const created = spawnSync(
  process.execPath,
  [
    "--input-type=module",
    "-e",
    'const { db } = await import("./backend/config/db-sqlite.ts"); db.close();',
  ],
  { cwd: new URL("../..", import.meta.url), env: process.env, encoding: "utf8" },
);
assert.equal(created.status, 0, created.stderr);
const due = Date.now() - 60_000;
const raw = new Database(state.dbPath);
raw.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('flows', ?)").run(
  JSON.stringify([
    {
      id: "metal-mayhem",
      name: "Metal Mayhem",
      ownerUserId: 7,
      enabled: true,
      nextRunAt: due,
      scheduleDays: [1],
      type: "editorial",
      tag: "metal",
      discoverPresetId: "top-metal",
    },
    {
      id: "lost-mount",
      name: "Lost Mount",
      enabled: true,
      nextRunAt: due,
      scheduleDays: [1],
      type: "editorial",
    },
    { id: "weekly", name: "Weekly", enabled: true, nextRunAt: due, scheduleDays: [1] },
  ]),
);
raw.prepare("DELETE FROM settings WHERE key = 'migration:retired-flows-v1'").run();
raw.close();

const [{ flowPlaylistConfig }, { downloadTracker }, { playlistManager }, { convertRetiredFlows }] =
  await Promise.all([
    import("../../backend/services/playlists/flowPlaylistConfig.ts"),
    import("../../backend/services/downloadJobs/downloadTracker.ts"),
    import("../../backend/services/playlists/playlistManager.ts"),
    import("../../backend/services/flows/staticPlaylistFromFlow.ts"),
  ]);

afterAll(() => cleanupIsolatedState(state));

test("retired editorial flows stop running and become playlists that keep their tracks", async () => {
  assert.deepEqual(
    flowPlaylistConfig.getDueForRefresh().map((flow) => flow.id),
    ["weekly"],
  );

  const album = path.join(
    playlistManager.downloadRoot,
    "_flows",
    "metal-mayhem",
    "Old Artist",
    "Album",
  );
  await fs.mkdir(album, { recursive: true });
  await fs.writeFile(path.join(album, "Old Song.flac"), "disposable audio");
  for (const trackName of ["Old Song", "Gone Song"]) {
    const jobId = downloadTracker.addJob(
      { artistName: "Old Artist", trackName, albumName: "Album" },
      "metal-mayhem",
    );
    assert.ok(jobId != null);
    downloadTracker.setDone(jobId, path.join(album, `${trackName}.flac`), "Album");
  }
  const unmounted = downloadTracker.addJob(
    { artistName: "Far Artist", trackName: "Far Song" },
    "lost-mount",
  );
  assert.ok(unmounted != null);
  downloadTracker.setDone(unmounted, "/unmounted/Far Song.flac", "Album");
  const interrupted = flowPlaylistConfig.createStaticPlaylist({
    name: "Metal Mayhem",
    sourceFlowId: "metal-mayhem",
    ownerUserId: 7,
    replacesFlowId: "metal-mayhem",
    tracks: [{ artistName: "Old Artist", trackName: "Old Song" }],
  });

  await convertRetiredFlows();

  assert.equal(flowPlaylistConfig.getFlow("metal-mayhem"), null);
  const playlists = flowPlaylistConfig.getStaticPlaylists();
  assert.equal(playlists.length, 1);
  const [playlist] = playlists;
  assert.notEqual(playlist.id, interrupted.id);
  assert.deepEqual(
    [playlist.name, playlist.ownerUserId, playlist.tracks.map((track) => track.trackName)],
    ["Metal Mayhem", 7, ["Old Song"]],
  );
  const [job] = downloadTracker.getByPlaylistId(playlist.id);
  assert.equal(
    job.finalPath,
    path.join(playlistManager.downloadRoot, "Old Artist", "Album", "Old Song.flac"),
  );
  assert.equal(await fs.readFile(String(job.finalPath), "utf8"), "disposable audio");

  assert.equal(flowPlaylistConfig.getFlow("lost-mount")?.enabled, false);
  assert.deepEqual(
    downloadTracker.getByPlaylistId("lost-mount").map((entry) => entry.trackName),
    ["Far Song"],
  );
});

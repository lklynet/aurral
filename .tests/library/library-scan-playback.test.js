import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { setupIsolatedBackend, cleanupIsolatedState, resetDatabase } from "../helpers/backendTestHarness.js";

const previousGroup = process.env.AURRAL_BACKGROUND_WORKER_GROUP;
process.env.AURRAL_BACKGROUND_WORKER_GROUP = "library";
const [state, { db }, { dbOps }, honker, scans, { playlistManager }, { processSystemTask },
  { NavidromeClient }, { PlexClient }, { JellyfinClient }, { getLibrary }] = await setupIsolatedBackend(
  "library-scan-playback", "backend/config/db-sqlite.js", "backend/db/helpers/index.js",
  "backend/services/honkerDb.js", "backend/services/libraryScanWorker.js",
  "backend/services/playlists/playlistManager.js", "backend/services/systemTaskWorker.js",
  "backend/services/navidrome.js", "backend/services/plex.js", "backend/services/jellyfin.js",
  "backend/services/libraryQueryService.js",
);

test.beforeEach(() => {
  resetDatabase(db);
  const tx = honker.getHonkerDb().transaction();
  tx.execute("DELETE FROM _honker_live");
  tx.commit();
  dbOps.updateSettings({ integrations: {
    navidrome: { url: "http://navidrome.test", username: "test", password: "password" },
    plex: { url: "http://plex.test", token: "test-token" },
    jellyfin: { url: "http://jellyfin.test", apiKey: "test-key", userId: "test-user" },
  } });
});

test.after(async () => {
  await scans.stopLibraryScanWorker();
  if (previousGroup === undefined) delete process.env.AURRAL_BACKGROUND_WORKER_GROUP;
  else process.env.AURRAL_BACKGROUND_WORKER_GROUP = previousGroup;
  await cleanupIsolatedState(state);
});

function stubMediaServers(t, { failed = null } = {}) {
  const requests = [];
  for (const [name, Client] of [["Navidrome", NavidromeClient], ["Plex", PlexClient], ["Jellyfin", JellyfinClient]]) {
    t.mock.method(Client.prototype, "request", async () => {
      requests.push(name);
      if (failed === name) throw new Error(`${name} unavailable`);
      return {};
    });
  }
  t.mock.method(PlexClient.prototype, "ensureAurralLibrary", async () => ({ key: "7" }));
  t.mock.method(PlexClient.prototype, "getTracks", async () => []);
  return requests;
}

test("media scan requests coalesce durably and keep changes made during a running scan", () => {
  const first = playlistManager.schedulePlaybackScan();
  assert.ok(first);
  assert.equal(playlistManager.schedulePlaybackScan(), first);
  honker.closeHonkerDb();
  assert.equal(playlistManager.schedulePlaybackScan(), first);
  const tx = honker.getHonkerDb().transaction();
  tx.execute("UPDATE _honker_live SET run_at = 0 WHERE id = ?", [first]);
  tx.commit();
  const active = honker.getSystemTaskQueue().claimOne(honker.getWorkerId());
  assert.equal(active.id, first);
  const followUp = playlistManager.schedulePlaybackScan();
  assert.notEqual(followUp, first);
  assert.equal(playlistManager.schedulePlaybackScan(), followUp);
  active.ack();
  assert.deepEqual(honker.listHonkerJobs("system-task").map((job) => job.id), [followUp]);
  dbOps.updateSettings({ integrations: {} });
  assert.equal(playlistManager.schedulePlaybackScan(), null);
});

test("the queued media scan reports an unavailable service and succeeds after it returns", async (t) => {
  for (const service of ["Navidrome", "Plex", "Jellyfin"]) {
    const failed = stubMediaServers(t, { failed: service });
    await assert.rejects(processSystemTask({ kind: "playback-library-scan" }), new RegExp(`${service} unavailable`));
    assert.deepEqual(failed.sort(), ["Jellyfin", "Navidrome", "Plex"]);
    t.mock.restoreAll();
  }
  const recovered = stubMediaServers(t);
  await processSystemTask({ kind: "playback-library-scan" });
  assert.deepEqual(recovered.sort(), ["Jellyfin", "Navidrome", "Plex"]);
  dbOps.updateSettings({ integrations: {} });
  await processSystemTask({ kind: "playback-library-scan" });
  assert.equal(recovered.length, 3);
});

test("local scans queue media work only for changes and leave explicit rescans available", { timeout: 10000 }, async (t) => {
  const requests = stubMediaServers(t);
  const filePath = path.join(playlistManager.downloadRoot, "Scan Artist", "Album", "Song.wav");
  await mkdir(path.dirname(filePath), { recursive: true });
  const generated = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc",
    "-t", "0.05", "-metadata", "artist=Scan Artist", "-metadata", "album=Album", "-metadata", "title=Song", filePath], { encoding: "utf8" });
  assert.equal(generated.status, 0, generated.stderr);
  const { default: axios } = await import("../../lib/axiosFetch.js");
  t.mock.method(axios, "get", async () => ({ data: [] }));
  const events = honker.getHonkerDb().updateEvents();
  t.after(() => events.close());
  const runScan = async (options) => {
    const id = scans.scheduleLibraryScan({ includeLidarr: false, ...options });
    scans.startLibraryScanWorker();
    while (scans.getLibraryScanStatus(id)?.status !== "completed") {
      assert.notEqual(scans.getLibraryScanStatus(id)?.status, "failed");
      await events.next();
    }
  };
  try {
    await runScan({});
    assert.equal(getLibrary({ availableOnly: true }).tracks.length, 1);
    assert.deepEqual(requests, []);
    const pending = honker.listHonkerJobs("system-task");
    assert.equal(pending.length, 1);
    honker.getSystemTaskQueue().cancel(pending[0].id);
    await runScan({});
    assert.deepEqual(honker.listHonkerJobs("system-task"), []);
    await runScan({ force: true });
    const forced = honker.listHonkerJobs("system-task");
    assert.equal(forced.length, 1);
    honker.getSystemTaskQueue().cancel(forced[0].id);
    const flowFile = path.join(playlistManager.downloadRoot, "_flows", "hidden-flow", "Song.wav");
    await mkdir(path.dirname(flowFile), { recursive: true });
    await writeFile(flowFile, await readFile(filePath));
    await runScan({ changedPaths: [flowFile] });
    assert.equal(honker.listHonkerJobs("system-task").length, 1);
    assert.deepEqual(requests, []);
  } finally {
    await scans.stopLibraryScanWorker();
  }
});

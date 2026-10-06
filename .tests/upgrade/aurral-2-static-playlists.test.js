import test from "node:test";
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import path from "node:path";

import {
  applyIsolatedBackendEnv,
  cleanupIsolatedState,
  createMockHttpServer,
  importFromRepo,
} from "../helpers/backendTestHarness.js";
import { loadAurral2Fixture } from "../helpers/aurral2Fixture.js";

const fixture = loadAurral2Fixture("stamped");
const state = { baseDir: fixture.root, dataDir: fixture.dataDir, dbPath: fixture.dbPath };
applyIsolatedBackendEnv(state);
const [{ dbOps }, { flowPlaylistConfig }, { downloadTracker }, { downloadWorker }, { playlistManager }, { processPlaylistOperation }] =
  await Promise.all([
    "backend/db/helpers/index.js",
    "backend/services/playlists/flowPlaylistConfig.js",
    "backend/services/downloadJobs/downloadTracker.js",
    "backend/services/downloadJobs/downloadWorker.js",
    "backend/services/playlists/playlistManager.js",
    "backend/services/playlists/playlistOperations.js",
  ].map(importFromRepo));

test.after(() => cleanupIsolatedState(state));

const jobsNamed = (trackName) =>
  downloadTracker.getAll().filter((job) => job.trackName === trackName && !job.upgradeForJobId);
const fileExists = (relative) =>
  access(path.join(fixture.downloadRoot, relative)).then(() => true, () => false);

test("deleting a migrated playlist removes what it queued and keeps tracks used elsewhere", async (t) => {
  const slskd = await createMockHttpServer((request, response) => {
    request.resume();
    response.writeHead(204);
    response.end();
  });
  t.after(() => slskd.close());
  const settings = dbOps.getSettings();
  dbOps.updateSettings({
    ...settings,
    integrations: { ...settings.integrations, slskd: { enabled: true, url: slskd.url, apiKey: "test-key" } },
  });
  t.mock.method(downloadWorker, "start", async () => false);
  for (const method of ["updateConfig", "deletePlaybackPlaylist", "cleanupEntityPlexPlaylists", "ensureSmartPlaylists", "refreshPlaylist", "scheduleScanLibrary"]) {
    t.mock.method(playlistManager, method, async () => {});
  }
  const imported = flowPlaylistConfig.getStaticPlaylists().find((playlist) => playlist.name === "Imported");
  const copied = flowPlaylistConfig.getStaticPlaylists().find((playlist) => playlist.name === "Copied");
  const [downloaded] = jobsNamed("Downloaded");
  const libraryDone = jobsNamed("Library Done").map((job) => job.id).sort();

  await processPlaylistOperation({ kind: "static-playlist-delete", playlistId: imported.id });

  assert.equal(flowPlaylistConfig.getStaticPlaylist(imported.id), null);
  for (const name of ["Queued", "Failed", "Only In Jobs"]) assert.deepEqual(jobsNamed(name), [], name);
  assert.equal(await fileExists("Extra Artist/Extra Album/Only In Jobs.flac"), false);

  assert.equal(flowPlaylistConfig.getStaticPlaylist(copied.id).tracks[0].jobId, downloaded.id);
  assert.equal(downloadTracker.getJob(downloaded.id)?.status, "done");
  assert.equal(await fileExists("Imp Artist/Imp Album/Downloaded.flac"), true);
  assert.deepEqual(jobsNamed("Library Done").map((job) => job.id).sort(), libraryDone);
  assert.equal(await fileExists("Lib Artist/Lib Album/Library Done.flac"), true);
});

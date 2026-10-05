import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  importFromRepo,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const [
  isolatedState,
  { db },
  { dbOps },
  downloadPaths,
  { downloadTracker },
  { reuseTrackForPlaylist },
  { flowPlaylistConfig },
  { playlistManager },
] = await setupIsolatedBackend(
  "flows-folder",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
  "backend/services/downloadPaths.js",
  "backend/services/downloadJobs/downloadTracker.js",
  "backend/services/downloadJobs/fileReuse.js",
  "backend/services/playlists/flowPlaylistConfig.js",
  "backend/services/playlists/playlistManager.js",
);
const { buildAurralTrackDestination, resolveFlowsRoot, resolveTrackDestinationDir } = downloadPaths;

const downloadRoot = path.join(isolatedState.baseDir, "media", "aurral");
const flowsRoot = path.join(isolatedState.baseDir, "scratch", "flows");

test.beforeEach(async () => {
  resetDatabase(db);
  downloadTracker.clearAll();
  await fs.rm(path.join(isolatedState.baseDir, "media"), { recursive: true, force: true });
  await fs.rm(path.join(isolatedState.baseDir, "scratch"), { recursive: true, force: true });
  dbOps.updateSettings({
    integrations: {},
    flows: [],
    sharedPlaylists: [],
    onboardingComplete: true,
    downloadFolderPath: downloadRoot,
    flowsFolderPath: "",
  });
});

test.afterEach(() => {
  dbOps.updateSettings({ flowsFolderPath: "" });
});

test.after(async () => {
  const { downloadWorker } = await importFromRepo("backend/services/downloadJobs/downloadWorker.js");
  await downloadWorker.stopAndDrain();
  await cleanupIsolatedState(isolatedState);
});

async function makeFile(file) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "audio");
  return file;
}

test("flows default to _flows inside the Downloads Folder", () => {
  assert.equal(resolveFlowsRoot(downloadRoot), path.join(downloadRoot, "_flows"));
  assert.equal(
    resolveTrackDestinationDir(downloadRoot, buildAurralTrackDestination("flow-1", "Artist", "Album", { ephemeral: true })),
    path.join(downloadRoot, "_flows", "flow-1", "Artist", "Album"),
  );
});

test("a configured flows folder receives flow destinations and nothing else", () => {
  dbOps.updateSettings({ flowsFolderPath: flowsRoot });

  assert.equal(dbOps.getSettings().flowsFolderPath, flowsRoot);
  assert.equal(resolveFlowsRoot(downloadRoot), flowsRoot);
  assert.equal(
    resolveTrackDestinationDir(downloadRoot, buildAurralTrackDestination("flow-1", "Artist", "Album", { ephemeral: true })),
    path.join(flowsRoot, "flow-1", "Artist", "Album"),
  );
  assert.equal(
    resolveTrackDestinationDir(downloadRoot, buildAurralTrackDestination("library", "Artist", "Album")),
    path.join(downloadRoot, "Artist", "Album"),
  );
  assert.throws(() => resolveTrackDestinationDir(downloadRoot, "_flows/../../escape"));
});

test("the flows folder cannot be the Downloads Folder or contain it", async () => {
  for (const invalid of [downloadRoot, path.dirname(downloadRoot)]) {
    assert.throws(() => dbOps.updateSettings({ flowsFolderPath: invalid }), /Flows folder/);
    assert.equal(dbOps.getSettings().flowsFolderPath, null);
  }

  const nested = path.join(downloadRoot, "flows");
  dbOps.updateSettings({ flowsFolderPath: nested });
  assert.equal(resolveFlowsRoot(downloadRoot), nested);
  assert.equal((await fs.stat(nested)).isDirectory(), true);
});

test("add to library moves a flow file from an external flows folder and retargets its jobs", async (t) => {
  dbOps.updateSettings({ flowsFolderPath: flowsRoot });
  t.mock.method(playlistManager, "scheduleScanLibrary", () => 1);
  t.mock.method(playlistManager, "refreshPlaylist", async () => null);
  const flow = flowPlaylistConfig.createFlow({ name: "Scratch Flow", size: 10 });
  const track = { artistName: "Burial", trackName: "Archangel", albumName: "Untrue" };
  const source = await makeFile(path.join(flowsRoot, flow.id, "Burial", "Untrue", "Archangel.flac"));
  const flowJobId = downloadTracker.addJob(track, flow.id);
  downloadTracker.setDone(flowJobId, source, track.albumName);

  const result = await reuseTrackForPlaylist(track, "library", { existingFileMode: "reuse", downloadRoot });

  const expected = path.join(downloadRoot, "Burial", "Untrue", "Archangel.flac");
  assert.equal(result.reused, true);
  assert.equal(result.finalPath, expected);
  assert.equal(await fs.readFile(expected, "utf8"), "audio");
  await assert.rejects(fs.access(source), { code: "ENOENT" });
  assert.equal(downloadTracker.getJob(flowJobId)?.finalPath, expected);
  assert.equal(downloadTracker.getJob(result.jobId)?.finalPath, expected);
});

test("a flow reset cleans only that flow inside the configured flows folder", async () => {
  dbOps.updateSettings({ flowsFolderPath: flowsRoot });
  const unused = await makeFile(path.join(flowsRoot, "flow", "Artist", "Album", "unused.flac"));
  const otherFlow = await makeFile(path.join(flowsRoot, "other", "Artist", "Album", "keep.flac"));
  const previousLocation = await makeFile(path.join(downloadRoot, "_flows", "flow", "old.flac"));
  const library = await makeFile(path.join(downloadRoot, "Artist", "Album", "library.flac"));

  await playlistManager.weeklyReset(["flow"], { protectPlayback: false });

  await assert.rejects(fs.access(unused), { code: "ENOENT" });
  await assert.rejects(fs.access(path.join(flowsRoot, "flow")), { code: "ENOENT" });
  await fs.access(otherFlow);
  await fs.access(previousLocation);
  await fs.access(library);
});

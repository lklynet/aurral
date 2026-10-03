import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const [
  isolatedState,
  { db },
  { dbOps },
  { flowPlaylistConfig },
  { scanConfiguredLibrary },
  { getLibrary },
] = await setupIsolatedBackend(
  "flow-library-visibility",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
  "backend/services/playlists/flowPlaylistConfig.js",
  "backend/services/libraryIndexService.js",
  "backend/services/libraryQueryService.js",
);

let root;

test.beforeEach(async () => {
  resetDatabase(db);
  dbOps.updateSettings({ integrations: {}, flows: [], sharedPlaylists: [] });
  root = await mkdtemp(path.join(tmpdir(), "aurral-flow-library-"));
});

test.afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

function silentWav() {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + 8, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8000, 24);
  header.writeUInt32LE(16000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(8, 40);
  return Buffer.concat([header, Buffer.alloc(8)]);
}

async function writeTrack(relativePath) {
  const filePath = path.join(root, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, silentWav());
  return filePath;
}

let jobCounter = 0;
function addDoneJob(playlistId, filePath, trackName) {
  jobCounter += 1;
  db.prepare(
    `INSERT INTO playlist_download_jobs
      (id, artist_name, track_name, album_name, playlist_id, playlist_type, status, final_path, created_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, 'done', ?, ?, ?)`,
  ).run(
    `job-${jobCounter}`,
    "Flow Artist",
    trackName,
    "Flow Album",
    playlistId,
    playlistId,
    filePath,
    Date.now(),
    Date.now(),
  );
  return `job-${jobCounter}`;
}

function createFlow(name, showInLibrary) {
  const flow = flowPlaylistConfig.createFlow({ name, size: 10 });
  return flowPlaylistConfig.updateFlow(flow.id, { showInLibrary });
}

const scan = () => scanConfiguredLibrary({ musicRoot: root, includeLidarr: false });

const libraryTrackTitles = () =>
  getLibrary({ availableOnly: true })
    .tracks.map((track) => track.title)
    .sort();

async function listFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath ?? entry.path, entry.name))
    .sort();
}

test("flow tracks join the library only while their flow opts in", async () => {
  const flow = createFlow("Visible Flow", false);
  const filePath = await writeTrack(`_flows/${flow.id}/Flow Artist - Opt In.wav`);
  addDoneJob(flow.id, filePath, "Opt In");
  const filesBefore = await listFiles(root);

  await scan();
  assert.deepEqual(libraryTrackTitles(), []);

  flowPlaylistConfig.updateFlow(flow.id, { showInLibrary: true });
  await scan();
  assert.deepEqual(libraryTrackTitles(), ["Opt In"]);

  flowPlaylistConfig.updateFlow(flow.id, { showInLibrary: false });
  await scan();
  assert.deepEqual(libraryTrackTitles(), []);
  assert.deepEqual(getLibrary({ availableOnly: false }).tracks, []);

  assert.deepEqual(await listFiles(root), filesBefore);
});

test("tracks that leave an included flow leave the library", async () => {
  const flow = createFlow("Rotating Flow", true);
  const kept = await writeTrack(`_flows/${flow.id}/Flow Artist - Kept.wav`);
  const rotated = await writeTrack(`_flows/${flow.id}/Flow Artist - Rotated.wav`);
  addDoneJob(flow.id, kept, "Kept");
  const rotatedJob = addDoneJob(flow.id, rotated, "Rotated");

  await scan();
  assert.deepEqual(libraryTrackTitles(), ["Kept", "Rotated"]);

  db.prepare("DELETE FROM playlist_download_jobs WHERE id = ?").run(rotatedJob);
  await rm(rotated);
  await scan();
  assert.deepEqual(getLibrary({ availableOnly: false }).tracks.map((t) => t.title), ["Kept"]);

  flowPlaylistConfig.deleteFlow(flow.id);
  await scan();
  assert.deepEqual(getLibrary({ availableOnly: false }).tracks, []);
});

test("a file shared with an excluded flow stays while any included flow owns it", async () => {
  const included = createFlow("Included Flow", true);
  const excluded = createFlow("Excluded Flow", false);
  const shared = await writeTrack(`_flows/${included.id}/Flow Artist - Shared.wav`);
  addDoneJob(included.id, shared, "Shared");
  addDoneJob(excluded.id, shared, "Shared");

  await scan();
  assert.deepEqual(libraryTrackTitles(), ["Shared"]);
});

test("a flow track already in the music library appears once", async () => {
  const flow = createFlow("Duplicate Flow", true);
  const owned = await writeTrack("Flow Artist/Flow Album/Flow Artist - Twice.wav");
  const flowCopy = await writeTrack(`_flows/${flow.id}/Flow Artist - Twice.wav`);
  addDoneJob("library", owned, "Twice");
  addDoneJob(flow.id, flowCopy, "Twice");

  await scan();
  assert.deepEqual(libraryTrackTitles(), ["Twice"]);
  assert.deepEqual(
    getLibrary({ availableOnly: true }).tracks[0].sources,
    ["aurral", "flow"],
  );
});

test("a missing flow file leaves the library once its flow stops including it", async () => {
  const flow = createFlow("Missing File Flow", true);
  const filePath = await writeTrack(`_flows/${flow.id}/Flow Artist - Gone.wav`);
  addDoneJob(flow.id, filePath, "Gone");

  await scan();
  await rm(filePath);
  await scan();
  flowPlaylistConfig.updateFlow(flow.id, { showInLibrary: false });
  await scan();

  assert.deepEqual(getLibrary({ availableOnly: false }).tracks, []);
});

test("flow tracks outside a new download root leave the library", async () => {
  const flow = createFlow("Moved Root Flow", true);
  const filePath = await writeTrack(`_flows/${flow.id}/Flow Artist - Old Root.wav`);
  addDoneJob(flow.id, filePath, "Old Root");
  await scan();
  assert.deepEqual(libraryTrackTitles(), ["Old Root"]);

  const newRoot = await mkdtemp(path.join(tmpdir(), "aurral-flow-library-new-root-"));
  try {
    await scanConfiguredLibrary({ musicRoot: newRoot, includeLidarr: false });
    assert.deepEqual(getLibrary({ availableOnly: false }).tracks, []);
  } finally {
    await rm(newRoot, { recursive: true, force: true });
  }
});

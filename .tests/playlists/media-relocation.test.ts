import { test, afterAll } from "vite-plus/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { setupIsolatedBackend, cleanupIsolatedState } from "../helpers/backendTestHarness.ts";

const [
  state,
  { db },
  { dbOps },
  { downloadTracker },
  { finalizeRetainedPlaylistRelocations },
  { flowPlaylistConfig },
  removal,
  { downloadWorker },
] = await setupIsolatedBackend(
  "media-relocation",
  "backend/config/db-sqlite.ts",
  "backend/db/helpers/index.ts",
  "backend/services/downloadJobs/downloadTracker.ts",
  "backend/services/playlists/mediaRelocation.ts",
  "backend/services/playlists/flowPlaylistConfig.ts",
  "backend/services/playlists/trackRemoval.ts",
  "backend/services/downloadJobs/downloadWorker.ts",
);
afterAll(() => cleanupIsolatedState(state));

test("relocation retries a copied file after path persistence fails and preserves every shared job", async () => {
  dbOps.updateSettings({ integrations: {}, flows: [], sharedPlaylists: [] });
  const root = path.join(state.baseDir, "media");
  downloadWorker.downloadRoot = root;
  const source = flowPlaylistConfig.createStaticPlaylist({
    id: "source",
    name: "Source",
    tracks: [{ artistName: "Artist", trackName: "Track", albumName: "Album" }],
  });
  const oldPath = path.join(root, "aurral-weekly-flow", "source", "Artist", "Album", "Track.flac");
  await fs.mkdir(path.dirname(oldPath), { recursive: true });
  await fs.writeFile(oldPath, "disposable audio");
  const first = downloadTracker.addJob(
    { artistName: "Artist", trackName: "Track", albumName: "Album" },
    "source",
  );
  const second = downloadTracker.addJob(
    { artistName: "Artist", trackName: "Track", albumName: "Album" },
    "other",
  );
  downloadTracker.setDone(first, oldPath);
  downloadTracker.setDone(second, oldPath);
  flowPlaylistConfig.createStaticPlaylist({
    id: "target",
    name: "Target",
    tracks: [
      { artistName: "Artist", trackName: "Track", albumName: "Album", canonicalJobId: first },
    ],
  });
  const selection = removal.captureStaticPlaylistSelection(source, first);
  const remove = () =>
    removal.withStaticPlaylistRemovalMutation({ playlistId: source.id, jobIds: [first] }, () =>
      removal.removeStaticPlaylistSelectionsLocked({
        playlistId: source.id,
        selections: [selection],
      }),
    );
  db.exec(
    "CREATE TRIGGER reject_relocation BEFORE UPDATE OF final_path ON playlist_download_jobs BEGIN SELECT RAISE(ABORT, 'fixture path failure'); END",
  );
  try {
    await assert.rejects(remove(), /fixture path failure/);
    assert.equal(await fs.readFile(oldPath, "utf8"), "disposable audio");
    assert.equal(downloadTracker.getJob(first).finalPath, oldPath);
  } finally {
    db.exec("DROP TRIGGER reject_relocation");
  }
  await remove();
  const result = { finalPath: downloadTracker.getJob(first).finalPath };
  assert.equal(await fs.readFile(result.finalPath, "utf8"), "disposable audio");
  assert.equal(downloadTracker.getJob(first).finalPath, result.finalPath);
  assert.equal(downloadTracker.getJob(second).finalPath, result.finalPath);
  assert.equal((await fs.readdir(path.dirname(result.finalPath))).length, 1);
  assert.equal(await fs.readFile(oldPath, "utf8"), "disposable audio");
  await finalizeRetainedPlaylistRelocations("source", { downloadRoot: root });
  await assert.rejects(fs.access(oldPath));
});

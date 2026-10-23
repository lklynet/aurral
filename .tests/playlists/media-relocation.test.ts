import { requireFixture } from "./fixtures.ts";
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
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/services/downloadJobs/downloadTracker.ts"),
  () => import("../../backend/services/playlists/mediaRelocation.ts"),
  () => import("../../backend/services/playlists/flowPlaylistConfig.ts"),
  () => import("../../backend/services/playlists/trackRemoval.ts"),
  () => import("../../backend/services/downloadJobs/downloadWorker.ts"),
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
  assert.ok(first != null);
  const second = downloadTracker.addJob(
    { artistName: "Artist", trackName: "Track", albumName: "Album" },
    "other",
  );
  assert.ok(second != null);
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
  assert.ok(selection != null);
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
    assert.equal(requireFixture(downloadTracker.getJob(first)).finalPath, oldPath);
  } finally {
    db.exec("DROP TRIGGER reject_relocation");
  }
  await remove();
  const result = { finalPath: requireFixture(downloadTracker.getJob(first)).finalPath };
  assert.equal(await fs.readFile(requireFixture(result.finalPath), "utf8"), "disposable audio");
  assert.equal(requireFixture(downloadTracker.getJob(first)).finalPath, result.finalPath);
  assert.equal(requireFixture(downloadTracker.getJob(second)).finalPath, result.finalPath);
  assert.equal((await fs.readdir(path.dirname(requireFixture(result.finalPath)))).length, 1);
  assert.equal(await fs.readFile(oldPath, "utf8"), "disposable audio");
  await finalizeRetainedPlaylistRelocations("source", { downloadRoot: root });
  await assert.rejects(fs.access(oldPath));
});

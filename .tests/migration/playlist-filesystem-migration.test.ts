import { test, beforeEach, afterAll } from "vite-plus/test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import path from "path";

import { setupIsolatedBackend, cleanupIsolatedState } from "../helpers/backendTestHarness.ts";

const [isolatedState, { db }, { movePlaylistFiles, PLAYLIST_FILES_MIGRATION_KEY }] =
  await setupIsolatedBackend(
    "playlist-filesystem-migration",
    () => import("../../backend/config/db-sqlite.ts"),
    () => import("../../backend/services/playlistFilesystemMigration.ts"),
  );

const root = process.env.WEEKLY_FLOW_FOLDER;
assert.ok(root != null);
const legacyRoot = path.join(root, "aurral-weekly-flow");
const target = path.join(root, "_playlists");

const write = async (file: string, contents: string) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, contents);
};

beforeEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  db.prepare("DELETE FROM settings WHERE key = ?").run(PLAYLIST_FILES_MIGRATION_KEY);
});

afterAll(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("moves playlist files to _playlists and removes the emptied old folder", async () => {
  await write(path.join(legacyRoot, "_playlists", "Road Trip.m3u"), "#EXTM3U\n");
  await write(path.join(legacyRoot, "_playlists", "Road Trip.jpg"), "upload");
  await write(path.join(legacyRoot, "[AS] Old.m3u"), "#EXTM3U\n");

  assert.equal(movePlaylistFiles(root), 3);

  assert.deepEqual((await fs.readdir(target)).sort(), [
    "Road Trip.jpg",
    "Road Trip.m3u",
    "[AS] Old.m3u",
  ]);
  assert.equal(await fs.readFile(path.join(target, "Road Trip.jpg"), "utf8"), "upload");
  await assert.rejects(fs.access(legacyRoot));
  await write(path.join(legacyRoot, "_playlists", "Later.m3u"), "#EXTM3U\n");
  assert.equal(movePlaylistFiles(root), 0);
});

test("a move that fails runs again on the next start", async () => {
  await write(path.join(legacyRoot, "_playlists", "Mix.m3u"), "#EXTM3U\n");
  await write(target, "not a folder");

  assert.throws(() => movePlaylistFiles(root));
  await fs.rm(target);
  assert.equal(movePlaylistFiles(root), 1);
  assert.deepEqual(await fs.readdir(target), ["Mix.m3u"]);
});

test("keeps old download folders and a file already at the new path", async () => {
  const legacyTrack = path.join(legacyRoot, "playlist-id", "Artist", "Track.flac");
  await write(legacyTrack, "audio");
  await write(path.join(legacyRoot, "_playlists", "Mix.m3u"), "old");
  await write(path.join(target, "Mix.m3u"), "new");

  movePlaylistFiles(root);

  assert.equal(await fs.readFile(path.join(target, "Mix.m3u"), "utf8"), "new");
  assert.deepEqual(await fs.readdir(legacyRoot), ["playlist-id"]);
  assert.equal(await fs.readFile(legacyTrack, "utf8"), "audio");
});

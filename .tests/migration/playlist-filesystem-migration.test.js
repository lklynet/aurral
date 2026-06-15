import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import path from "path";

import {
  createIsolatedStateDir,
  applyIsolatedBackendEnv,
  cleanupIsolatedState,
  importFromRepo,
} from "../helpers/backendTestHarness.js";

const isolatedState = await createIsolatedStateDir("playlist-filesystem-migration");
applyIsolatedBackendEnv(isolatedState);

const { ensurePlaylistFilesystemLayout } = await importFromRepo(
  "backend/services/playlistFilesystemMigration.js",
);

const root = process.env.WEEKLY_FLOW_FOLDER;

test.beforeEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("keeps aurral-weekly-flow in place", async () => {
  const playlistRoot = path.join(root, "aurral-weekly-flow");
  const trackPath = path.join(playlistRoot, "playlist-id", "Artist", "Track.flac");
  await fs.mkdir(path.dirname(trackPath), { recursive: true });
  await fs.writeFile(trackPath, "audio");

  const result = ensurePlaylistFilesystemLayout({ root });

  assert.equal(result.renamed, false);
  assert.equal(result.merged, 0);
  assert.equal(result.playlistRoot, playlistRoot);
  await assert.doesNotReject(() =>
    fs.access(trackPath),
  );
});

test("does not merge or delete existing playlist directories", async () => {
  const playlistRoot = path.join(root, "aurral-weekly-flow");
  const previousV2Root = path.join(root, "aurral-playlists");
  const playlistTrack = path.join(playlistRoot, "legacy-playlist", "Song.flac");
  const previousTrack = path.join(previousV2Root, "existing-playlist", "Other.flac");
  await fs.mkdir(path.dirname(playlistTrack), { recursive: true });
  await fs.mkdir(path.dirname(previousTrack), { recursive: true });
  await fs.writeFile(playlistTrack, "legacy");
  await fs.writeFile(previousTrack, "existing");

  const result = ensurePlaylistFilesystemLayout({ root });

  assert.equal(result.merged, 0);
  await assert.doesNotReject(() =>
    fs.access(playlistTrack),
  );
  await assert.doesNotReject(() =>
    fs.access(previousTrack),
  );
});

test("moves playlist sidecars into _playlists", async () => {
  const playlistRoot = path.join(root, "aurral-weekly-flow");
  await fs.mkdir(playlistRoot, { recursive: true });
  await fs.writeFile(path.join(playlistRoot, "[AS] Test.m3u"), "#EXTM3U\n");

  const result = ensurePlaylistFilesystemLayout({ root });

  assert.equal(result.sidecarsMoved, 1);
  await assert.doesNotReject(() =>
    fs.access(path.join(playlistRoot, "_playlists", "[AS] Test.m3u")),
  );
});

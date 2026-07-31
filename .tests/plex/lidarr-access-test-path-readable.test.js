import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import path from "path";
import os from "os";

import { pathIsReadable } from "../../backend/services/lidarrLibraryAccessTest.js";

let tempDir;

test.before(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "aurral-path-readable-"));
});

test.after(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

test("pathIsReadable returns false for an empty or missing path", async () => {
  assert.equal(await pathIsReadable(""), false);
  assert.equal(await pathIsReadable(null), false);
  assert.equal(await pathIsReadable(undefined), false);
});

test("pathIsReadable returns the path directly when it's already readable - no mapping needed", async () => {
  const filePath = path.join(tempDir, "direct.flac");
  await fs.writeFile(filePath, "x");
  const result = await pathIsReadable(filePath, []);
  assert.equal(result, filePath);
});

test("pathIsReadable falls back to a mapped path when the reported path isn't directly readable - the exact scenario the Plex main-library access-check relies on", async () => {
  const localPath = path.join(tempDir, "Music", "Artist", "Track.flac");
  await fs.mkdir(path.dirname(localPath), { recursive: true });
  await fs.writeFile(localPath, "x");
  const reportedPath = "/media/Music/Artist/Track.flac";
  const mappings = [
    { source: "plex", remote: "/media/Music", local: path.join(tempDir, "Music") },
  ];
  const result = await pathIsReadable(reportedPath, mappings);
  assert.equal(result, localPath);
});

test("pathIsReadable returns false when neither the raw path nor any mapping resolves to a readable file", async () => {
  const mappings = [
    { source: "plex", remote: "/media/Music", local: path.join(tempDir, "does-not-exist") },
  ];
  const result = await pathIsReadable("/media/Music/Artist/Missing.flac", mappings);
  assert.equal(result, false);
});

test("pathIsReadable ignores a mapping whose remote prefix doesn't match the reported path", async () => {
  const mappings = [{ source: "plex", remote: "/other/prefix", local: tempDir }];
  const result = await pathIsReadable("/media/Music/Artist/Track.flac", mappings);
  assert.equal(result, false);
});

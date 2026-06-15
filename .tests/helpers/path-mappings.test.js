import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import { realpathSync } from "fs";
import os from "os";
import path from "path";

import {
  detectPathMappings,
  getPathMappings,
  inferPathMappings,
  looksLikeExternalOnlyPath,
  normalizePathMappings,
  parsePathMappingsEnv,
  resolveLocalPath,
  resolveRemotePath,
} from "../../backend/services/pathMappings.js";

test("resolveLocalPath maps a Windows prefix to a container path", () => {
  const mappings = normalizePathMappings([
    { remote: "N:/ServerFolders/Music", local: "/music" },
  ]);
  assert.equal(
    resolveLocalPath(
      "N:\\ServerFolders\\Music\\Music\\Artist\\track.mp3",
      mappings,
    ),
    path.resolve("/music/Music/Artist/track.mp3"),
  );
});

test("resolveLocalPath leaves already-local paths unchanged when no mapping matches", () => {
  const mappings = normalizePathMappings([
    { remote: "N:/ServerFolders/Music", local: "/music" },
  ]);
  assert.equal(
    resolveLocalPath("/music/Music/Artist/track.mp3", mappings),
    path.resolve("/music/Music/Artist/track.mp3"),
  );
});

test("inferPathMappings derives a shared parent mapping", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "aurral-path-map-"));
  const musicRoot = path.join(rootDir, "Music");
  await fs.mkdir(musicRoot, { recursive: true });

  const mappings = inferPathMappings(
    ["N:/ServerFolders/Music/Music"],
    [rootDir],
  );

  await fs.rm(rootDir, { recursive: true, force: true });

  assert.deepEqual(mappings, [
    { remote: "N:/ServerFolders/Music", local: rootDir },
  ]);
});

test("detectPathMappings verifies a mapped sample file", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "aurral-path-map-"));
  const trackPath = path.join(rootDir, "Music", "Artist", "track.mp3");
  await fs.mkdir(path.dirname(trackPath), { recursive: true });
  await fs.writeFile(trackPath, "audio");

  const detection = await detectPathMappings({
    externalPaths: ["N:/ServerFolders/Music/Music"],
    samplePaths: ["N:/ServerFolders/Music/Music/Artist/track.mp3"],
    localRoots: [rootDir],
  });

  await fs.rm(rootDir, { recursive: true, force: true });

  assert.equal(detection.verified, true);
  assert.equal(detection.mappings.length, 1);
  assert.equal(
    detection.sampleLocalPath,
    path.resolve(rootDir, "Music", "Artist", "track.mp3"),
  );
});

test("parsePathMappingsEnv reads pipe-separated mappings", () => {
  const previous = process.env.PATH_MAPPINGS;
  process.env.PATH_MAPPINGS = "N:/ServerFolders/Music|/music";
  assert.deepEqual(parsePathMappingsEnv(), [
    { remote: "N:/ServerFolders/Music", local: path.resolve("/music") },
  ]);
  if (previous === undefined) delete process.env.PATH_MAPPINGS;
  else process.env.PATH_MAPPINGS = previous;
});

test("resolveLocalPath suffix-walks mounted roots without saved mappings", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "aurral-path-map-"));
  const trackPath = path.join(rootDir, "Music", "Artist", "track.mp3");
  await fs.mkdir(path.dirname(trackPath), { recursive: true });
  await fs.writeFile(trackPath, "audio");

  const previousBrowseRoots = process.env.FILE_BROWSE_ROOTS;
  process.env.FILE_BROWSE_ROOTS = rootDir;

  assert.equal(
    realpathSync(resolveLocalPath("N:/ServerFolders/Music/Music/Artist/track.mp3", [])),
    realpathSync(trackPath),
  );

  if (previousBrowseRoots === undefined) delete process.env.FILE_BROWSE_ROOTS;
  else process.env.FILE_BROWSE_ROOTS = previousBrowseRoots;
  await fs.rm(rootDir, { recursive: true, force: true });
});

test("resolveRemotePath inverts a Windows prefix mapping", () => {
  const mappings = normalizePathMappings([
    { remote: "N:/ServerFolders/Music", local: "/music" },
  ]);
  assert.equal(
    resolveRemotePath("/music/Music/Artist/track.mp3", mappings),
    "N:/ServerFolders/Music/Music/Artist/track.mp3",
  );
});

test("resolveRemotePath leaves unmapped local paths unchanged", () => {
  const mappings = normalizePathMappings([
    { remote: "N:/ServerFolders/Music", local: "/music" },
  ]);
  assert.equal(
    resolveRemotePath("/data/music/Artist/track.mp3", mappings),
    path.resolve("/data/music/Artist/track.mp3"),
  );
});
test("looksLikeExternalOnlyPath detects Windows and UNC paths", () => {
  assert.equal(looksLikeExternalOnlyPath("N:\\Music\\Artist"), true);
  assert.equal(looksLikeExternalOnlyPath("\\\\server\\share\\Music"), true);
  assert.equal(looksLikeExternalOnlyPath("/music/Artist"), false);
});

import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import path from "path";

import {
  getPathMappings,
  looksLikeExternalOnlyPath,
  normalizePathMappings,
  parsePathMappingsEnv,
  resolveLocalPath,
  resolveRemotePath,
} from "../../backend/services/pathMappings.js";

test("resolveLocalPath maps a Windows prefix to a container path", () => {
  const mappings = normalizePathMappings([{ remote: "N:/ServerFolders/Music", local: "/music" }]);
  assert.equal(
    resolveLocalPath("N:\\ServerFolders\\Music\\Music\\Artist\\track.mp3", mappings),
    path.resolve("/music/Music/Artist/track.mp3"),
  );
});

test("resolveLocalPath leaves already-local paths unchanged when no mapping matches", () => {
  const mappings = normalizePathMappings([{ remote: "N:/ServerFolders/Music", local: "/music" }]);
  assert.equal(
    resolveLocalPath("/music/Music/Artist/track.mp3", mappings),
    path.resolve("/music/Music/Artist/track.mp3"),
  );
});

test("parsePathMappingsEnv reads pipe-separated mappings", () => {
  const previous = process.env.PATH_MAPPINGS;
  process.env.PATH_MAPPINGS = "N:/ServerFolders/Music|/music";
  assert.deepEqual(parsePathMappingsEnv(), [
    {
      source: "all",
      remote: "N:/ServerFolders/Music",
      local: path.resolve("/music"),
    },
  ]);
  if (previous === undefined) delete process.env.PATH_MAPPINGS;
  else process.env.PATH_MAPPINGS = previous;
});

test("parsePathMappingsEnv supports source-scoped mappings", () => {
  const previous = process.env.PATH_MAPPINGS;
  process.env.PATH_MAPPINGS =
    "lidarr|N:/ServerFolders/Music|/music;slskd|/downloads|/data/downloads/slskd";
  assert.deepEqual(parsePathMappingsEnv(), [
    {
      source: "lidarr",
      remote: "N:/ServerFolders/Music",
      local: path.resolve("/music"),
    },
    {
      source: "slskd",
      remote: "/downloads",
      local: path.resolve("/data/downloads/slskd"),
    },
  ]);
  if (previous === undefined) delete process.env.PATH_MAPPINGS;
  else process.env.PATH_MAPPINGS = previous;
});

test("getPathMappings filters mappings by source while keeping all-source mappings", () => {
  const previous = process.env.PATH_MAPPINGS;
  process.env.PATH_MAPPINGS =
    "/shared|/data;lidarr|N:/ServerFolders/Music|/music;slskd|/downloads|/data/downloads/slskd";
  assert.deepEqual(getPathMappings("lidarr"), [
    {
      source: "lidarr",
      remote: "N:/ServerFolders/Music",
      local: path.resolve("/music"),
    },
    {
      source: "all",
      remote: "/shared",
      local: path.resolve("/data"),
    },
  ]);
  if (previous === undefined) delete process.env.PATH_MAPPINGS;
  else process.env.PATH_MAPPINGS = previous;
});

test("resolveLocalPath requires direct access or an explicit mapping", () => {
  assert.equal(
    resolveLocalPath("N:/ServerFolders/Music/Music/Artist/track.mp3", []),
    path.resolve("N:/ServerFolders/Music/Music/Artist/track.mp3"),
  );
});

test("resolveRemotePath inverts a Windows prefix mapping", () => {
  const mappings = normalizePathMappings([{ remote: "N:/ServerFolders/Music", local: "/music" }]);
  assert.equal(
    resolveRemotePath("/music/Music/Artist/track.mp3", mappings),
    "N:/ServerFolders/Music/Music/Artist/track.mp3",
  );
});

test("resolveRemotePath leaves unmapped local paths unchanged", () => {
  const mappings = normalizePathMappings([{ remote: "N:/ServerFolders/Music", local: "/music" }]);
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

import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";

import { importFromRepo } from "../helpers/backendTestHarness.js";

const {
  commitImportToPlaylistLibrary,
  locateCompletedDownload,
  parseSlskdRemoteFile,
  predictSlskdLocalPathCandidates,
} = await importFromRepo("backend/services/slskdOrchestrator.js");

test("parseSlskdRemoteFile reads parent folder and basename from remote paths", () => {
  assert.deepEqual(
    parseSlskdRemoteFile("Eir Aoi\\Best - A -\\03. Eir Aoi - IGNITE.flac"),
    {
      fileName: "03. Eir Aoi - IGNITE.flac",
      parentDir: "Best - A -",
    },
  );
  assert.deepEqual(parseSlskdRemoteFile("Single.flac"), {
    fileName: "Single.flac",
    parentDir: "",
  });
});

test("predictSlskdLocalPathCandidates mirrors slskd parent-folder placement", () => {
  const remote = "Artist\\Album Name\\01 - Track.flac";
  assert.deepEqual(
    predictSlskdLocalPathCandidates("/downloads", remote),
    [
      path.join("/downloads", "Album Name", "01 - Track.flac"),
      path.join("/downloads", "01 - Track.flac"),
    ],
  );
});

test("locateCompletedDownload finds predicted slskd paths before recursive fallback", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aurral-slskd-locate-"));
  const remote = "Eir Aoi\\Best - A -\\03. Eir Aoi - IGNITE.flac";
  const expectedPath = path.join(root, "Best - A -", "03. Eir Aoi - IGNITE.flac");
  await fs.mkdir(path.dirname(expectedPath), { recursive: true });
  await fs.writeFile(expectedPath, "audio-by-size", "utf8");

  const decoyPath = path.join(root, "Other Album", "03. Eir Aoi - IGNITE.flac");
  await fs.mkdir(path.dirname(decoyPath), { recursive: true });
  await fs.writeFile(decoyPath, "decoy", "utf8");

  const resolved = await locateCompletedDownload(root, null, remote, {
    expectedSizeBytes: Buffer.byteLength("audio-by-size"),
  });

  assert.equal(resolved, expectedPath);
  await fs.rm(root, { recursive: true, force: true });
});

test("locateCompletedDownload prefers size matches during recursive fallback", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aurral-slskd-locate-"));
  const remote = "Artist\\Wrong Album\\01 - Track.flac";
  const wrongPath = path.join(root, "Folder A", "01 - Track.flac");
  const rightPath = path.join(root, "Folder B", "01 - Track.flac");
  await fs.mkdir(path.dirname(wrongPath), { recursive: true });
  await fs.mkdir(path.dirname(rightPath), { recursive: true });
  await fs.writeFile(wrongPath, "wrong", "utf8");
  await fs.writeFile(rightPath, "expected-size", "utf8");

  const resolved = await locateCompletedDownload(root, null, remote, {
    expectedSizeBytes: Buffer.byteLength("expected-size"),
  });

  assert.equal(resolved, rightPath);
  await fs.rm(root, { recursive: true, force: true });
});

test("locateCompletedDownload uses transfer filename when slskd reports a local path", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aurral-slskd-locate-"));
  const remote = "Artist\\Album\\01 - Track.flac";
  const localPath = path.join(root, "Album", "01 - Track.flac");
  await fs.mkdir(path.dirname(localPath), { recursive: true });
  await fs.writeFile(localPath, "audio", "utf8");

  const resolved = await locateCompletedDownload(root, null, remote, {
    transfer: { filename: localPath },
  });

  assert.equal(resolved, localPath);
  await fs.rm(root, { recursive: true, force: true });
});

test("commitImportToPlaylistLibrary moves without overwriting existing targets", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aurral-import-commit-"));
  const source = path.join(root, "slskd", "Track.flac");
  const target = path.join(root, "aurral", "Track.flac");
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(source, "new-audio", "utf8");
  await fs.writeFile(target, "existing-audio", "utf8");

  const finalPath = await commitImportToPlaylistLibrary(source, target);

  assert.equal(finalPath, path.join(root, "aurral", "Track (2).flac"));
  assert.equal(await fs.readFile(target, "utf8"), "existing-audio");
  assert.equal(await fs.readFile(finalPath, "utf8"), "new-audio");
  await assert.rejects(() => fs.stat(source), /ENOENT/);
  await fs.rm(root, { recursive: true, force: true });
});

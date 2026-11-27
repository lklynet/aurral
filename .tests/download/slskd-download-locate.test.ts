import { test, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import { existsSync } from "fs";
import os from "os";
import path from "path";

import {
  locateCompletedDownload,
  parseSlskdRemoteFile,
  predictSlskdLocalPathCandidates,
} from "../../backend/services/slskdOrchestrator.ts";
import { commitDownloadedFile } from "../../backend/services/downloadUtils.ts";

test("parseSlskdRemoteFile reads parent folder and basename from remote paths", () => {
  assert.deepEqual(parseSlskdRemoteFile("Eir Aoi\\Best - A -\\03. Eir Aoi - IGNITE.flac"), {
    fileName: "03. Eir Aoi - IGNITE.flac",
    parentDir: "Best - A -",
  });
  assert.deepEqual(parseSlskdRemoteFile("Single.flac"), {
    fileName: "Single.flac",
    parentDir: "",
  });
});

test("predictSlskdLocalPathCandidates mirrors slskd parent-folder placement", () => {
  const remote = "Artist\\Album Name\\01 - Track.flac";
  assert.deepEqual(predictSlskdLocalPathCandidates("/downloads", remote), [
    path.join("/downloads", "Album Name", "01 - Track.flac"),
    path.join("/downloads", "01 - Track.flac"),
  ]);
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

test("locateCompletedDownload uses the file slskd saved when it renamed a duplicate", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aurral-slskd-locate-"));
  const remote = "Music\\Artist\\Album\\01 - Track.flac";
  const olderPath = path.join(root, "Album", "01 - Track.flac");
  const savedPath = path.join(root, "Album", "01 - Track_639268025041726158.flac");
  await fs.mkdir(path.dirname(olderPath), { recursive: true });
  await fs.writeFile(olderPath, "audio", "utf8");
  await fs.writeFile(savedPath, "audio", "utf8");
  const expectedSizeBytes = Buffer.byteLength("audio");

  assert.equal(await locateCompletedDownload(root, null, remote, { expectedSizeBytes }), olderPath);
  assert.equal(
    await locateCompletedDownload(root, null, remote, {
      expectedSizeBytes,
      localFilename: savedPath,
    }),
    savedPath,
  );
  await fs.rm(root, { recursive: true, force: true });
});

test("locateCompletedDownload skips a missing slskd root and checks the playlist root", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aurral-slskd-fallback-"));
  const missingSlskdRoot = path.join(root, "missing-slskd");
  const playlistRoot = path.join(root, "playlists");
  const remote = "Artist\\Album\\01 - Track.flac";
  const expectedPath = path.join(playlistRoot, "Album", "01 - Track.flac");
  await fs.mkdir(path.dirname(expectedPath), { recursive: true });
  await fs.writeFile(expectedPath, "audio", "utf8");

  const resolved = await locateCompletedDownload(missingSlskdRoot, playlistRoot, remote);

  assert.equal(resolved, expectedPath);
  assert.equal(Array.isArray(resolved), false);
  await fs.rm(root, { recursive: true, force: true });
});

test("commitDownloadedFile moves without overwriting existing targets", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aurral-import-commit-"));
  const source = path.join(root, "slskd", "Track.flac");
  const target = path.join(root, "aurral", "Track.flac");
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(source, "new-audio", "utf8");
  await fs.writeFile(target, "existing-audio", "utf8");

  const finalPath = await commitDownloadedFile(source, target);

  assert.equal(finalPath, path.join(root, "aurral", "Track (2).flac"));
  assert.equal(await fs.readFile(target, "utf8"), "existing-audio");
  assert.equal(await fs.readFile(finalPath, "utf8"), "new-audio");
  await assert.rejects(() => fs.stat(source), /ENOENT/);
  await fs.rm(root, { recursive: true, force: true });
});

test("commitDownloadedFile keeps a copy made across filesystems when the download client's file cannot be removed", async (t: import("vite-plus/test").TestContext) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aurral-import-cross-device-"));
  t.onTestFinished(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });
  const source = path.join(root, "slskd", "Track.flac");
  const target = path.join(root, "aurral", "Track.flac");
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.writeFile(source, "downloaded-audio", "utf8");
  const rename = fs.rename.bind(fs);
  vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
    if (from === source) throw Object.assign(new Error("cross-device link"), { code: "EXDEV" });
    return rename(from, to);
  });
  const rm = fs.rm.bind(fs);
  vi.spyOn(fs, "rm").mockImplementation(async (file, options) => {
    if (file === source) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    return rm(file, options);
  });

  assert.equal(await commitDownloadedFile(source, target), target);
  assert.equal(await fs.readFile(target, "utf8"), "downloaded-audio");
  assert.deepEqual(await fs.readdir(path.dirname(target)), ["Track.flac"]);
});

test("commitDownloadedFile copies to a share that refuses chmod", async (t: import("vite-plus/test").TestContext) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aurral-import-no-chmod-"));
  t.onTestFinished(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });
  const rename = fs.rename.bind(fs);
  vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
    if (String(from).includes("staging"))
      throw Object.assign(new Error("cross-device link"), { code: "EXDEV" });
    return rename(from, to);
  });
  vi.spyOn(fs, "copyFile").mockRejectedValue(
    Object.assign(new Error("operation not permitted, copyfile"), { code: "EPERM" }),
  );

  for (const preserveSource of [false, true]) {
    const source = path.join(root, "staging", `${preserveSource}.m4a`);
    const target = path.join(root, "downloads", `${preserveSource}.m4a`);
    await fs.mkdir(path.dirname(source), { recursive: true });
    await fs.writeFile(source, "downloaded-audio", "utf8");

    assert.equal(await commitDownloadedFile(source, target, { preserveSource }), target);
    assert.equal(await fs.readFile(target, "utf8"), "downloaded-audio");
    assert.equal(existsSync(source), preserveSource);
  }
  assert.deepEqual((await fs.readdir(path.join(root, "downloads"))).sort(), [
    "false.m4a",
    "true.m4a",
  ]);
});

test("commitDownloadedFile can preserve a shared source for another consumer", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aurral-import-shared-"));
  const source = path.join(root, "usenet", "Track.flac");
  const target = path.join(root, "aurral", "Track.flac");
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.writeFile(source, "shared-audio", "utf8");

  const finalPath = await commitDownloadedFile(source, target, { preserveSource: true });

  assert.equal(finalPath, target);
  assert.equal(await fs.readFile(finalPath, "utf8"), "shared-audio");
  assert.equal(await fs.readFile(source, "utf8"), "shared-audio");
  await fs.rm(root, { recursive: true, force: true });
});

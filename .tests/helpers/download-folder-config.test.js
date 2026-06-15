import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";

test("resolveEnvDownloadFolder prefers DOWNLOAD_FOLDER", async () => {
  const previous = process.env.DOWNLOAD_FOLDER;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aurral-download-env-"));
  process.env.DOWNLOAD_FOLDER = tempDir;
  const { resolveEnvDownloadFolder, syncDownloadFolderPath } = await import(
    "../../backend/services/downloadFolderConfig.js"
  );
  syncDownloadFolderPath(null);
  assert.equal(resolveEnvDownloadFolder(), path.resolve(tempDir));
  if (previous === undefined) delete process.env.DOWNLOAD_FOLDER;
  else process.env.DOWNLOAD_FOLDER = previous;
});

test("resolvePlaylistRoot prefers stored download folder path", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aurral-download-db-"));
  const previous = process.env.DOWNLOAD_FOLDER;
  delete process.env.DOWNLOAD_FOLDER;
  const { syncDownloadFolderPath } = await import(
    "../../backend/services/downloadFolderConfig.js"
  );
  const { resolvePlaylistRoot } = await import(
    "../../backend/services/playlistPaths.js"
  );
  syncDownloadFolderPath(tempDir);
  assert.equal(resolvePlaylistRoot(), path.resolve(tempDir));
  syncDownloadFolderPath(null);
  if (previous === undefined) delete process.env.DOWNLOAD_FOLDER;
  else process.env.DOWNLOAD_FOLDER = previous;
});

test("resolveExistingBrowsePath falls back to an existing ancestor", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aurral-browse-up-"));
  const previousRoots = process.env.FILE_BROWSE_ROOTS;
  process.env.FILE_BROWSE_ROOTS = tempDir;
  const { resolveExistingBrowsePath } = await import(
    "../../backend/services/downloadFolderConfig.js"
  );
  const resolved = resolveExistingBrowsePath(path.join(tempDir, "downloads", "aurral"));
  assert.equal(resolved, fs.realpathSync(tempDir));
  if (previousRoots === undefined) delete process.env.FILE_BROWSE_ROOTS;
  else process.env.FILE_BROWSE_ROOTS = previousRoots;
});

test("resolveSafeBrowsePath allows child directories under filesystem root", async () => {
  const previousRoots = process.env.FILE_BROWSE_ROOTS;
  process.env.FILE_BROWSE_ROOTS = "/";
  const { resolveSafeBrowsePath } = await import(
    "../../backend/services/downloadFolderConfig.js"
  );
  const childPath = ["/Users", "/tmp", "/home"].find((candidate) =>
    fs.existsSync(candidate),
  );
  assert.ok(childPath, "expected a top-level child directory for this test");
  const resolvedPath = resolveSafeBrowsePath(childPath);
  assert.ok(resolvedPath);
  assert.equal(resolvedPath, fs.realpathSync(childPath));
  if (previousRoots === undefined) delete process.env.FILE_BROWSE_ROOTS;
  else process.env.FILE_BROWSE_ROOTS = previousRoots;
});

test("ensureDownloadFolderPath creates missing directories under browse roots", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aurral-ensure-"));
  const previousRoots = process.env.FILE_BROWSE_ROOTS;
  process.env.FILE_BROWSE_ROOTS = tempDir;
  const target = path.join(tempDir, "downloads", "aurral");
  const { ensureDownloadFolderPath } = await import(
    "../../backend/services/downloadFolderConfig.js"
  );
  const result = ensureDownloadFolderPath(target);
  assert.equal(result.valid, true);
  assert.equal(result.created, true);
  assert.equal(fs.existsSync(target), true);
  if (previousRoots === undefined) delete process.env.FILE_BROWSE_ROOTS;
  else process.env.FILE_BROWSE_ROOTS = previousRoots;
});

test("listBrowseDirectory only exposes directories within browse roots", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aurral-browse-"));
  const childDir = path.join(tempDir, "aurral");
  fs.mkdirSync(childDir);
  const previousRoots = process.env.FILE_BROWSE_ROOTS;
  process.env.FILE_BROWSE_ROOTS = tempDir;
  const { listBrowseDirectory } = await import(
    "../../backend/services/downloadFolderConfig.js"
  );
  const listing = listBrowseDirectory(tempDir);
  assert.equal(listing.path, fs.realpathSync(tempDir));
  assert.equal(listing.entries.length, 1);
  assert.equal(listing.entries[0].name, "aurral");
  if (previousRoots === undefined) delete process.env.FILE_BROWSE_ROOTS;
  else process.env.FILE_BROWSE_ROOTS = previousRoots;
});

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

test("default download folder follows the available writable data root", async () => {
  const previousDataDir = process.env.AURRAL_DATA_DIR;
  const previousDownloadFolder = process.env.DOWNLOAD_FOLDER;
  const previousPlaylistFolder = process.env.PLAYLIST_FOLDER;
  const previousWeeklyFlowFolder = process.env.WEEKLY_FLOW_FOLDER;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aurral-download-default-"));
  const nonDirectoryPath = path.join(tempDir, "not-a-directory");
  fs.writeFileSync(nonDirectoryPath, "test");
  process.env.AURRAL_DATA_DIR = tempDir;
  delete process.env.DOWNLOAD_FOLDER;
  delete process.env.PLAYLIST_FOLDER;
  delete process.env.WEEKLY_FLOW_FOLDER;

  try {
    const { resolveDefaultPlaylistDownloadRoot } = await import(
      "../../backend/services/downloadFolderConfig.js"
    );
    assert.equal(
      resolveDefaultPlaylistDownloadRoot({ dataRoot: tempDir }),
      path.join(tempDir, "downloads", "aurral"),
    );
    assert.equal(
      resolveDefaultPlaylistDownloadRoot({ dataRoot: nonDirectoryPath }),
      path.join(tempDir, "downloads", "aurral"),
    );
  } finally {
    if (previousDataDir === undefined) delete process.env.AURRAL_DATA_DIR;
    else process.env.AURRAL_DATA_DIR = previousDataDir;
    if (previousDownloadFolder === undefined) delete process.env.DOWNLOAD_FOLDER;
    else process.env.DOWNLOAD_FOLDER = previousDownloadFolder;
    if (previousPlaylistFolder === undefined) delete process.env.PLAYLIST_FOLDER;
    else process.env.PLAYLIST_FOLDER = previousPlaylistFolder;
    if (previousWeeklyFlowFolder === undefined) delete process.env.WEEKLY_FLOW_FOLDER;
    else process.env.WEEKLY_FLOW_FOLDER = previousWeeklyFlowFolder;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("yt-dlp staging defaults outside the download folder and honors an override", async () => {
  const previousDataDir = process.env.AURRAL_DATA_DIR;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aurral-staging-default-"));
  const override = path.join(dataDir, "mounted-staging");
  process.env.AURRAL_DATA_DIR = dataDir;

  try {
    const { resolveYtdlpStagingRoot } = await import(
      "../../backend/services/downloadFolderConfig.js"
    );
    assert.equal(resolveYtdlpStagingRoot(), path.join(dataDir, "_staging"));
    assert.equal(resolveYtdlpStagingRoot(override), override);
  } finally {
    if (previousDataDir === undefined) delete process.env.AURRAL_DATA_DIR;
    else process.env.AURRAL_DATA_DIR = previousDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
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

test("getFilesystemBrowseRoots returns dedicated roots before filesystem root", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aurral-browse-roots-"));
  const previousRoots = process.env.FILE_BROWSE_ROOTS;
  const previousDownloadFolder = process.env.DOWNLOAD_FOLDER;
  delete process.env.FILE_BROWSE_ROOTS;
  process.env.DOWNLOAD_FOLDER = path.join(tempDir, "downloads", "tmp");
  fs.mkdirSync(process.env.DOWNLOAD_FOLDER, { recursive: true });
  const { getFilesystemBrowseRoots } = await import(
    "../../backend/services/downloadFolderConfig.js"
  );
  const roots = getFilesystemBrowseRoots();
  const downloadRoot = fs.realpathSync(process.env.DOWNLOAD_FOLDER);
  assert.ok(roots.includes(downloadRoot), `roots=${roots.join(", ")}`);
  assert.ok(
    roots.some((root) => root !== path.resolve("/")),
    "expected dedicated roots instead of only filesystem root",
  );
  if (previousRoots === undefined) delete process.env.FILE_BROWSE_ROOTS;
  else process.env.FILE_BROWSE_ROOTS = previousRoots;
  if (previousDownloadFolder === undefined) delete process.env.DOWNLOAD_FOLDER;
  else process.env.DOWNLOAD_FOLDER = previousDownloadFolder;
});

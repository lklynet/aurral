import fs from "fs";
import path from "path";
import { PLAYLIST_FILES_DIR, resolveDownloadRoot } from "../services/downloadPaths.js";
import { StartupRefusal } from "./startupRefusal.js";

const RETIRED_SETTING_PATTERNS = [
  "migration:*",
  "news:rssState",
  "user:*:newsPreferences",
  "aurral3Readiness",
  "storedDataMigration",
  "identityMarkerMigration",
  "playlistStartupMigration",
  "aurralDownloadFolderMigration",
  "deprecatedUsage",
  "playlistMediaRelocation:*",
];
const AURRAL_2_PLAYLIST_FILES_DIR = "aurral-weekly-flow";
const KEPT_PLAYLIST_FILE_EXTENSIONS = new Set([".webp", ".jpg", ".no-artwork"]);
const RETIRED_PLAYLIST_FILE_EXTENSIONS = new Set([".png", ".m3u", ".nsp"]);

function readSetting(db, key) {
  return db.prepare("SELECT value FROM settings WHERE key = ?").get(key)?.value;
}

function readDirectory(directory) {
  try {
    return fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function moveFile(source, target) {
  if (fs.existsSync(target)) {
    fs.rmSync(source, { force: true });
    return;
  }
  try {
    fs.renameSync(source, target);
  } catch (error) {
    if (error?.code !== "EXDEV") throw error;
    fs.copyFileSync(source, target);
    fs.rmSync(source, { force: true });
  }
}

function removeEmptyDirectories(directory) {
  for (const entry of readDirectory(directory)) {
    if (entry.isDirectory()) removeEmptyDirectories(path.join(directory, entry.name));
  }
  if (readDirectory(directory).length === 0) fs.rmSync(directory, { recursive: true, force: true });
}

function movePlaylistFiles(downloadRoot, log) {
  const oldRoot = path.join(downloadRoot, AURRAL_2_PLAYLIST_FILES_DIR);
  const oldFiles = path.join(oldRoot, "_playlists");
  const newFiles = path.join(downloadRoot, PLAYLIST_FILES_DIR);
  let moved = 0;
  for (const entry of readDirectory(oldFiles)) {
    if (!entry.isFile()) continue;
    const extension = path.extname(entry.name).toLowerCase();
    const source = path.join(oldFiles, entry.name);
    if (KEPT_PLAYLIST_FILE_EXTENSIONS.has(extension)) {
      fs.mkdirSync(newFiles, { recursive: true });
      moveFile(source, path.join(newFiles, entry.name));
      moved += 1;
    } else if (RETIRED_PLAYLIST_FILE_EXTENSIONS.has(extension)) {
      fs.rmSync(source, { force: true });
    }
  }
  if (fs.existsSync(oldRoot)) removeEmptyDirectories(oldRoot);
  if (moved > 0) log(`Moved ${moved} playlist artwork file(s) to ${newFiles}`);
  if (fs.existsSync(oldRoot)) log(`${oldRoot} still holds files that Aurral does not use. Review and remove them.`);
}

export function moveAurral2Files(db, { dataDir, env = process.env, log = () => {} } = {}) {
  const downloadRoot = path.resolve(
    resolveDownloadRoot(readSetting(db, "downloadFolderPath") || env.DOWNLOAD_FOLDER),
  );
  try {
    movePlaylistFiles(downloadRoot, log);
    fs.rmSync(path.join(dataDir, ".image-cache-links-v1"), { force: true });
  } catch (error) {
    throw new StartupRefusal(
      `Could not move Aurral 2 playlist files in ${downloadRoot}: ${error.message}. Fix the folder permissions, then start Aurral again.`,
    );
  }
}

export function upgradeFromAurral2(db) {
  const removeSettings = db.prepare("DELETE FROM settings WHERE key GLOB ?");
  for (const pattern of RETIRED_SETTING_PATTERNS) removeSettings.run(pattern);
  db.exec(`
    DELETE FROM images_cache
    WHERE image_url LIKE 'http://archive.org/%'
       OR image_url LIKE 'https://archive.org/%'
       OR image_url GLOB 'http*://*.ca.archive.org/*';
  `);
}

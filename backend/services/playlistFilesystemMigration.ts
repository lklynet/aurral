import fs from "fs";
import path from "path";
import { db } from "../config/db-sqlite.ts";
import { LEGACY_PLAYLIST_DIR, PLAYLIST_FILES_DIR, resolveDownloadRoot } from "./downloadPaths.ts";

export const PLAYLIST_FILES_MIGRATION_KEY = "migration:playlist-files-v1";

const PLAYLIST_SIDECAR_EXT = new Set([".m3u", ".nsp", ".webp", ".png", ".jpg"]);

const entries = (directory: string) =>
  fs.existsSync(directory) ? fs.readdirSync(directory, { withFileTypes: true }) : [];

function moveFromLegacyFolder(root: string) {
  const legacyRoot = path.join(root, LEGACY_PLAYLIST_DIR);
  if (!fs.existsSync(legacyRoot)) return 0;
  const legacyFiles = path.join(legacyRoot, "_playlists");
  const sources = [
    ...entries(legacyFiles).map((entry) => path.join(legacyFiles, entry.name)),
    ...entries(legacyRoot)
      .filter(
        (entry) =>
          entry.isFile() && PLAYLIST_SIDECAR_EXT.has(path.extname(entry.name).toLowerCase()),
      )
      .map((entry) => path.join(legacyRoot, entry.name)),
  ];
  const target = path.join(root, PLAYLIST_FILES_DIR);
  fs.mkdirSync(target, { recursive: true });
  for (const source of sources) {
    const destination = path.join(target, path.basename(source));
    if (fs.existsSync(destination)) fs.rmSync(source, { force: true });
    else fs.renameSync(source, destination);
  }
  if (fs.existsSync(legacyFiles)) fs.rmdirSync(legacyFiles);
  if (!fs.readdirSync(legacyRoot).length) fs.rmdirSync(legacyRoot);
  return sources.length;
}

export function movePlaylistFiles(root = resolveDownloadRoot()) {
  if (db.prepare("SELECT 1 FROM settings WHERE key = ?").get(PLAYLIST_FILES_MIGRATION_KEY)) {
    return 0;
  }
  const moved = moveFromLegacyFolder(root);
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, '1')").run(
    PLAYLIST_FILES_MIGRATION_KEY,
  );
  return moved;
}

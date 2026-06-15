import fs from "fs";
import path from "path";
import {
  PLAYLIST_LIBRARY_DIR,
  resolvePlaylistRoot,
} from "./playlistPaths.js";

const PLAYLIST_SIDECAR_EXT = new Set([".m3u", ".nsp", ".webp", ".png"]);

function relocatePlaylistSidecars(playlistRoot) {
  const playlistsDir = path.join(playlistRoot, "_playlists");
  fs.mkdirSync(playlistsDir, { recursive: true });
  let moved = 0;
  if (!fs.existsSync(playlistRoot)) return moved;
  for (const entry of fs.readdirSync(playlistRoot)) {
    if (entry === "_playlists") continue;
    const full = path.join(playlistRoot, entry);
    if (!fs.statSync(full).isFile()) continue;
    const ext = path.extname(entry).toLowerCase();
    if (!PLAYLIST_SIDECAR_EXT.has(ext)) continue;
    const dest = path.join(playlistsDir, entry);
    if (fs.existsSync(dest)) {
      fs.rmSync(full, { force: true });
    } else {
      fs.renameSync(full, dest);
    }
    moved += 1;
  }
  return moved;
}

export function ensurePlaylistFilesystemLayout(options = {}) {
  const root = resolvePlaylistRoot(options.root);
  const playlistRoot = path.join(root, PLAYLIST_LIBRARY_DIR);

  if (!fs.existsSync(playlistRoot)) {
    fs.mkdirSync(playlistRoot, { recursive: true });
  }

  const sidecarsMoved = relocatePlaylistSidecars(playlistRoot);
  return { renamed: false, merged: 0, sidecarsMoved, playlistRoot, root };
}

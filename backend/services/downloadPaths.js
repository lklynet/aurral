import fs from "fs/promises";
import path from "path";
import {
  getStoredDownloadFolderPath,
  resolveDefaultDownloadRoot,
  resolveEnvDownloadFolder,
} from "./downloadFolderConfig.js";

export const PLAYLIST_FILES_DIR = "_playlists";
export const AURRAL_FLOWS_DIR = "_flows";

function defaultPlaylistRoot() {
  return resolveDefaultDownloadRoot();
}

export function resolveDownloadRoot(explicitRoot) {
  const override = String(explicitRoot ?? "").trim();
  if (override) {
    return path.isAbsolute(override) ? override : path.resolve(process.cwd(), override);
  }

  const stored = getStoredDownloadFolderPath();
  if (stored) {
    return path.isAbsolute(stored) ? stored : path.resolve(process.cwd(), stored);
  }

  const envDownloadFolder = resolveEnvDownloadFolder();
  if (envDownloadFolder) {
    return envDownloadFolder;
  }

  return defaultPlaylistRoot();
}

export function buildAurralTrackDestination(
  playlistId,
  artistDir,
  albumDir,
  { ephemeral = false } = {},
) {
  const destination = [String(artistDir || "Unknown Artist"), String(albumDir || "Unknown Album")];
  if (ephemeral) destination.unshift(AURRAL_FLOWS_DIR, String(playlistId || ""));
  return path.posix.join(...destination);
}

export function isPathInsideRoot(candidatePath, rootPath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export async function resolveExistingTrackPath(finalPath) {
  const resolved = path.resolve(String(finalPath || "").trim());
  try {
    return (await fs.stat(resolved)).isFile() ? resolved : null;
  } catch {
    return null;
  }
}

import fs from "fs/promises";
import path from "path";
import {
  getStoredDownloadFolderPath,
  resolveDefaultPlaylistDownloadRoot,
  resolveEnvDownloadFolder,
} from "./downloadFolderConfig.js";

export const PLAYLIST_LIBRARY_DIR = "aurral-weekly-flow";
export const AURRAL_FLOWS_DIR = "_flows";
const LEGACY_LIBRARY_DIR = "aurral-weekly-flow";
const PREVIOUS_V2_LIBRARY_DIR = "aurral-playlists";
const LEGACY_DOCKER_PLAYLIST_ROOT = "/app/downloads";

function defaultPlaylistRoot() {
  return resolveDefaultPlaylistDownloadRoot();
}

export function resolvePlaylistRoot(explicitRoot) {
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

export function remapLegacyPath(finalPath, playlistRoot = resolvePlaylistRoot()) {
  let resolved = path.resolve(String(finalPath || "").trim());
  const root = path.resolve(playlistRoot);
  const legacyRoot = path.resolve(LEGACY_DOCKER_PLAYLIST_ROOT);
  if (resolved === legacyRoot || resolved.startsWith(`${legacyRoot}${path.sep}`)) {
    resolved = path.resolve(root, path.relative(legacyRoot, resolved));
  }
  if (resolved.includes(PREVIOUS_V2_LIBRARY_DIR)) {
    resolved = path.resolve(
      root,
      path.relative(root, resolved).replaceAll(PREVIOUS_V2_LIBRARY_DIR, PLAYLIST_LIBRARY_DIR),
    );
  }
  if (resolved.includes(LEGACY_LIBRARY_DIR)) {
    resolved = path.resolve(
      root,
      path.relative(root, resolved).replaceAll(LEGACY_LIBRARY_DIR, PLAYLIST_LIBRARY_DIR),
    );
  }
  return resolved;
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

export async function resolveExistingTrackPath(finalPath, playlistRoot = resolvePlaylistRoot()) {
  const direct = path.resolve(String(finalPath || "").trim());
  const root = path.resolve(playlistRoot);
  const candidates = [...new Set([direct, remapLegacyPath(direct, root)])];

  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) {
        return {
          path: candidate,
          migratedFrom: candidate !== direct ? direct : null,
        };
      }
    } catch {}
  }
  return null;
}

import fs from "fs/promises";
import path from "path";
import {
  getStoredDownloadFolderPath,
  resolveDefaultDownloadRoot,
  resolveEnvDownloadFolder,
} from "./downloadFolderConfig.js";
import { buildTrackFileName, sanitizePathPart } from "./downloadUtils.js";

export const PLAYLIST_FILES_DIR = "aurral-weekly-flow";
export const AURRAL_FLOWS_DIR = "_flows";
const LEGACY_LIBRARY_DIR = "aurral-weekly-flow";
const PREVIOUS_V2_LIBRARY_DIR = "aurral-playlists";
const LEGACY_DOCKER_PLAYLIST_ROOT = "/app/downloads";

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

export function remapLegacyPath(finalPath, playlistRoot = resolveDownloadRoot()) {
  let resolved = path.resolve(String(finalPath || "").trim());
  const root = path.resolve(playlistRoot);
  const legacyRoot = path.resolve(LEGACY_DOCKER_PLAYLIST_ROOT);
  if (resolved === legacyRoot || resolved.startsWith(`${legacyRoot}${path.sep}`)) {
    resolved = path.resolve(root, path.relative(legacyRoot, resolved));
  }
  if (resolved.includes(PREVIOUS_V2_LIBRARY_DIR)) {
    resolved = path.resolve(
      root,
      path.relative(root, resolved).replaceAll(PREVIOUS_V2_LIBRARY_DIR, PLAYLIST_FILES_DIR),
    );
  }
  if (resolved.includes(LEGACY_LIBRARY_DIR)) {
    resolved = path.resolve(
      root,
      path.relative(root, resolved).replaceAll(LEGACY_LIBRARY_DIR, PLAYLIST_FILES_DIR),
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

const folderName = (value, fallback) =>
  sanitizePathPart(sanitizePathPart(value, "").replace(/^\.+/, ""), fallback);

// The Library's naming: Artist/Album/07 - Title.ext, or 2-07 - Title.ext past
// the first disc, under the Downloads Folder.
export function buildLibraryTrackPath(root, track, ext) {
  return path.resolve(
    root,
    buildAurralTrackDestination(
      null,
      folderName(track?.artistName, "Unknown Artist"),
      folderName(track?.albumName, "Unknown Album"),
    ),
    buildTrackFileName(track, String(ext || "").toLowerCase()),
  );
}

export function isPathInsideRoot(candidatePath, rootPath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export async function resolveExistingTrackPath(finalPath, playlistRoot = resolveDownloadRoot()) {
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

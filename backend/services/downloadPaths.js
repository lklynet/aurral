import fs from "fs/promises";
import path from "path";
import {
  getStoredDownloadFolderPath,
  getStoredFlowsFolderPath,
  resolveDefaultDownloadRoot,
  resolveEnvDownloadFolder,
} from "./downloadFolderConfig.js";
import { joinUnderRoot } from "./downloadUtils.js";

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

export function resolveFlowsRoot(downloadRoot = resolveDownloadRoot()) {
  const stored = getStoredFlowsFolderPath();
  return stored ? path.resolve(stored) : path.resolve(downloadRoot, AURRAL_FLOWS_DIR);
}

// Destinations stay root-relative so queued payloads survive setting changes;
// a leading _flows segment resolves against the flows folder instead.
export function resolveTrackDestinationDir(downloadRoot, destination) {
  const parts = String(destination || "").replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts[0] === AURRAL_FLOWS_DIR) {
    return joinUnderRoot(resolveFlowsRoot(downloadRoot), parts.slice(1).join("/"));
  }
  return joinUnderRoot(downloadRoot, destination);
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

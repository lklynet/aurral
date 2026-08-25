import fs from "fs/promises";
import path from "path";
import {
  getStoredDownloadFolderPath,
  resolveDefaultPlaylistDownloadRoot,
  resolveEnvDownloadFolder,
} from "./downloadFolderConfig.js";
import { commitImportToPlaylistLibrary } from "./playlistDownloadUtils.js";

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

export function buildPlaylistDestination(playlistId, artistDir, albumDir) {
  return path.posix.join(
    PLAYLIST_LIBRARY_DIR,
    String(playlistId || "").trim(),
    String(artistDir || "Unknown Artist"),
    String(albumDir || "Unknown Album"),
  );
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

export async function migrateLegacyPaths(playlistRoot = resolvePlaylistRoot(), tracker) {
  if (!tracker?.getAll || !tracker?.setDone) {
    return { scanned: 0, migrated: 0 };
  }

  const jobs = tracker.getAll();
  let migrated = 0;

  const root = path.resolve(playlistRoot);
  const misplacedFiles = new Map();
  for (const job of jobs) {
    if (!job?.finalPath || job.status !== "done") continue;
    const playlistType = String(job.playlistType || "").trim();
    if (
      !playlistType ||
      playlistType === PLAYLIST_LIBRARY_DIR ||
      playlistType.startsWith(".") ||
      path.basename(playlistType) !== playlistType
    ) {
      continue;
    }
    const sourcePath = path.resolve(job.finalPath);
    const barePlaylistRoot = path.resolve(root, playlistType);
    if (!isPathInsideRoot(sourcePath, barePlaylistRoot)) continue;
    try {
      const stat = await fs.stat(sourcePath);
      if (!stat.isFile()) continue;
    } catch {
      continue;
    }
    const targetPath = path.resolve(
      root,
      PLAYLIST_LIBRARY_DIR,
      path.relative(root, sourcePath),
    );
    misplacedFiles.set(sourcePath, { sourcePath, targetPath, barePlaylistRoot });
  }

  const migratedSources = new Set();
  for (const { sourcePath, targetPath, barePlaylistRoot } of misplacedFiles.values()) {
    const committedPath = await commitImportToPlaylistLibrary(sourcePath, targetPath);
    migratedSources.add(sourcePath);
    for (const job of jobs) {
      if (job?.status !== "done" || !job.finalPath) continue;
      if (path.resolve(job.finalPath) !== sourcePath) continue;
      tracker.setDone(
        job.id,
        committedPath,
        job.albumName || null,
        job.externalPath || null,
      );
      migrated += 1;
    }
    let current = path.dirname(sourcePath);
    while (current === barePlaylistRoot || isPathInsideRoot(current, barePlaylistRoot)) {
      try {
        await fs.rmdir(current);
      } catch {
        break;
      }
      if (current === barePlaylistRoot) break;
      current = path.dirname(current);
    }
  }

  for (const job of jobs) {
    if (!job?.finalPath || job.status !== "done") continue;
    if (migratedSources.has(path.resolve(job.finalPath))) continue;
    const resolved = await resolveExistingTrackPath(job.finalPath, playlistRoot);
    if (!resolved?.migratedFrom) continue;
    tracker.setDone(
      job.id,
      resolved.path,
      job.albumName || null,
      job.externalPath || null,
    );
    migrated += 1;
  }
  return { scanned: jobs.length, migrated };
}

import fs from "fs";
import path from "path";
import { resolveAurralDataDir } from "../config/data-dir.js";

let storedDownloadFolderPath = null;

export function syncDownloadFolderPath(value) {
  const normalized = String(value ?? "").trim();
  storedDownloadFolderPath = normalized || null;
}

export function getStoredDownloadFolderPath() {
  return storedDownloadFolderPath;
}

function resolvePathValue(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return null;
  return path.isAbsolute(trimmed)
    ? path.resolve(trimmed)
    : path.resolve(process.cwd(), trimmed);
}

export function resolveEnvDownloadFolder() {
  for (const key of ["PLAYLIST_FOLDER", "WEEKLY_FLOW_FOLDER", "DOWNLOAD_FOLDER"]) {
    const resolved = resolvePathValue(process.env[key]);
    if (resolved) return resolved;
  }
  return null;
}

export function resolveDefaultPlaylistDownloadRoot() {
  const envDownloadFolder = resolveEnvDownloadFolder();
  if (envDownloadFolder) {
    return envDownloadFolder;
  }
  if (fs.existsSync("/data")) {
    return "/data/downloads/aurral";
  }
  return path.join(
    path.resolve(resolveAurralDataDir(), "..", "downloads"),
    "aurral",
  );
}

export function getSuggestedDownloadFolderPath() {
  return resolveDefaultPlaylistDownloadRoot();
}

function isExistingDirectory(targetPath) {
  try {
    return fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
}

export function getFilesystemBrowseRoots() {
  const configured = String(process.env.FILE_BROWSE_ROOTS || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => resolvePathValue(entry))
    .filter((entry) => isExistingDirectory(entry));
  if (configured.length) {
    return [...new Set(configured.map((entry) => fs.realpathSync(entry)))];
  }
  if (isExistingDirectory("/")) {
    return [path.resolve("/")];
  }
  const roots = [];
  if (isExistingDirectory("/data")) {
    roots.push(fs.realpathSync("/data"));
  }
  const defaultRoot = defaultPlaylistRoot();
  if (isExistingDirectory(defaultRoot)) {
    roots.push(fs.realpathSync(defaultRoot));
  }
  if (isExistingDirectory(process.cwd())) {
    roots.push(fs.realpathSync(process.cwd()));
  }
  return [...new Set(roots)];
}

export function formatBrowseDisplayPath(pathValue) {
  if (!pathValue || pathValue === "/") {
    return "";
  }
  const normalized = path.resolve(pathValue);
  return normalized.endsWith(path.sep) ? normalized : `${normalized}${path.sep}`;
}

export function normalizeSelectedFolderPath(pathValue) {
  const resolved = resolvePathValue(pathValue);
  if (!resolved) {
    return null;
  }
  if (resolved === path.sep || resolved === "/") {
    return "/";
  }
  return resolved.replace(/[/\\]+$/, "");
}

function isFilesystemRoot(resolvedRoot) {
  return resolvedRoot === path.sep || resolvedRoot === "/";
}

function resolveRealPathIfExists(targetPath) {
  const resolved = path.resolve(targetPath);
  if (!fs.existsSync(resolved)) {
    return null;
  }
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function isPathWithinRoot(candidate, root) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  if (isFilesystemRoot(resolvedRoot)) {
    return path.isAbsolute(resolvedCandidate);
  }
  const realRoot = resolveRealPathIfExists(resolvedRoot) || resolvedRoot;
  if (
    resolvedCandidate === resolvedRoot ||
    resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`) ||
    resolvedCandidate.startsWith(`${realRoot}${path.sep}`)
  ) {
    return true;
  }
  let current = resolvedCandidate;
  while (current && current !== path.dirname(current)) {
    const realCurrent = resolveRealPathIfExists(current);
    if (realCurrent) {
      return (
        realCurrent === realRoot ||
        realCurrent.startsWith(`${realRoot}${path.sep}`)
      );
    }
    current = path.dirname(current);
  }
  return false;
}

function isRealPathWithinRoot(realTarget, realRoot) {
  if (isFilesystemRoot(realRoot)) {
    return (
      realTarget === realRoot ||
      (path.isAbsolute(realTarget) && realTarget.startsWith(path.sep))
    );
  }
  return (
    realTarget === realRoot ||
    realTarget.startsWith(`${realRoot}${path.sep}`)
  );
}

export function resolveSafeBrowsePath(requestedPath, roots = getFilesystemBrowseRoots()) {
  const allowedRoots = (Array.isArray(roots) ? roots : [])
    .map((entry) => resolvePathValue(entry))
    .filter(Boolean);
  if (!allowedRoots.length) {
    return null;
  }

  const fallback = allowedRoots[0];
  const target = resolvePathValue(requestedPath) || fallback;

  for (const root of allowedRoots) {
    if (!isPathWithinRoot(target, root)) {
      continue;
    }
    try {
      if (fs.existsSync(target)) {
        const realTarget = fs.realpathSync(target);
        const realRoot = fs.realpathSync(root);
        if (isRealPathWithinRoot(realTarget, realRoot)) {
          return realTarget;
        }
        continue;
      }
      return target;
    } catch {
      return target;
    }
  }
  return null;
}

export function validateDownloadFolderPath(
  requestedPath,
  _roots = getFilesystemBrowseRoots(),
  { create = false } = {},
) {
  const resolved = normalizeSelectedFolderPath(requestedPath);
  if (!resolved) {
    return {
      valid: false,
      error: "Path must be an absolute path.",
    };
  }
  if (!fs.existsSync(resolved)) {
    if (!create) {
      return {
        valid: false,
        error: "Path does not exist.",
      };
    }
    fs.mkdirSync(resolved, { recursive: true });
  }
  if (!fs.statSync(resolved).isDirectory()) {
    return {
      valid: false,
      error: "Path must be a directory.",
    };
  }
  return { valid: true, path: resolved };
}

export function ensureDownloadFolderPath(requestedPath) {
  const normalized = normalizeSelectedFolderPath(requestedPath);
  if (!normalized) {
    return {
      valid: false,
      error: "Path must be an absolute path.",
    };
  }
  if (!resolveSafeBrowsePath(normalized)) {
    return {
      valid: false,
      error: "Path is outside the allowed storage roots.",
    };
  }
  const existed = isExistingDirectory(normalized);
  const result = validateDownloadFolderPath(normalized, undefined, { create: true });
  if (!result.valid) {
    return result;
  }
  return { ...result, created: !existed };
}

export function resolveExistingBrowsePath(
  requestedPath,
  roots = getFilesystemBrowseRoots(),
) {
  const allowedRoots = getFilesystemBrowseRoots();
  if (!allowedRoots.length) {
    return null;
  }

  const safeTarget = resolveSafeBrowsePath(requestedPath, allowedRoots);
  const candidates = [];
  if (safeTarget) {
    candidates.push(safeTarget);
    let parent = path.dirname(safeTarget);
    while (parent && parent !== path.dirname(parent)) {
      candidates.push(parent);
      parent = path.dirname(parent);
    }
  }
  candidates.push(...allowedRoots);

  for (const candidate of candidates) {
    if (!isExistingDirectory(candidate)) {
      continue;
    }
    const resolved = resolveSafeBrowsePath(candidate, allowedRoots);
    if (!resolved || !isExistingDirectory(resolved)) {
      continue;
    }
    return fs.realpathSync(resolved);
  }
  return null;
}

export function listBrowseDirectory(requestedPath, roots = getFilesystemBrowseRoots()) {
  const allowedRoots = getFilesystemBrowseRoots();
  if (!allowedRoots.length) {
    throw new Error(
      "No browsable storage path is available. Mount a shared folder such as /data into the container.",
    );
  }
  const pathValue = resolveExistingBrowsePath(requestedPath, allowedRoots);
  if (!pathValue) {
    throw new Error("No browsable storage path is available.");
  }

  const parent = allowedRoots.some((root) => pathValue === root)
    ? null
    : resolveExistingBrowsePath(path.dirname(pathValue), allowedRoots);

  const entries = fs
    .readdirSync(pathValue, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => ({
      name: entry.name,
      path: path.resolve(pathValue, entry.name),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

  const suggestedDownloadFolder = getSuggestedDownloadFolderPath();
  return {
    path: pathValue,
    displayPath: formatBrowseDisplayPath(pathValue),
    parent,
    roots: allowedRoots,
    suggestedDownloadFolder,
    suggestedDownloadFolderExists: isExistingDirectory(suggestedDownloadFolder),
    entries,
  };
}

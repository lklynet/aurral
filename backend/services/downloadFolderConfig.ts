import fs from "fs";
import path from "path";
import { resolveAurralDataDir } from "../config/data-dir.ts";
import type { StoredIntegrations } from "../db/helpers/settings.ts";
import { getPathMappings, resolveLocalPath } from "./pathMappings.ts";
import { stripTrailingSeparators } from "./textUtils.ts";

let storedDownloadFolderPath: string | null = null;

export function syncDownloadFolderPath(value: unknown) {
  const normalized = String(value ?? "").trim();
  storedDownloadFolderPath = normalized || null;
}

export function getStoredDownloadFolderPath() {
  return storedDownloadFolderPath;
}

function resolvePathValue(raw: unknown) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return null;
  return path.isAbsolute(trimmed) ? path.resolve(trimmed) : path.resolve(process.cwd(), trimmed);
}

export function resolveEnvDownloadFolder() {
  for (const key of ["PLAYLIST_FOLDER", "WEEKLY_FLOW_FOLDER", "DOWNLOAD_FOLDER"]) {
    const resolved = resolvePathValue(process.env[key]);
    if (resolved) return resolved;
  }
  return null;
}

function isWritableDirectory(targetPath: string) {
  try {
    return (
      fs.statSync(targetPath).isDirectory() &&
      fs.accessSync(targetPath, fs.constants.W_OK | fs.constants.X_OK) === undefined
    );
  } catch {
    return false;
  }
}

export function resolveDefaultDownloadRoot({ dataRoot = "/data" }: { dataRoot?: string } = {}) {
  const envDownloadFolder = resolveEnvDownloadFolder();
  if (envDownloadFolder) {
    return envDownloadFolder;
  }
  if (isWritableDirectory(dataRoot)) {
    return path.join(dataRoot, "downloads", "aurral");
  }
  return path.join(resolveAurralDataDir(), "downloads", "aurral");
}

export function getSuggestedDownloadFolderPath() {
  return resolveDefaultDownloadRoot();
}

export function resolveYtdlpStagingRoot(configuredPath?: string) {
  return resolvePathValue(configuredPath) || path.join(resolveAurralDataDir(), "_staging");
}

function isExistingDirectory(targetPath: string) {
  try {
    return fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
}

export function getFilesystemBrowseRoots(): string[] {
  const configured = String(process.env.FILE_BROWSE_ROOTS || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => resolvePathValue(entry) as string)
    .filter((entry) => isExistingDirectory(entry));
  if (configured.length) {
    return [...new Set(configured.map((entry) => fs.realpathSync(entry)))];
  }

  const roots = [];
  if (isExistingDirectory("/data")) {
    roots.push(fs.realpathSync("/data"));
  }
  const dataDir = resolveAurralDataDir();
  if (isExistingDirectory(dataDir)) {
    roots.push(fs.realpathSync(dataDir));
  }
  const envDownloadFolder = resolveEnvDownloadFolder();
  if (envDownloadFolder && isExistingDirectory(envDownloadFolder)) {
    roots.push(fs.realpathSync(envDownloadFolder));
  }
  const defaultRoot = resolveDefaultDownloadRoot();
  if (isExistingDirectory(defaultRoot)) {
    roots.push(fs.realpathSync(defaultRoot));
  }
  if (isExistingDirectory(process.cwd())) {
    roots.push(fs.realpathSync(process.cwd()));
  }
  const uniqueRoots = [...new Set(roots)];
  if (uniqueRoots.length) {
    return uniqueRoots;
  }
  if (isExistingDirectory("/")) {
    return [path.resolve("/")];
  }
  return [];
}

export function formatBrowseDisplayPath(pathValue: string) {
  if (!pathValue || pathValue === "/") {
    return "";
  }
  const normalized = path.resolve(pathValue);
  return normalized.endsWith(path.sep) ? normalized : `${normalized}${path.sep}`;
}

export function normalizeSelectedFolderPath(pathValue: unknown) {
  const resolved = resolvePathValue(pathValue);
  if (!resolved) {
    return null;
  }
  if (resolved === path.sep || resolved === "/") {
    return "/";
  }
  return stripTrailingSeparators(resolved);
}

function isFilesystemRoot(resolvedRoot: string) {
  return resolvedRoot === path.sep || resolvedRoot === "/";
}

function resolveRealPathIfExists(targetPath: string) {
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

function isPathWithinRoot(candidate: string, root: string) {
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
      return realCurrent === realRoot || realCurrent.startsWith(`${realRoot}${path.sep}`);
    }
    current = path.dirname(current);
  }
  return false;
}

function isRealPathWithinRoot(realTarget: string, realRoot: string) {
  if (isFilesystemRoot(realRoot)) {
    return (
      realTarget === realRoot || (path.isAbsolute(realTarget) && realTarget.startsWith(path.sep))
    );
  }
  return realTarget === realRoot || realTarget.startsWith(`${realRoot}${path.sep}`);
}

export function resolveSafeBrowsePath(
  requestedPath: unknown,
  roots: string[] = getFilesystemBrowseRoots(),
) {
  const allowedRoots = (Array.isArray(roots) ? roots : [])
    .map((entry) => resolvePathValue(entry))
    .filter(Boolean) as string[];
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
  requestedPath: unknown,
  _roots: string[] = getFilesystemBrowseRoots(),
  { create = false }: { create?: boolean } = {},
): { valid: true; path: string } | { valid: false; error: string } {
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

export function ensureDownloadFolderPath(
  requestedPath: unknown,
): { valid: true; path: string; created: boolean } | { valid: false; error: string } {
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
  requestedPath: unknown,
  _roots: string[] = getFilesystemBrowseRoots(),
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

export function listBrowseDirectory(
  requestedPath: unknown,
  _roots: string[] = getFilesystemBrowseRoots(),
) {
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

function normalizeRootForCompare(value: unknown) {
  let normalized = String(value || "")
    .trim()
    .split("\\")
    .join("/");
  if (!normalized) return "";
  while (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function compareRoots(left: string, right: string) {
  const a = normalizeRootForCompare(left);
  const b = normalizeRootForCompare(right);
  if (!a || !b) return "disjoint";
  if (a === b) return "equal";
  const aPrefix = a.endsWith("/") ? a : `${a}/`;
  const bPrefix = b.endsWith("/") ? b : `${b}/`;
  if (b.startsWith(aPrefix)) return "nested-b-in-a";
  if (a.startsWith(bPrefix)) return "nested-a-in-b";
  return "disjoint";
}

export function getOverlapCheckedLidarrRoots(lidarrSettings: StoredIntegrations["lidarr"] = {}) {
  if (lidarrSettings?.enabled === false) return [];
  const mappings = getPathMappings("lidarr");
  return (
    [
      ...(Array.isArray(lidarrSettings?.rootFolderPaths) ? lidarrSettings.rootFolderPaths : []),
      lidarrSettings?.rootFolderPath,
    ].filter(Boolean) as string[]
  ).map((root) => resolveLocalPath(root, mappings));
}

export function computeLibraryRootOverlaps({
  aurralRoot,
  lidarrRoots,
}: { aurralRoot?: unknown; lidarrRoots?: unknown } = {}) {
  const resolvedAurralRoot = String(aurralRoot || "").trim();
  if (!resolvedAurralRoot) return [];
  const candidates = (Array.isArray(lidarrRoots) ? lidarrRoots : [lidarrRoots])
    .map((root) => String(root || "").trim())
    .filter(Boolean);
  const warnings = [];
  const seen = new Set<string>();
  for (const lidarrRoot of candidates) {
    const relation = compareRoots(resolvedAurralRoot, lidarrRoot);
    if (relation === "disjoint" || seen.has(`${relation}:${lidarrRoot}`)) {
      continue;
    }
    seen.add(`${relation}:${lidarrRoot}`);
    warnings.push({
      type: relation,
      lidarrRoot,
      message:
        relation === "equal"
          ? "The Lidarr root folder is the Downloads Folder. Aurral treats every file there as Lidarr's and never deletes it."
          : relation === "nested-b-in-a"
            ? "The Lidarr root folder is inside the Downloads Folder. Aurral leaves that folder to Lidarr while Lidarr is on."
            : "The Downloads Folder is inside the Lidarr root folder. Lidarr can rename, import, or delete Aurral's downloads.",
    });
  }
  return warnings;
}

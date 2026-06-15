import fs from "fs";
import path from "path";
import { getFilesystemBrowseRoots } from "./downloadFolderConfig.js";
import { resolvePlaylistRoot } from "./playlistPaths.js";

let storedPathMappings = [];

export function syncPathMappings(value) {
  storedPathMappings = normalizePathMappings(value);
}

function normalizePathSeparators(value) {
  return String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
}

function normalizePathMappingEntry(entry) {
  const remote = normalizePathSeparators(entry?.remote);
  const local = path.resolve(String(entry?.local || "").trim());
  if (!remote || !local) return null;
  return { remote, local };
}

export function normalizePathMappings(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const result = [];
  for (const entry of value) {
    const normalized = normalizePathMappingEntry(entry);
    if (!normalized) continue;
    const key = `${normalized.remote.toLowerCase()}\0${normalized.local}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result.sort((left, right) => right.remote.length - left.remote.length);
}

export function parsePathMappingsEnv() {
  const raw = String(process.env.PATH_MAPPINGS || "").trim();
  if (!raw) return [];
  return normalizePathMappings(
    raw
      .split(";")
      .map((segment) => {
        const pipe = segment.indexOf("|");
        if (pipe === -1) return null;
        return {
          remote: segment.slice(0, pipe).trim(),
          local: segment.slice(pipe + 1).trim(),
        };
      })
      .filter(Boolean),
  );
}

export function getPathMappings() {
  return normalizePathMappings([...storedPathMappings, ...parsePathMappingsEnv()]);
}

export function looksLikeExternalOnlyPath(value) {
  const trimmed = String(value || "").trim();
  return /^[A-Za-z]:[\\/]/.test(trimmed) || /^\\\\/.test(trimmed);
}

function getLocalSearchRoots() {
  const roots = new Set();
  for (const entry of getFilesystemBrowseRoots()) {
    const resolved = path.resolve(String(entry || "").trim());
    if (resolved) roots.add(resolved);
  }
  try {
    const playlistRoot = path.resolve(resolvePlaylistRoot());
    if (playlistRoot) roots.add(playlistRoot);
  } catch {}
  return [...roots];
}

function pathExists(targetPath) {
  try {
    return fs.existsSync(targetPath);
  } catch {
    return false;
  }
}

function resolveBySuffixWalk(externalPath, localRoots = getLocalSearchRoots()) {
  const parts = normalizePathSeparators(externalPath).split("/").filter(Boolean);
  if (parts.length < 2) return null;

  for (const base of localRoots) {
    for (let index = 1; index < parts.length; index += 1) {
      const candidate = path.join(base, ...parts.slice(index));
      if (pathExists(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

function pathMatchesPrefix(candidate, prefix) {
  const normalizedCandidate = normalizePathSeparators(candidate);
  const normalizedPrefix = normalizePathSeparators(prefix);
  if (!normalizedCandidate || !normalizedPrefix) return false;
  if (normalizedCandidate.toLowerCase() === normalizedPrefix.toLowerCase()) {
    return true;
  }
  return normalizedCandidate
    .toLowerCase()
    .startsWith(`${normalizedPrefix.toLowerCase()}/`);
}

export function resolveLocalPath(externalPath, mappings = getPathMappings()) {
  const raw = String(externalPath || "").trim();
  if (!raw) return raw;

  const resolvedRaw = path.resolve(raw);
  if (pathExists(resolvedRaw)) {
    return resolvedRaw;
  }

  const normalized = raw.replace(/\\/g, "/");
  for (const mapping of mappings) {
    if (!pathMatchesPrefix(normalized, mapping.remote)) continue;
    const remoteNorm = normalizePathSeparators(mapping.remote);
    const suffix = normalized.slice(remoteNorm.length).replace(/^\//, "");
    return suffix
      ? path.resolve(mapping.local, ...suffix.split("/"))
      : path.resolve(mapping.local);
  }

  const suffixResolved = resolveBySuffixWalk(raw);
  if (suffixResolved) {
    return suffixResolved;
  }

  return resolvedRaw;
}

export function resolveRemotePath(localPath, mappings = getPathMappings()) {
  const raw = String(localPath || "").trim();
  if (!raw) return raw;

  const resolved = path.resolve(raw);
  const normalized = resolved.replace(/\\/g, "/");

  for (const mapping of mappings) {
    const localNorm = path.resolve(mapping.local).replace(/\\/g, "/");
    if (!pathMatchesPrefix(normalized, localNorm)) continue;
    const suffix = normalized.slice(localNorm.length).replace(/^\//, "");
    const remoteBase = normalizePathSeparators(mapping.remote);
    return suffix
      ? `${remoteBase}/${suffix.split("/").join("/")}`
      : remoteBase;
  }

  return resolved;
}

export function inferPathMappingForExternalPath(externalPath, localRoots) {
  const norm = normalizePathSeparators(externalPath);
  const parts = norm.split("/").filter(Boolean);
  if (parts.length < 2) return null;

  const roots = (Array.isArray(localRoots) ? localRoots : [])
    .map((entry) => path.resolve(String(entry || "").trim()))
    .filter(Boolean);
  if (!roots.length) return null;

  for (const localRoot of roots) {
    for (let index = parts.length - 1; index >= 1; index -= 1) {
      const suffixParts = parts.slice(index);
      const localCandidate = path.join(localRoot, ...suffixParts);
      try {
        if (fs.existsSync(localCandidate)) {
          return {
            remote: parts.slice(0, index).join("/"),
            local: localRoot,
          };
        }
      } catch {}
    }
  }

  return null;
}

export function inferPathMappings(externalPaths, localRoots = getFilesystemBrowseRoots()) {
  const mappings = [];
  const seen = new Set();
  for (const externalPath of externalPaths) {
    const trimmed = String(externalPath || "").trim();
    if (!trimmed) continue;
    const inferred = inferPathMappingForExternalPath(trimmed, localRoots);
    if (!inferred) continue;
    const key = inferred.remote.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    mappings.push(inferred);
  }
  return normalizePathMappings(mappings);
}

export async function verifyMappedPath(externalPath, mappings = getPathMappings()) {
  const localPath = resolveLocalPath(externalPath, mappings);
  try {
    await fs.promises.access(localPath, fs.constants.R_OK);
    return { ok: true, localPath };
  } catch {
    return { ok: false, localPath };
  }
}

export async function detectPathMappings({
  externalPaths = [],
  samplePaths = [],
  localRoots = getFilesystemBrowseRoots(),
} = {}) {
  const inferred = inferPathMappings(externalPaths, localRoots);
  if (!inferred.length) {
    return { mappings: [], verified: false };
  }

  const samples = [...samplePaths, ...externalPaths].filter(Boolean);
  if (!samples.length) {
    return { mappings: inferred, verified: false };
  }

  for (const samplePath of samples) {
    const result = await verifyMappedPath(samplePath, inferred);
    if (result.ok) {
      return { mappings: inferred, verified: true, sampleLocalPath: result.localPath };
    }
  }

  return { mappings: inferred, verified: false };
}

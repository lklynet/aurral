import fs from "fs";
import path from "path";

let storedPathMappings = [];
const PATH_MAPPING_SOURCES = new Set([
  "all",
  "lidarr",
  "slskd",
  "nzbget",
  "sabnzbd",
  "deemix",
  "plex",
  "jellyfin",
]);

export function syncPathMappings(value) {
  storedPathMappings = normalizePathMappings(value);
}

function normalizePathSeparators(value) {
  return String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
}

export function normalizePathMappingSource(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return PATH_MAPPING_SOURCES.has(normalized) ? normalized : "all";
}

function isExplicitPathMappingSource(value) {
  return PATH_MAPPING_SOURCES.has(
    String(value || "")
      .trim()
      .toLowerCase(),
  );
}

function normalizePathMappingEntry(entry) {
  const source = normalizePathMappingSource(entry?.source);
  const remote = normalizePathSeparators(entry?.remote);
  const localRaw = String(entry?.local || "").trim();
  if (!remote || !localRaw) return null;
  const local = path.resolve(localRaw);
  return { source, remote, local };
}

export function normalizePathMappings(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const result = [];
  for (const entry of value) {
    const normalized = normalizePathMappingEntry(entry);
    if (!normalized) continue;
    const key = `${normalized.source}\0${normalized.remote.toLowerCase()}\0${normalized.local}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result.sort((left, right) => {
    const lengthDiff = right.remote.length - left.remote.length;
    if (lengthDiff !== 0) return lengthDiff;
    if (left.source !== right.source) {
      if (left.source === "all") return 1;
      if (right.source === "all") return -1;
      return left.source.localeCompare(right.source);
    }
    return left.remote.localeCompare(right.remote);
  });
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
        const first = segment.slice(0, pipe).trim();
        const rest = segment.slice(pipe + 1);
        if (isExplicitPathMappingSource(first)) {
          const secondPipe = rest.indexOf("|");
          if (secondPipe === -1) return null;
          return {
            source: first,
            remote: rest.slice(0, secondPipe).trim(),
            local: rest.slice(secondPipe + 1).trim(),
          };
        }
        return { source: "all", remote: first, local: rest.trim() };
      })
      .filter(Boolean),
  );
}

export function getPathMappings(source = null) {
  const mappings = normalizePathMappings([...storedPathMappings, ...parsePathMappingsEnv()]);
  if (!source) return mappings;
  const normalizedSource = normalizePathMappingSource(source);
  return mappings.filter((entry) => entry.source === "all" || entry.source === normalizedSource);
}

export function looksLikeExternalOnlyPath(value) {
  const trimmed = String(value || "").trim();
  return /^[A-Za-z]:[\\/]/.test(trimmed) || /^\\\\/.test(trimmed);
}

function pathExists(targetPath) {
  try {
    return fs.existsSync(targetPath);
  } catch {
    return false;
  }
}

function pathMatchesPrefix(candidate, prefix) {
  const normalizedCandidate = normalizePathSeparators(candidate);
  const normalizedPrefix = normalizePathSeparators(prefix);
  if (!normalizedCandidate || !normalizedPrefix) return false;
  if (normalizedCandidate.toLowerCase() === normalizedPrefix.toLowerCase()) {
    return true;
  }
  return normalizedCandidate.toLowerCase().startsWith(`${normalizedPrefix.toLowerCase()}/`);
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
    return suffix ? path.resolve(mapping.local, ...suffix.split("/")) : path.resolve(mapping.local);
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
    return suffix ? `${remoteBase}/${suffix.split("/").join("/")}` : remoteBase;
  }

  return resolved;
}

import fs from "node:fs";
import path from "node:path";
import { isPathWithin } from "../libraryFolders.ts";
import {
  normalizePathSeparators,
  pathMatchesPrefix,
  resolveRemotePath,
  type PathMapping,
} from "../pathMappings.ts";

const MAX_FOLDERS_PER_ROOT = 20;

const deepest = <T>(candidates: readonly T[], length: (candidate: T) => number): T | undefined =>
  [...candidates].sort((left, right) => length(right) - length(left))[0];

function existingFolder(value: string, root: string) {
  let candidate = value;
  while (candidate !== root && !fs.statSync(candidate, { throwIfNoEntry: false })?.isDirectory()) {
    candidate = path.dirname(candidate);
  }
  return candidate;
}

function hasKeptAncestor(folder: string, root: string, kept: Set<string>) {
  for (let current = folder; current !== root;) {
    const parent = path.dirname(current);
    if (parent === current) return false;
    if (kept.has(parent)) return true;
    current = parent;
  }
  return false;
}

function withoutNested(folders: Set<string>, root: string) {
  const kept = new Set<string>();
  for (const folder of [...folders].sort()) {
    if (!hasKeptAncestor(folder, root, kept)) kept.add(folder);
  }
  return [...kept];
}

function widenedPastLimit(folders: Set<string>, root: string) {
  const kept = withoutNested(folders, root);
  return new Set(kept.length > MAX_FOLDERS_PER_ROOT ? [root] : kept);
}

const deepestRoot = (value: string, roots: readonly string[]) =>
  deepest(
    roots.filter((root) => isPathWithin(root, value)),
    (root) => root.length,
  );

export function claimUnmatchedRootWarning(
  warnedRoots: Set<string>,
  folder: string,
  aurralRoots: readonly string[],
  mappings: PathMapping[],
) {
  const key = JSON.stringify([deepestRoot(folder, aurralRoots) ?? folder, mappings]);
  if (warnedRoots.has(key)) return false;
  warnedRoots.add(key);
  return true;
}

export function scanFoldersForPaths(
  paths: readonly (string | null | undefined)[],
  roots: readonly string[],
) {
  const resolvedRoots = roots.map((root) => path.resolve(root));
  const byRoot = new Map<string, Set<string>>();
  const changed = new Set(
    paths
      .map((item) => String(item || "").trim())
      .filter(Boolean)
      .map((item) => path.resolve(item)),
  );
  for (const value of changed) {
    const root = deepestRoot(value, resolvedRoots);
    if (!root) continue;
    const folders = byRoot.get(root) ?? new Set();
    if (folders.has(root)) continue;
    folders.add(existingFolder(value, root));
    byRoot.set(
      root,
      folders.size > MAX_FOLDERS_PER_ROOT ? widenedPastLimit(folders, root) : folders,
    );
  }
  return [...byRoot].flatMap(([root, folders]) => withoutNested(folders, root)).sort();
}

export function joinServerPath(root: string, relative: string) {
  const separator = String(root).includes("\\") ? "\\" : "/";
  const base = String(root).replace(/[\\/]+$/, "");
  return relative ? `${base}${separator}${relative.split(/[\\/]/).join(separator)}` : root;
}

const isServerPathWithin = (root: string, serverPath: string) =>
  serverPath === root || serverPath.startsWith(`${root}/`);

export function serverScanTargets<T extends { path: string }>(
  folders: readonly string[],
  roots: readonly T[],
  mappings: PathMapping[],
) {
  const targets = [];
  for (const folder of folders) {
    const serverPath = normalizePathSeparators(resolveRemotePath(folder, mappings));
    const matching = roots.filter((candidate) => pathMatchesPrefix(serverPath, candidate.path));
    const exactCase = matching.filter((candidate) =>
      isServerPathWithin(normalizePathSeparators(candidate.path), serverPath),
    );
    const root = deepest(
      exactCase.length ? exactCase : matching,
      (candidate) => normalizePathSeparators(candidate.path).length,
    );
    if (!root) return { unmatched: { folder, serverPath } };
    const relative = serverPath.slice(normalizePathSeparators(root.path).length).replace(/^\//, "");
    targets.push({ root, relative, path: joinServerPath(root.path, relative) });
  }
  return { targets };
}

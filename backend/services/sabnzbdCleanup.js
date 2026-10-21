import fs from "node:fs/promises";
import path from "node:path";
import { isPathInsideRoot, resolveDownloadRoot } from "./downloadPaths.js";
import { lidarrClient } from "./lidarrClient.js";
import { getPathMappings, resolveLocalPath } from "./pathMappings.js";

const realpathOr = (dir) => fs.realpath(dir).catch(() => dir);

function safePathParts(value) {
  const parts = String(value || "").split(/[\\/]/);
  return parts.length > 0 && parts.every((part) => part && part !== "." && part !== "..")
    ? parts
    : [];
}

function isAbsoluteExternalPath(value) {
  const raw = String(value || "").trim();
  return path.isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw) || /^\\\\/.test(raw);
}

export async function removeSabnzbdDownloadFolder(historyItem, directories, category) {
  const storage = String(historyItem?.storage || "").trim();
  if (!storage) return;

  const mappings = getPathMappings("sabnzbd");
  const toLocal = (value) => {
    const raw = String(value || "").trim();
    if (!raw) return null;
    const local = resolveLocalPath(raw, mappings);
    return path.isAbsolute(raw) || local !== path.resolve(raw) ? local : null;
  };
  const target = toLocal(storage);
  if (!target) throw new Error("SABnzbd download folder is missing or unmapped");

  const stat = await fs.lstat(target).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!stat) return;
  if (!stat.isDirectory()) throw new Error("SABnzbd download folder is not a directory");

  const roots = [directories.completedPath, directories.destDir].map(toLocal).filter(Boolean);
  const categoryDestDir = String(directories.categoryDestDir || "").trim();
  const categoryDestParts = safePathParts(categoryDestDir);
  const configuredCategoryDirs = isAbsoluteExternalPath(categoryDestDir)
    ? [toLocal(categoryDestDir)].filter(Boolean)
    : categoryDestParts.length
      ? roots.map((root) => path.join(root, ...categoryDestParts))
      : [];
  const categoryParts = safePathParts(category);
  const defaultCategoryDirs = categoryParts.length
    ? roots.map((root) => path.join(root, ...categoryParts))
    : [];
  const parents = await Promise.all(
    [...roots, ...configuredCategoryDirs, ...defaultCategoryDirs].map(realpathOr),
  );
  const realTarget = path.join(await fs.realpath(path.dirname(target)), path.basename(target));
  if (!parents.includes(path.dirname(realTarget)) || parents.includes(realTarget)) {
    throw new Error("SABnzbd download folder is not inside SABnzbd's completed folders");
  }

  const libraries = [
    resolveDownloadRoot(),
    ...(lidarrClient.isEnabled()
      ? lidarrClient
          .getConfiguredRootFolderPaths()
          .map((root) => resolveLocalPath(root, getPathMappings("lidarr")))
      : []),
  ].filter(Boolean);
  for (const library of await Promise.all(
    libraries.map((root) => realpathOr(path.resolve(root))),
  )) {
    if (
      library === realTarget ||
      isPathInsideRoot(library, realTarget) ||
      isPathInsideRoot(realTarget, library)
    ) {
      throw new Error("SABnzbd download folder overlaps a music library");
    }
  }

  await fs.rm(realTarget, { recursive: true, force: true });
}

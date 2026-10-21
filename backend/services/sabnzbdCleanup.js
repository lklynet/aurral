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

function appendExternalPath(root, parts) {
  const raw = String(root || "").trim();
  const base = raw.replace(/[\\/]+$/, "");
  return `${base || (raw.startsWith("/") ? "/" : "")}${base ? "/" : ""}${parts.join("/")}`;
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

  const rootPaths = [directories.completedPath, directories.destDir]
    .map((root) => String(root || "").trim())
    .filter(Boolean);
  const roots = rootPaths.map(toLocal).filter(Boolean);
  const categoryDestDir = String(directories.categoryDestDir || "").trim();
  const categoryDestParts = safePathParts(categoryDestDir);
  const configuredCategoryDirs = isAbsoluteExternalPath(categoryDestDir)
    ? [toLocal(categoryDestDir)].filter(Boolean)
    : categoryDestParts.length
      ? rootPaths
          .map((root) => toLocal(appendExternalPath(root, categoryDestParts)))
          .filter(Boolean)
      : [];
  const categoryParts = safePathParts(category);
  const defaultCategoryDirs = categoryParts.length
    ? rootPaths.map((root) => toLocal(appendExternalPath(root, categoryParts))).filter(Boolean)
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
    ...lidarrClient
      .getConfiguredRootFolderPaths()
      .map((root) => resolveLocalPath(root, getPathMappings("lidarr"))),
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

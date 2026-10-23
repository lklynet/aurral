import fs from "node:fs/promises";
import path from "node:path";
import { isPathInsideRoot, resolveDownloadRoot } from "./downloadPaths.ts";
import { lidarrClient } from "./lidarrClient.ts";
import { asAppError } from "../../lib/errors.ts";
import { getPathMappings, resolveLocalPath } from "./pathMappings.ts";

const isPresent = (value: string | null): value is string => Boolean(value);

const realpathOr = (dir: string) => fs.realpath(dir).catch(() => dir);

function safePathParts(value: unknown) {
  const parts = String(value || "").split(/[\\/]/);
  return parts.length > 0 && parts.every((part) => part && part !== "." && part !== "..")
    ? parts
    : [];
}

function isAbsoluteExternalPath(value: unknown) {
  const raw = String(value || "").trim();
  return path.isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw) || /^\\\\/.test(raw);
}

function appendExternalPath(root: unknown, parts: string[]) {
  const raw = String(root || "").trim();
  const base = raw.replace(/[\\/]+$/, "");
  return `${base || (raw.startsWith("/") ? "/" : "")}${base ? "/" : ""}${parts.join("/")}`;
}

type SabnzbdDirectories = {
  completedPath?: unknown;
  destDir?: unknown;
  categoryDestDir?: unknown;
};

export async function removeSabnzbdDownloadFolder(
  historyItem: { storage?: string | null } | null | undefined,
  directories: SabnzbdDirectories,
  category: unknown,
  client: { key: string; name: string },
) {
  const storage = String(historyItem?.storage || "").trim();
  if (!storage) return;

  const mappings = getPathMappings(client.key);
  const toLocal = (value: unknown) => {
    const raw = String(value || "").trim();
    if (!raw) return null;
    const local = resolveLocalPath(raw, mappings);
    return path.isAbsolute(raw) || local !== path.resolve(raw) ? local : null;
  };
  const target = toLocal(storage);
  if (!target) throw new Error(`${client.name} download folder is missing or unmapped`);

  const stat = await fs.lstat(target).catch((error) => {
    if (asAppError(error)?.code === "ENOENT") return null;
    throw error;
  });
  if (!stat) return;
  if (!stat.isDirectory()) throw new Error(`${client.name} download folder is not a directory`);

  const rootPaths = [directories.completedPath, directories.destDir]
    .map((root) => String(root || "").trim())
    .filter(Boolean);
  const roots = rootPaths.map(toLocal).filter(isPresent);
  const categoryDestDir = String(directories.categoryDestDir || "").trim();
  const categoryDestParts = safePathParts(categoryDestDir);
  const configuredCategoryDirs = isAbsoluteExternalPath(categoryDestDir)
    ? [toLocal(categoryDestDir)].filter(isPresent)
    : categoryDestParts.length
      ? rootPaths
          .map((root) => toLocal(appendExternalPath(root, categoryDestParts)))
          .filter(isPresent)
      : [];
  const categoryParts = safePathParts(category);
  const defaultCategoryDirs = categoryParts.length
    ? rootPaths.map((root) => toLocal(appendExternalPath(root, categoryParts))).filter(isPresent)
    : [];
  const parents = await Promise.all(
    [...roots, ...configuredCategoryDirs, ...defaultCategoryDirs].map(realpathOr),
  );
  const realTarget = path.join(await fs.realpath(path.dirname(target)), path.basename(target));
  if (!parents.includes(path.dirname(realTarget)) || parents.includes(realTarget)) {
    throw new Error(
      `${client.name} download folder is not inside ${client.name}'s completed folders`,
    );
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
      throw new Error(`${client.name} download folder overlaps a music library`);
    }
  }

  await fs.rm(realTarget, { recursive: true, force: true });
}

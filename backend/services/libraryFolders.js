import path from "node:path";
import { dbOps } from "../db/helpers/index.js";
import { resolveDownloadRoot } from "./downloadPaths.js";
import { getPathMappings, resolveLocalPath } from "./pathMappings.js";

export function configuredLidarrRoots(lidarrClient, override = null) {
  if (Array.isArray(override)) return override;
  const fromClient = lidarrClient?.getConfiguredRootFolderPaths?.();
  if (Array.isArray(fromClient) && fromClient.length > 0) return fromClient;
  const lidarr = dbOps.getSettings().integrations?.lidarr || {};
  return [
    ...(Array.isArray(lidarr.rootFolderPaths) ? lidarr.rootFolderPaths : []),
    lidarr.rootFolderPath,
  ].filter(Boolean);
}

export function isLidarrLibraryActive(lidarrClient) {
  return lidarrClient?.isConfigured?.() === true;
}

export function configuredLidarrFolders(lidarrClient, override = null) {
  const mappings = getPathMappings("lidarr");
  return [...new Set(
    configuredLidarrRoots(lidarrClient, override)
      .map((root) => String(root || "").trim())
      .filter(Boolean)
      .map((root) => path.resolve(resolveLocalPath(root, mappings))),
  )];
}

// Lidarr's root folders belong to the Library only while Lidarr is enabled
// and has an API key.
export function activeLidarrRoots(lidarrClient, override = null) {
  return isLidarrLibraryActive(lidarrClient) ? configuredLidarrFolders(lidarrClient, override) : [];
}

export function isPathWithin(rootPath, candidatePath) {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

const isStrictlyWithin = (rootPath, candidatePath) =>
  path.resolve(rootPath) !== path.resolve(candidatePath) && isPathWithin(rootPath, candidatePath);

// The deepest library folder holding a path owns it. Lidarr owns a folder it
// shares with the Downloads Folder.
export function libraryFolderOwner(filePath, {
  downloadRoot = resolveDownloadRoot(),
  lidarrRoots = [],
} = {}) {
  const candidate = path.resolve(String(filePath || ""));
  const holders = [
    ...lidarrRoots.map((root) => ({ owner: "lidarr", root: path.resolve(root) })),
    { owner: "aurral", root: path.resolve(downloadRoot) },
  ].filter(({ root }) => isPathWithin(root, candidate));
  if (holders.length === 0) return null;
  return holders.reduce((deepest, holder) =>
    holder.root.length > deepest.root.length ? holder : deepest,
  ).owner;
}

// Folders the Downloads Folder scan leaves to Lidarr, and the reverse.
export function lidarrRootsInsideDownloads(downloadRoot, lidarrRoots) {
  return lidarrRoots.filter((root) => isStrictlyWithin(downloadRoot, root));
}

export function downloadsInsideLidarrRoots(downloadRoot, lidarrRoots) {
  return lidarrRoots.some((root) => isStrictlyWithin(root, downloadRoot))
    ? [path.resolve(downloadRoot)]
    : [];
}

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
  return relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

const libraryFolders = ({ downloadRoot, lidarrRoots }) => [
  ...lidarrRoots.map((root) => ({ owner: "lidarr", root: path.resolve(root) })),
  { owner: "aurral", root: path.resolve(downloadRoot) },
];

const deepestHolders = (folders, filePath) => {
  const candidate = path.resolve(String(filePath || ""));
  const holders = folders.filter(({ root }) => isPathWithin(root, candidate));
  const depth = Math.max(...holders.map(({ root }) => root.length));
  return holders.filter(({ root }) => root.length === depth);
};

// The deepest library folder holding a path owns it. Lidarr owns a folder it
// shares with the Downloads Folder.
export function libraryFolderOwner(filePath, {
  downloadRoot = resolveDownloadRoot(),
  lidarrRoots = [],
} = {}) {
  const holders = deepestHolders(libraryFolders({ downloadRoot, lidarrRoots }), filePath);
  if (holders.length === 0) return null;
  return holders.some(({ owner }) => owner === "lidarr") ? "lidarr" : "aurral";
}

// A scan skips a path that a deeper folder of the other manager holds. A
// folder both managers share is scanned by both.
export function createLibraryScanExclusion(source, { downloadRoot, lidarrRoots }) {
  const folders = libraryFolders({ downloadRoot, lidarrRoots });
  return (filePath) => {
    const holders = deepestHolders(folders, filePath);
    return holders.length > 0 && !holders.some(({ owner }) => owner === source);
  };
}

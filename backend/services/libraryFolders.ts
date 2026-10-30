import * as v from "valibot";
import path from "node:path";
import type { LidarrClient } from "./lidarrClient.ts";
import { dbOps } from "../db/helpers/index.ts";
import { resolveDownloadRoot } from "./downloadPaths.ts";
import { getPathMappings, resolveLocalPath } from "./pathMappings.ts";

export type LidarrRootsSource = Partial<
  Pick<LidarrClient, "isConfigured" | "getConfiguredRootFolderPaths">
>;

export function configuredLidarrRoots(
  lidarrClient: LidarrRootsSource | null | undefined,
  override: string[] | null = null,
) {
  if (Array.isArray(override)) return override;
  const fromClient = lidarrClient?.getConfiguredRootFolderPaths?.();
  if (Array.isArray(fromClient) && fromClient.length > 0) return fromClient;
  const lidarr = dbOps.getSettings().integrations?.lidarr || {};
  return [
    ...(Array.isArray(lidarr.rootFolderPaths) ? lidarr.rootFolderPaths : []),
    lidarr.rootFolderPath,
  ].filter(Boolean);
}

export function isLidarrLibraryActive(lidarrClient: LidarrRootsSource | null | undefined) {
  return lidarrClient?.isConfigured?.() === true;
}

export function configuredLidarrFolders(
  lidarrClient: LidarrRootsSource | null | undefined,
  override: string[] | null = null,
) {
  const mappings = getPathMappings("lidarr");
  return [
    ...new Set(
      configuredLidarrRoots(lidarrClient, override)
        .map((root) => String(root || "").trim())
        .filter(Boolean)
        .map((root) => path.resolve(resolveLocalPath(root, mappings))),
    ),
  ];
}

// Lidarr's root folders belong to the Library only while Lidarr is enabled
// and has an API key.
export function activeLidarrRoots(
  lidarrClient: LidarrRootsSource | null | undefined,
  override: string[] | null = null,
) {
  return isLidarrLibraryActive(lidarrClient) ? configuredLidarrFolders(lidarrClient, override) : [];
}

export function isPathWithin(rootPath: string, candidatePath: string) {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

const READ_ONLY_FOLDERS_SETTING = "readOnlyFolders";

const uniqueResolvedPaths = (paths: unknown) => [
  ...new Set(
    (Array.isArray(paths) ? paths : [])
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .map((value) => path.resolve(value)),
  ),
];

export function readOnlyFolderPaths() {
  return uniqueResolvedPaths(dbOps.getJSONSetting(READ_ONLY_FOLDERS_SETTING, v.array(v.unknown())));
}

export function saveReadOnlyFolderPaths(paths: unknown) {
  const folders = uniqueResolvedPaths(paths);
  dbOps.setJSONSetting(READ_ONLY_FOLDERS_SETTING, folders);
  return folders;
}

export function readOnlyFolderOverlapping(candidate: string) {
  const resolved = path.resolve(String(candidate || ""));
  return (
    readOnlyFolderPaths().find(
      (folder) => isPathWithin(folder, resolved) || isPathWithin(resolved, folder),
    ) || null
  );
}

const libraryFolders = ({
  downloadRoot,
  lidarrRoots,
}: {
  downloadRoot: string;
  lidarrRoots: string[];
}) => [
  ...lidarrRoots.map((root) => ({ owner: "lidarr", root: path.resolve(root) })),
  { owner: "aurral", root: path.resolve(downloadRoot) },
];

const deepestHolders = (folders: { owner: string; root: string }[], filePath: string) => {
  const candidate = path.resolve(String(filePath || ""));
  const holders = folders.filter(({ root }) => isPathWithin(root, candidate));
  const depth = Math.max(...holders.map(({ root }) => root.length));
  return holders.filter(({ root }) => root.length === depth);
};

// The deepest library folder holding a path owns it. Lidarr owns a folder it
// shares with the Downloads Folder or a read-only folder, and a read-only
// folder owns what it shares with the Downloads Folder.
export function libraryFolderOwner(
  filePath: string,
  {
    downloadRoot = resolveDownloadRoot(),
    lidarrRoots = [],
    readOnlyRoots = readOnlyFolderPaths(),
  }: { downloadRoot?: string; lidarrRoots?: string[]; readOnlyRoots?: string[] } = {},
) {
  const holders = deepestHolders(libraryFolders({ downloadRoot, lidarrRoots }), filePath);
  const owner =
    holders.length === 0
      ? null
      : holders.some(({ owner }) => owner === "lidarr")
        ? "lidarr"
        : "aurral";
  if (owner === "lidarr") return owner;
  const readOnlyDepth = Math.max(
    ...readOnlyRoots
      .map((root) => path.resolve(root))
      .filter((root) => isPathWithin(root, filePath))
      .map((root) => root.length),
  );
  if (readOnlyDepth >= (owner ? path.resolve(downloadRoot).length : 0)) return "readonly";
  return owner;
}

// A scan skips a path that a deeper folder of another owner holds. A folder
// Lidarr shares with the Downloads Folder is scanned by both.
export function createLibraryScanExclusion(
  source: string,
  {
    downloadRoot,
    lidarrRoots,
    readOnlyRoots = [],
  }: { downloadRoot: string; lidarrRoots: string[]; readOnlyRoots?: string[] },
) {
  const folders = libraryFolders({ downloadRoot, lidarrRoots });
  return (filePath: string) => {
    const owner = libraryFolderOwner(filePath, { downloadRoot, lidarrRoots, readOnlyRoots });
    if (source === "readonly" || owner === "readonly") return owner !== source;
    const holders = deepestHolders(folders, filePath);
    return holders.length > 0 && !holders.some(({ owner }) => owner === source);
  };
}

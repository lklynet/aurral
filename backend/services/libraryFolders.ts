import * as v from "valibot";
import path from "node:path";
import { dbOps } from "../db/helpers/index.ts";
import { resolveDownloadRoot } from "./downloadPaths.ts";

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

// The deepest folder holding a path owns it, and a read-only folder owns what
// it shares with the Library folder.
export function libraryFolderOwner(
  filePath: string,
  {
    downloadRoot = resolveDownloadRoot(),
    readOnlyRoots = readOnlyFolderPaths(),
  }: { downloadRoot?: string; readOnlyRoots?: string[] } = {},
) {
  const inLibraryFolder = isPathWithin(downloadRoot, filePath);
  const readOnlyDepth = Math.max(
    ...readOnlyRoots
      .map((root) => path.resolve(root))
      .filter((root) => isPathWithin(root, filePath))
      .map((root) => root.length),
  );
  if (readOnlyDepth >= (inLibraryFolder ? path.resolve(downloadRoot).length : 0)) return "readonly";
  return inLibraryFolder ? "aurral" : null;
}

// A scan of the Library folder skips what a read-only folder owns, and a scan
// of a read-only folder keeps only what a read-only folder owns.
export function createLibraryScanExclusion(
  source: string,
  { downloadRoot, readOnlyRoots = [] }: { downloadRoot: string; readOnlyRoots?: string[] },
) {
  return (filePath: string) => {
    const owner = libraryFolderOwner(filePath, { downloadRoot, readOnlyRoots });
    return source === "readonly" ? owner !== "readonly" : owner === "readonly";
  };
}

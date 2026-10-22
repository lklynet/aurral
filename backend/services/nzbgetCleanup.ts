import fs from "node:fs/promises";
import path from "node:path";
import { isPathInsideRoot, resolveDownloadRoot } from "./downloadPaths.ts";
import { lidarrClient } from "./lidarrClient.ts";
import { getPathMappings, resolveLocalPath } from "./pathMappings.ts";
import type { NzbgetClient } from "./nzbgetClient.ts";

type NzbgetHistoryItem = { DestDir?: string | null; FinalDir?: string | null };
type NzbgetDownloadDirectories = Awaited<ReturnType<NzbgetClient["getDownloadDirectories"]>>;

const realpathOr = (dir: string) => fs.realpath(dir).catch(() => dir);

// NZBGet cannot delete a finished download, so Aurral removes the folder that
// NZBGet created for the job. That folder is always a direct child of the
// completed folder (or of the intermediate folder for a failed job). Anything
// else is refused, so a misreported path cannot reach a shared folder or a
// music library.
export async function removeNzbgetDownloadFolder(
  historyItem: NzbgetHistoryItem | null | undefined,
  directories: NzbgetDownloadDirectories,
  category: string | null | undefined,
) {
  // A download that failed before it started, such as an NZB NZBGet could not
  // fetch, has no folder.
  if (!String(historyItem?.DestDir || "").trim()) return;
  const mappings = getPathMappings("nzbget");
  const toLocal = (value: string | null | undefined) => {
    const raw = String(value || "").trim();
    if (!raw) return null;
    const local = resolveLocalPath(raw, mappings);
    // An unmapped Windows path would otherwise land under the app folder.
    return path.isAbsolute(raw) || local !== path.resolve(raw) ? local : null;
  };
  const target = toLocal(historyItem?.DestDir);
  if (!target) throw new Error("NZBGet download folder is missing or unmapped");
  if (String(historyItem?.FinalDir || "").trim() && toLocal(historyItem!.FinalDir) !== target) {
    throw new Error("A post-processing script moved the NZBGet download");
  }

  const stat = await fs.lstat(target).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!stat) return;
  if (!stat.isDirectory()) throw new Error("NZBGet download folder is not a directory");

  const roots = [directories.completedPath, directories.categoryDestDir, directories.destDir]
    .map(toLocal)
    .filter((root): root is string => Boolean(root));
  // NZBGet nests a category such as "music/aurral", but ".." must not widen
  // the folders that cleanup accepts.
  const categoryParts = String(category || "").split(/[\\/]/);
  const categoryDirs = categoryParts.every((part) => part && part !== "." && part !== "..")
    ? roots.map((root) => path.join(root, ...categoryParts))
    : [];
  const parents = await Promise.all(
    [...roots, ...categoryDirs, toLocal(directories.interDir)]
      .filter((dir): dir is string => Boolean(dir))
      .map(realpathOr),
  );
  const realTarget = path.join(await fs.realpath(path.dirname(target)), path.basename(target));
  if (!parents.includes(path.dirname(realTarget)) || parents.includes(realTarget)) {
    throw new Error("NZBGet download folder is not inside NZBGet's download folders");
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
      throw new Error("NZBGet download folder overlaps a music library");
    }
  }
  await fs.rm(realTarget, { recursive: true, force: true });
}

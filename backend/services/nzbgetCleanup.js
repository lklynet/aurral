import fs from "node:fs/promises";
import path from "node:path";
import { getPathMappings, resolveLocalPath } from "./pathMappings.js";

const inside = (target, root) => {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`)
    && relative !== ".." && !path.isAbsolute(relative));
};

// Cleanup uses the client's job directory, never an inferred common parent
// of audio files. A category can contain several releases downloading at once.
export async function cleanupNzbgetFiles({ historyItem, directories, category,
  protectedRoots = [], otherItems = [] }) {
  const mappings = getPathMappings("nzbget");
  const local = (value) => {
    const raw = String(value || "").trim();
    if (!raw) return null;
    const resolved = resolveLocalPath(raw, mappings);
    // An unmapped Windows path must not become relative to the app directory.
    if (!path.isAbsolute(raw) && resolved === path.resolve(raw)) return null;
    return path.resolve(resolved);
  };
  const target = local(historyItem?.FinalDir || historyItem?.DestDir);
  if (!target) throw new Error("NZBGet completed job directory is missing or unmapped");
  if (historyItem.Category && historyItem.Category !== category) {
    throw new Error("NZBGet job belongs to another category");
  }
  const roots = [directories.completedPath, directories.categoryDestDir, directories.destDir]
    .map(local).filter((root) => root && root !== path.parse(root).root);
  const reserved = [...roots, local(directories.interDir), local(directories.mainDir),
    ...roots.map((root) => path.join(root, category)), ...mappings.map((entry) => entry.local)]
    .filter(Boolean);
  if (reserved.includes(target) || !roots.some((root) => target !== root && inside(target, root))) {
    throw new Error("NZBGet cleanup requires a release folder inside the completed directory");
  }
  const stat = await fs.lstat(target).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!stat) return;
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("NZBGet cleanup target is not a regular directory");
  }
  const realTarget = await fs.realpath(target);
  const realRoots = await Promise.all(roots.map((root) => fs.realpath(root).catch(() => root)));
  const realReserved = await Promise.all(reserved.map((root) => fs.realpath(root).catch(() => root)));
  if (realReserved.includes(realTarget)
    || !realRoots.some((root, index) => realTarget !== root && inside(realTarget, root)
      && path.resolve(root, path.relative(roots[index], target)) === realTarget)) {
    throw new Error("NZBGet cleanup directory resolves outside the completed directory");
  }
  for (const root of protectedRoots.filter(Boolean)) {
    const realRoot = await fs.realpath(root).catch(() => path.resolve(root));
    if (inside(realTarget, realRoot) || inside(realRoot, realTarget)) {
      throw new Error("NZBGet cleanup directory overlaps a music library");
    }
  }
  for (const item of otherItems) {
    for (const value of [item.FinalDir, item.DestDir]) {
      const other = local(value);
      if (!other) continue;
      const realOther = await fs.realpath(other).catch(() => other);
      if (inside(realTarget, realOther) || inside(realOther, realTarget)) {
        throw new Error("NZBGet completed directory is shared with another download");
      }
    }
  }
  await fs.rm(target, { recursive: true, force: true });
}

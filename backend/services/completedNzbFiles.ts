import fs from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { getUsenetClient } from "./download/downloadClientSettings.ts";
import { resolveDownloadRoot } from "./downloadPaths.ts";
import { lidarrClient } from "./lidarrClient.ts";
import { getPathMappings, resolveLocalPath } from "./pathMappings.ts";

export async function completedNzbFolderMissing(folder: string) {
  try { await fs.lstat(folder); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; }
}

// Count ALL regular release material, not merely the selected audio track.
// Reject links/special files and tree changes; hash bytes before reuse/deletion.
export async function measureCompletedNzb(history: { DestDir?: string; FinalDir?: string | null }, limit = 250 * 1024 ** 3) {
  if (!history.DestDir) return null;
  const local = (p: string) => path.resolve(resolveLocalPath(p, getPathMappings("nzbget")));
  const folder = local(history.DestDir);
  if (history.FinalDir && local(history.FinalDir) !== folder) return null;
  try {
    if (await fs.realpath(folder) !== folder || !(await fs.lstat(folder)).isDirectory()) return null;
    const client = getUsenetClient("nzbget");
    if (client.key !== "nzbget") return null;
    const directories = await client.getDownloadDirectories();
    const roots = [directories.completedPath, directories.categoryDestDir, directories.destDir].filter(Boolean).map(p => local(p!));
    const category = String(client._getSettings().category || "").split(/[\\/]/);
    const parents = [...roots, ...(category.every(p => p && p !== "." && p !== "..") ? roots.map(root => path.join(root, ...category)) : [])];
    const realParents = await Promise.all(parents.map(async p => fs.realpath(p).catch((e) => { if (e.code === "ENOENT") return p; throw e; })));
    if (!realParents.includes(path.dirname(folder))) return null;
    const libraries = [resolveDownloadRoot(), ...(lidarrClient.isEnabled() ? lidarrClient.getConfiguredRootFolderPaths().map(p => resolveLocalPath(p, getPathMappings("lidarr"))) : [])].filter(Boolean);
    for (const library of libraries) {
      const root = await fs.realpath(path.resolve(library)).catch(e => { if (e.code === "ENOENT") return path.resolve(library); throw e; });
      if (folder === root || folder.startsWith(root + path.sep) || root.startsWith(folder + path.sep)) return null;
    }
    const files: { file: string; size: number; ino: number; dev: number; mtimeMs: number; ctimeMs: number }[] = [];
    let bytes = 0, visited = 0, unsafe = false;
    async function walk(dir: string, depth = 0) {
      if (depth > 7) { unsafe = true; return; }
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (++visited > 10000) { unsafe = true; return; }
        const file = path.join(dir, entry.name);
        const stat = await fs.lstat(file);
        if (stat.isDirectory()) await walk(file, depth + 1);
        else if (stat.isFile() && stat.nlink === 1) {
          bytes += stat.size;
          files.push({ file, size: stat.size, ino: stat.ino, dev: stat.dev, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs });
        } else unsafe = true;
      }
    }
    await walk(folder);
    if (unsafe || !files.length) return null;
    const space = await fs.statfs(folder);
    const freeBytes = Number(space.bavail) * Number(space.bsize);
    // Oversized sources are refused without reading a giant/sparse payload.
    if (bytes > limit) return { folder, bytes, freeBytes, signature: "oversize" };
    const hash = createHash("sha256");
    const root = await fs.stat(folder);
    hash.update(JSON.stringify([folder, root.dev, root.ino]));
    for (const file of files.sort((a,b) => a.file.localeCompare(b.file))) {
      const handle = await fs.open(file.file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const before = await handle.stat();
        if (before.ino !== file.ino || before.dev !== file.dev || before.size !== file.size || before.mtimeMs !== file.mtimeMs || before.ctimeMs !== file.ctimeMs)
          throw new Error("Completed NZB material changed during validation");
        hash.update(JSON.stringify(file));
        for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
        const after = await handle.stat();
        if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs)
          throw new Error("Completed NZB material changed during validation");
      } finally { await handle.close(); }
    }
    return { folder, bytes, freeBytes, signature: hash.digest("hex") };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

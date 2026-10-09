import fs from "fs/promises";
import path from "path";
import { parseFile } from "music-metadata";
import { dbOps } from "../db/helpers/index.js";
import { downloadTracker } from "./downloadJobs/downloadTracker.js";
import { isPathInsideRoot, resolveDownloadRoot } from "./downloadPaths.js";
import {
  moveIdentityMarkerToOwnTag,
  readAurralIdentity,
  readLegacyAurralIdentity,
} from "./downloadUtils.js";
import {
  IDENTITY_MARKER_MIGRATION_SETTING,
  IDENTITY_MARKER_MIGRATION_VERSION,
} from "./honkerDb.js";

function listAurralDownloadedFiles(root) {
  const files = new Set();
  for (const job of downloadTracker.getAll()) {
    if (job?.status !== "done" || job.managedBy !== "aurral" || !job.downloadClient) continue;
    const finalPath = String(job.finalPath || "").trim();
    if (!finalPath) continue;
    const resolved = path.resolve(finalPath);
    if (isPathInsideRoot(resolved, root)) files.add(resolved);
  }
  return [...files].sort();
}

const fileExists = (filePath) => fs.stat(filePath).then((stat) => stat.isFile(), () => false);

export async function migrateIdentityMarkers() {
  const root = path.resolve(resolveDownloadRoot());
  const result = { checked: 0, moved: 0, failed: 0 };
  for (const filePath of listAurralDownloadedFiles(root)) {
    if (!(await fileExists(filePath))) continue;
    try {
      const metadata = await parseFile(filePath, { skipCovers: true });
      result.checked += 1;
      if (!readLegacyAurralIdentity(metadata)) continue;
      await moveIdentityMarkerToOwnTag(filePath, readAurralIdentity(metadata));
      result.moved += 1;
    } catch {
      result.failed += 1;
    }
  }
  dbOps.setJSONSetting(IDENTITY_MARKER_MIGRATION_SETTING, {
    version: IDENTITY_MARKER_MIGRATION_VERSION,
    completedAt: Date.now(),
    ...result,
  });
  return result;
}

import fs from "fs/promises";
import path from "path";

const DEFAULT_WEEKLY_FLOW_ROOT = "/app/downloads";
const LEGACY_WEEKLY_FLOW_ROOT = "/app/downloads";

export function resolveWeeklyFlowRoot(explicitRoot) {
  const override = String(explicitRoot ?? "").trim();
  if (override) {
    return path.isAbsolute(override)
      ? override
      : path.resolve(process.cwd(), override);
  }

  const weeklyFlowFolder = String(process.env.WEEKLY_FLOW_FOLDER || "").trim();
  if (weeklyFlowFolder) {
    return path.isAbsolute(weeklyFlowFolder)
      ? weeklyFlowFolder
      : path.resolve(process.cwd(), weeklyFlowFolder);
  }

  const downloadFolder = String(process.env.DOWNLOAD_FOLDER || "").trim();
  if (path.isAbsolute(downloadFolder)) {
    return downloadFolder;
  }

  return DEFAULT_WEEKLY_FLOW_ROOT;
}

export function remapLegacyWeeklyFlowPath(
  finalPath,
  weeklyFlowRoot = resolveWeeklyFlowRoot(),
) {
  const resolved = path.resolve(String(finalPath || "").trim());
  const root = path.resolve(weeklyFlowRoot);
  if (resolved === root || resolved.startsWith(`${root}${path.sep}`)) {
    return resolved;
  }
  const legacyRoot = path.resolve(LEGACY_WEEKLY_FLOW_ROOT);
  if (
    resolved === legacyRoot ||
    resolved.startsWith(`${legacyRoot}${path.sep}`)
  ) {
    return path.resolve(root, path.relative(legacyRoot, resolved));
  }
  return resolved;
}

export async function resolveExistingWeeklyFlowTrackPath(
  finalPath,
  weeklyFlowRoot = resolveWeeklyFlowRoot(),
) {
  const direct = path.resolve(String(finalPath || "").trim());
  const root = path.resolve(weeklyFlowRoot);
  const candidates = [direct];
  const remapped = remapLegacyWeeklyFlowPath(direct, root);
  if (remapped !== direct) {
    candidates.push(remapped);
  }

  for (const candidate of candidates) {
    if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
      continue;
    }
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) {
        return {
          path: candidate,
          migratedFrom: candidate !== direct ? direct : null,
        };
      }
    } catch {}
  }
  return null;
}

export async function migrateLegacyWeeklyFlowPaths(
  weeklyFlowRoot = resolveWeeklyFlowRoot(),
  tracker,
) {
  if (!tracker?.getAll || !tracker?.setDone) {
    return { scanned: 0, migrated: 0 };
  }

  const jobs = tracker.getAll();
  let migrated = 0;
  for (const job of jobs) {
    if (!job?.finalPath || job.status !== "done") continue;
    const resolved = await resolveExistingWeeklyFlowTrackPath(
      job.finalPath,
      weeklyFlowRoot,
    );
    if (!resolved?.migratedFrom) continue;
    tracker.setDone(job.id, resolved.path, job.albumName || null);
    migrated += 1;
  }
  return { scanned: jobs.length, migrated };
}

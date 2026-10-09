import path from "path";
import { db } from "../config/db-sqlite.js";
import { getSchemaVersion } from "../config/schema-migration-v2.js";
import { dbOps, userOps } from "../db/helpers/index.js";
import { AURRAL_DOWNLOAD_FOLDER_MIGRATION_SETTING } from "./aurralDownloadFolderMigration.js";
import { getDeprecatedUsage } from "./deprecatedUsage.js";
import { isPathInsideRoot, resolveDownloadRoot } from "./downloadPaths.js";
import {
  enqueueSystemTaskJob,
  findActiveHonkerJob,
  getSystemTaskQueueName,
  IDENTITY_MARKER_MIGRATION_SETTING,
  IDENTITY_MARKER_MIGRATION_VERSION,
  PLAYLIST_STARTUP_MIGRATION_SETTING,
  PLAYLIST_STARTUP_MIGRATION_VERSION,
  STORED_DATA_MIGRATION_SETTING,
  STORED_DATA_MIGRATION_VERSION,
} from "./honkerDb.js";

export const UPGRADE_READINESS_SETTING = "aurral3Readiness";
const UPGRADE_READINESS_VERSION = 1;
const MINIMUM_SCHEMA_VERSION = 4;
const REVIEW_ITEM_LIMIT = 100;

const BLOCKER_MESSAGES = {
  schema: "The database has not finished its 2.x upgrade. Restart Aurral to finish it.",
  "stored-data": "Aurral has not finished storing older settings in their current form.",
  "identity-markers": "Aurral has not finished moving track identity markers to their own tag.",
  "download-folder": "Aurral has not finished moving older files in the Downloads Folder into the current layout. Check the logs for errors, then check again.",
  "download-folder-review": "Some older files in the Downloads Folder need your review. Move or delete each file, then check again.",
  "single-password": "Sign-in still uses the old single password. Sign in once to create the admin account.",
};

const isCurrent = (setting, version) => dbOps.getJSONSetting(setting)?.version === version;

function downloadFolderBlockers() {
  const root = path.resolve(resolveDownloadRoot());
  const sameRoot = (value) => path.resolve(String(value || "")) === root;
  const startup = dbOps.getJSONSetting(PLAYLIST_STARTUP_MIGRATION_SETTING);
  const folder = dbOps.getJSONSetting(AURRAL_DOWNLOAD_FOLDER_MIGRATION_SETTING);
  const review = folder && sameRoot(folder.rootPath)
    ? Object.entries(folder.items || {}).filter(([, item]) => item?.status === "retained")
    : [];
  if (review.length > 0) {
    return [{
      kind: "download-folder-review",
      totalItems: review.length,
      items: review.slice(0, REVIEW_ITEM_LIMIT).map(([sourcePath, item]) => ({
        path: isPathInsideRoot(sourcePath, root) ? path.relative(root, sourcePath) : sourcePath,
        reason: item.reason || null,
      })),
    }];
  }
  const finished = startup?.version === PLAYLIST_STARTUP_MIGRATION_VERSION
    && sameRoot(startup.rootPath)
    && folder?.status === "complete"
    && sameRoot(folder.rootPath);
  return finished ? [] : [{ kind: "download-folder" }];
}

function listBlockers() {
  const blockers = [];
  if (getSchemaVersion(db) < MINIMUM_SCHEMA_VERSION) blockers.push({ kind: "schema" });
  if (!isCurrent(STORED_DATA_MIGRATION_SETTING, STORED_DATA_MIGRATION_VERSION)) {
    blockers.push({ kind: "stored-data" });
  }
  if (!isCurrent(IDENTITY_MARKER_MIGRATION_SETTING, IDENTITY_MARKER_MIGRATION_VERSION)) {
    blockers.push({ kind: "identity-markers" });
  }
  blockers.push(...downloadFolderBlockers());
  if (dbOps.getSettings().integrations?.general?.authPassword && userOps.countUsers() === 0) {
    blockers.push({ kind: "single-password" });
  }
  return blockers.map((blocker) => ({ ...blocker, message: BLOCKER_MESSAGES[blocker.kind] }));
}

export function checkUpgradeReadiness() {
  const blockers = listBlockers();
  const checkedAt = Date.now();
  const ready = blockers.length === 0;
  dbOps.setJSONSetting(UPGRADE_READINESS_SETTING, {
    version: UPGRADE_READINESS_VERSION,
    ready,
    checkedAt,
    blockers: blockers.map((blocker) => blocker.kind),
  });
  return { ready, checkedAt, blockers, warnings: getDeprecatedUsage() };
}

const TASKS_FOR_BLOCKERS = {
  "stored-data": "stored-data-migration",
  "identity-markers": "identity-marker-migration",
  "download-folder": "playlist-startup-migration",
  "download-folder-review": "playlist-startup-migration",
};

export function queueUpgradeReadinessRecheck() {
  const kinds = new Set(
    listBlockers().map((blocker) => TASKS_FOR_BLOCKERS[blocker.kind]).filter(Boolean),
  );
  kinds.add("upgrade-readiness-check");
  for (const kind of kinds) {
    const queued = findActiveHonkerJob(
      getSystemTaskQueueName(kind),
      (payload) => payload?.kind === kind,
      { recoverExpired: true },
    );
    if (!queued) enqueueSystemTaskJob({ kind }, { priority: 10 });
  }
  return [...kinds];
}

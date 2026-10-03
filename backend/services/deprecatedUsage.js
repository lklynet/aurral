import path from "path";
import { resolveAurralDataDir } from "../config/data-dir.js";
import { dbOps } from "../db/helpers/index.js";
import { logger } from "./logger.js";

export const DEPRECATED_USAGE_SETTING = "deprecatedUsage";

const LEGACY_CONTAINER_DATA_DIR = "/app/backend/data";

const DEPRECATIONS = {
  "download-folder-env":
    "WEEKLY_FLOW_FOLDER or PLAYLIST_FOLDER is set. Set DOWNLOAD_FOLDER instead. Aurral 3.0 does not read the older names.",
  "legacy-data-dir":
    "Aurral's data folder is /app/backend/data. Mount it at /config instead. Aurral 3.0 does not look in /app/backend/data.",
  "auth-password-env":
    "AUTH_PASSWORD is set. Create accounts in Settings > Users, then remove AUTH_USER and AUTH_PASSWORD. Aurral 3.0 does not sign in with them.",
  "weekly-flow-api":
    "A client called /api/weekly-flow. Use /api/playlists instead. Aurral 3.0 removes /api/weekly-flow.",
  "weekly-flow-channel":
    "A client subscribed to the weekly-flow WebSocket channel. Use the playlists channel instead. Aurral 3.0 removes weekly-flow.",
  "image-proxy-query":
    "An old image link (/api/image-proxy?src=) was requested. Aurral 3.0 removes this route.",
};

const notedThisProcess = new Set();

function listConfigDeprecations() {
  const kinds = [];
  if (process.env.WEEKLY_FLOW_FOLDER || process.env.PLAYLIST_FOLDER) kinds.push("download-folder-env");
  if (path.resolve(resolveAurralDataDir()) === LEGACY_CONTAINER_DATA_DIR) kinds.push("legacy-data-dir");
  if (process.env.AUTH_PASSWORD) kinds.push("auth-password-env");
  return kinds;
}

export function warnAboutConfigDeprecations() {
  for (const kind of listConfigDeprecations()) {
    logger.warn("system", DEPRECATIONS[kind]);
  }
}

export function noteDeprecatedUsage(kind) {
  if (!DEPRECATIONS[kind] || notedThisProcess.has(kind)) return;
  notedThisProcess.add(kind);
  logger.warn("system", DEPRECATIONS[kind]);
  try {
    const recorded = dbOps.getJSONSetting(DEPRECATED_USAGE_SETTING) || {};
    dbOps.setJSONSetting(DEPRECATED_USAGE_SETTING, { ...recorded, [kind]: { lastSeenAt: Date.now() } });
  } catch (error) {
    logger.warn("system", "Could not record deprecated usage", { kind, reason: error.message });
  }
}

export function getDeprecatedUsage() {
  const recorded = dbOps.getJSONSetting(DEPRECATED_USAGE_SETTING) || {};
  return [
    ...listConfigDeprecations().map((kind) => ({ kind, message: DEPRECATIONS[kind], lastSeenAt: null })),
    ...Object.entries(recorded)
      .filter(([kind]) => DEPRECATIONS[kind])
      .map(([kind, entry]) => ({
        kind,
        message: DEPRECATIONS[kind],
        lastSeenAt: Number(entry?.lastSeenAt) || null,
      })),
  ];
}

import path from "path";
import { resolveAurralDataDir } from "../config/data-dir.ts";
import { logger } from "./logger.ts";

const LEGACY_CONTAINER_DATA_DIR = "/app/backend/data";

const DEPRECATIONS = {
  "download-folder-env":
    "WEEKLY_FLOW_FOLDER or PLAYLIST_FOLDER is set. Set DOWNLOAD_FOLDER instead. Aurral 3.0 does not read the older names.",
  "legacy-data-dir":
    "Aurral's data folder is /app/backend/data. Mount it at /config instead. Aurral 3.0 does not look in /app/backend/data.",
  "auth-password-env":
    "AUTH_PASSWORD is set. Create accounts in Settings → Users, then remove AUTH_USER and AUTH_PASSWORD. Aurral 3.0 does not sign in with them.",
};

type DeprecationKind = keyof typeof DEPRECATIONS;

export function listConfigDeprecations() {
  const kinds: DeprecationKind[] = [];
  if (process.env.WEEKLY_FLOW_FOLDER || process.env.PLAYLIST_FOLDER)
    kinds.push("download-folder-env");
  if (path.resolve(resolveAurralDataDir()) === LEGACY_CONTAINER_DATA_DIR)
    kinds.push("legacy-data-dir");
  if (process.env.AUTH_PASSWORD) kinds.push("auth-password-env");
  return kinds;
}

export function warnAboutConfigDeprecations() {
  for (const kind of listConfigDeprecations()) {
    logger.warn("system", DEPRECATIONS[kind]);
  }
}

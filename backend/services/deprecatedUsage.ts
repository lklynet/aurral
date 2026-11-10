import { logger } from "./logger.ts";

const DEPRECATIONS = {
  "download-folder-env":
    "DOWNLOAD_FOLDER, WEEKLY_FLOW_FOLDER, or PLAYLIST_FOLDER is set. Rename it to LIBRARY_FOLDER. A future release stops reading the older names.",
  "auth-env":
    "AUTH_USER or AUTH_PASSWORD is set. Aurral no longer reads them. Manage accounts in Settings → Users, then remove both.",
  "integration-env":
    "LIDARR_URL, LIDARR_API_KEY, LASTFM_API_KEY, or LASTFM_API_SECRET is set. Save Lidarr in Settings → Library → Lidarr and the Last.fm keys in Settings → Discovery → Last.fm, then remove the variables. A future release stops reading them.",
  "tuning-env":
    "LIDARR_TIMEOUT_MS or CONTACT_EMAIL is set. A future release stops reading them, and Lidarr requests then time out after 30 seconds. Remove both.",
};

const INTEGRATION_ENV = ["LIDARR_URL", "LIDARR_API_KEY", "LASTFM_API_KEY", "LASTFM_API_SECRET"];
const TUNING_ENV = ["LIDARR_TIMEOUT_MS", "CONTACT_EMAIL"];

type DeprecationKind = keyof typeof DEPRECATIONS;

export function listConfigDeprecations() {
  const kinds: DeprecationKind[] = [];
  if (
    !process.env.LIBRARY_FOLDER &&
    (process.env.DOWNLOAD_FOLDER || process.env.WEEKLY_FLOW_FOLDER || process.env.PLAYLIST_FOLDER)
  )
    kinds.push("download-folder-env");
  if (process.env.AUTH_USER || process.env.AUTH_PASSWORD) kinds.push("auth-env");
  if (INTEGRATION_ENV.some((name) => process.env[name])) kinds.push("integration-env");
  if (TUNING_ENV.some((name) => process.env[name])) kinds.push("tuning-env");
  return kinds;
}

export function warnAboutConfigDeprecations() {
  for (const kind of listConfigDeprecations()) {
    logger.warn("system", DEPRECATIONS[kind]);
  }
}

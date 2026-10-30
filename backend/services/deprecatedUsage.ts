import * as v from "valibot";
import path from "path";
import { resolveAurralDataDir } from "../config/data-dir.ts";
import { dbOps } from "../db/helpers/index.ts";
import { asAppError } from "../../lib/errors.ts";
import { isOwnKey } from "../../lib/ownKey.ts";
import { logger } from "./logger.ts";

export const DEPRECATED_USAGE_SETTING = "deprecatedUsage";

const deprecatedUsageSchema = v.record(v.string(), v.unknown());
const usageSchema = v.looseObject({ lastSeenAt: v.number() });

const LEGACY_CONTAINER_DATA_DIR = "/app/backend/data";

const DEPRECATIONS = {
  "download-folder-env":
    "WEEKLY_FLOW_FOLDER or PLAYLIST_FOLDER is set. Set DOWNLOAD_FOLDER instead. Aurral 3.0 does not read the older names.",
  "legacy-data-dir":
    "Aurral's data folder is /app/backend/data. Mount it at /config instead. Aurral 3.0 does not look in /app/backend/data.",
  "auth-password-env":
    "AUTH_PASSWORD is set. Create accounts in Settings → Users, then remove AUTH_USER and AUTH_PASSWORD. Aurral 3.0 does not sign in with them.",
  "weekly-flow-api":
    "A client called /api/weekly-flow. Use /api/playlists instead. Aurral 3.0 removes /api/weekly-flow.",
  "weekly-flow-channel":
    "A client subscribed to the weekly-flow WebSocket channel. Use the playlists channel instead. Aurral 3.0 removes weekly-flow.",
};

type DeprecationKind = keyof typeof DEPRECATIONS;

const notedThisProcess = new Set<DeprecationKind>();

function listConfigDeprecations() {
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

export function noteDeprecatedUsage(kind: DeprecationKind) {
  if (!DEPRECATIONS[kind] || notedThisProcess.has(kind)) return;
  notedThisProcess.add(kind);
  logger.warn("system", DEPRECATIONS[kind]);
  try {
    const recorded = dbOps.getJSONSetting(DEPRECATED_USAGE_SETTING, deprecatedUsageSchema) || {};
    dbOps.setJSONSetting(DEPRECATED_USAGE_SETTING, {
      ...recorded,
      [kind]: { lastSeenAt: Date.now() },
    });
  } catch (error) {
    const failure = asAppError(error);
    logger.warn("system", "Could not record deprecated usage", { kind, reason: failure?.message });
  }
}

export function getDeprecatedUsage() {
  const recorded = dbOps.getJSONSetting(DEPRECATED_USAGE_SETTING, deprecatedUsageSchema) || {};
  return [
    ...listConfigDeprecations().map((kind) => ({
      kind,
      message: DEPRECATIONS[kind],
      lastSeenAt: null,
    })),
    ...Object.entries(recorded).flatMap(([kind, entry]) =>
      isOwnKey(DEPRECATIONS, kind)
        ? [
            {
              kind,
              message: DEPRECATIONS[kind],
              lastSeenAt: (v.is(usageSchema, entry) && entry.lastSeenAt) || null,
            },
          ]
        : [],
    ),
  ];
}

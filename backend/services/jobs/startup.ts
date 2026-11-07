import path from "path";
import * as v from "valibot";
import { dbOps } from "../../db/helpers/index.ts";
import { resolveDownloadRoot } from "../downloadPaths.ts";
import { enqueueSystemTask, type SystemTaskKind } from "./queues.ts";

export const PLAYLIST_STARTUP_MIGRATION_VERSION = 1;
export const PLAYLIST_STARTUP_MIGRATION_SETTING = "playlistStartupMigration";
export const STORED_DATA_MIGRATION_VERSION = 3;
export const STORED_DATA_MIGRATION_SETTING = "storedDataMigration";
export const IDENTITY_MARKER_MIGRATION_VERSION = 2;
export const IDENTITY_MARKER_MIGRATION_SETTING = "identityMarkerMigration";

const migrationVersion = v.looseObject({ version: v.number() });

function enqueueOnce(kind: SystemTaskKind, delayMs: number, priority: number) {
  return enqueueSystemTask({ kind }, { delayMs, priority, dedupeKey: kind });
}

export function enqueueStartupTasks() {
  const migration = dbOps.getJSONSetting(
    PLAYLIST_STARTUP_MIGRATION_SETTING,
    v.looseObject({ version: v.number(), rootPath: v.string() }),
  );
  if (
    migration?.version !== PLAYLIST_STARTUP_MIGRATION_VERSION ||
    path.resolve(String(migration?.rootPath || "")) !== resolveDownloadRoot()
  ) {
    enqueueOnce("playlist-startup-migration", 3000, 10);
  }
  const storedData = dbOps.getJSONSetting(STORED_DATA_MIGRATION_SETTING, migrationVersion);
  if (storedData?.version !== STORED_DATA_MIGRATION_VERSION) {
    enqueueOnce("stored-data-migration", 3000, 10);
  }
  const identityMarkers = dbOps.getJSONSetting(IDENTITY_MARKER_MIGRATION_SETTING, migrationVersion);
  if (identityMarkers?.version !== IDENTITY_MARKER_MIGRATION_VERSION) {
    enqueueOnce("identity-marker-migration", 30_000, -5);
  }
  import("../playbackServerCleanup.ts")
    .then(({ hasLegacyPlaybackServerData }) => {
      if (hasLegacyPlaybackServerData()) enqueueOnce("playback-server-cleanup", 3000, 10);
    })
    .catch((error) =>
      console.warn(
        "[Playback] Could not check for old media server data:",
        error?.message || error,
      ),
    );
  enqueueOnce("flow-startup-check", 5000, 5);
  enqueueOnce("playlist-startup-publish", 10_000, 0);
  import("../libraryFiles/operations.ts")
    .then(({ resumeLibraryFileOperations }) => resumeLibraryFileOperations())
    .catch((error) =>
      console.warn("[LibraryFiles] Could not resume file operations:", error?.message || error),
    );
  enqueueOnce("discovery-bootstrap", 15_000, 5);
  enqueueOnce("library-index-bootstrap", 8000, 0);
  enqueueOnce("release-metadata-refresh", 12_000, -5);
  enqueueOnce("news-refresh", 20_000, -5);
  enqueueOnce("trending-charts-refresh", 25_000, -5);
}

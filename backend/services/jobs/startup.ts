import { enqueueSystemTask, type SystemTaskKind } from "./queues.ts";

function enqueueOnce(kind: SystemTaskKind, delayMs: number, priority: number) {
  return enqueueSystemTask({ kind }, { delayMs, priority, dedupeKey: kind });
}

export function enqueueStartupTasks() {
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

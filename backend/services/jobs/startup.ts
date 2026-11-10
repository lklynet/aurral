import { enqueueSystemTask, SYSTEM_TASK_STARTUPS, type SystemTaskKind } from "./systemTasks.ts";
import { asAppError } from "../../../lib/errors.ts";

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
        asAppError(error)?.message || error,
      ),
    );
  import("../libraryFiles/operations.ts")
    .then(({ resumeLibraryFileOperations }) => resumeLibraryFileOperations())
    .catch((error) =>
      console.warn(
        "[LibraryFiles] Could not resume file operations:",
        asAppError(error)?.message || error,
      ),
    );
  for (const { kind, delayMs, priority } of SYSTEM_TASK_STARTUPS) {
    enqueueOnce(kind, delayMs, priority);
  }
}

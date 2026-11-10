import { asAppError } from "../../../lib/errors.ts";
import { logger } from "../logger.ts";
import { withPlaylistMutationLock, normalizeLockOwners } from "./downloadLocks.ts";
import { isDownloadOwnerProcess, requestDownloadOwner } from "./downloadOwnerClient.ts";
import { downloadTracker } from "./downloadTracker.ts";
import { downloadWorker } from "./downloadWorker.ts";

export async function beginPlaylistMutation(
  playlistTypes: unknown,
  { clearPending = true }: { clearPending?: boolean } = {},
): Promise<() => Promise<void>> {
  const types = normalizeLockOwners(playlistTypes);
  const blocked: string[] = [];
  try {
    for (const playlistType of types) {
      await downloadWorker.blockPlaylist(playlistType);
      blocked.push(playlistType);
      if (clearPending) {
        if (isDownloadOwnerProcess()) downloadTracker.clearPendingByPlaylistType(playlistType);
        else await requestDownloadOwner("clearPendingByPlaylist", [playlistType]);
      }
    }
    await Promise.all(
      types.map((playlistType) => downloadWorker.waitForPlaylistIdle(playlistType)),
    );
  } catch (error) {
    for (const playlistType of blocked) {
      try {
        await downloadWorker.unblockPlaylist(playlistType);
      } catch (unblockError) {
        logger.warn("playlists", "Could not unblock playlist after mutation setup failed", {
          playlistId: playlistType,
          reason: asAppError(unblockError)?.message || String(unblockError),
        });
      }
    }
    throw error;
  }
  return async () => {
    let firstError = null;
    for (const playlistType of types) {
      try {
        await downloadWorker.unblockPlaylist(playlistType);
      } catch (error) {
        firstError ??= error;
      }
    }
    try {
      await downloadWorker.pruneOrphanedJobState();
    } catch (error) {
      firstError ??= error;
    }
    if (firstError) throw firstError;
  };
}

export async function withPlaylistMutation<T, Preflight = never>(
  playlistTypes: unknown,
  operation: () => T | Promise<T>,
  options: {
    clearPending?: boolean;
    beforeMutation?: () => Preflight | undefined | Promise<Preflight | undefined>;
  } = {},
): Promise<T | Preflight> {
  const types = normalizeLockOwners(playlistTypes);
  return withPlaylistMutationLock(types, async () => {
    if (typeof options.beforeMutation === "function") {
      const preflight = await options.beforeMutation();
      if (preflight !== undefined) return preflight;
    }
    const releaseMutation = await beginPlaylistMutation(types, options);
    try {
      return await operation();
    } finally {
      await releaseMutation();
    }
  });
}

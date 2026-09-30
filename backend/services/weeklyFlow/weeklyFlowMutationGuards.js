import { downloadTracker } from "./weeklyFlowDownloadTracker.js";
import { weeklyFlowWorker } from "./weeklyFlowWorker.js";
import { withHonkerLock } from "../honkerDb.js";
import { isFlowOwnerProcess, requestFlowOwner } from "./weeklyFlowOwnerClient.js";
import { logger } from "../logger.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { resolveTransferredDownloadPayload } from "./weeklyFlowDownloadOwnership.js";

const mutationLeases = new AsyncLocalStorage();

const normalizePlaylistTypes = (playlistTypes) => [
  ...new Set(
    (Array.isArray(playlistTypes) ? playlistTypes : [playlistTypes])
      .map((playlistType) => String(playlistType || "").trim())
      .filter(Boolean),
  ),
];

async function withPlaylistLocks(playlistTypes, operation) {
  const sortedTypes = [...playlistTypes].sort();
  const runAtIndex = async (index) => {
    if (index >= sortedTypes.length) {
      return operation();
    }
    const playlistType = sortedTypes[index];
    return withHonkerLock(`playlist-mutation:${playlistType}`, () => runAtIndex(index + 1), {
      ttlSeconds: 180,
      waitTimeoutMs: 15 * 60 * 1000,
      retryDelayMs: 250,
    });
  };
  return runAtIndex(0);
}

export async function beginPlaylistMutation(playlistTypes, { clearPending = true } = {}) {
  const types = normalizePlaylistTypes(playlistTypes);
  const blocked = [];
  try {
    for (const playlistType of types) {
      await weeklyFlowWorker.blockPlaylist(playlistType);
      blocked.push(playlistType);
      await weeklyFlowWorker.clearIncompleteRetry(playlistType);
      if (clearPending) {
        if (isFlowOwnerProcess()) downloadTracker.clearPendingByPlaylistType(playlistType);
        else await requestFlowOwner("clearPendingByPlaylist", [playlistType]);
      }
    }
    await Promise.all(
      types.map((playlistType) => weeklyFlowWorker.waitForPlaylistIdle(playlistType)),
    );
  } catch (error) {
    for (const playlistType of blocked) {
      try {
        await weeklyFlowWorker.unblockPlaylist(playlistType);
      } catch (unblockError) {
        logger.warn("playlists", "Could not unblock playlist after mutation setup failed", {
          playlistId: playlistType,
          reason: unblockError?.message || String(unblockError),
        });
      }
    }
    throw error;
  }
  return async () => {
    let firstError = null;
    for (const playlistType of types) {
      try {
        await weeklyFlowWorker.unblockPlaylist(playlistType);
      } catch (error) {
        firstError ??= error;
      }
    }
    try {
      await weeklyFlowWorker.pruneOrphanedJobState();
    } catch (error) {
      firstError ??= error;
    }
    if (firstError) throw firstError;
  };
}

export async function withPlaylistMutation(playlistTypes, operation, options = {}) {
  const types = normalizePlaylistTypes(playlistTypes);
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

export async function withPlaylistMutationLock(playlistTypes, operation) {
  const types = normalizePlaylistTypes(playlistTypes);
  const current = mutationLeases.getStore();
  if (current?.active) {
    if (types.every((type) => current.types.has(type))) return operation();
    const error = new Error("The download owner changed while holding playlist locks");
    error.code = "DOWNLOAD_LOCK_SET_CHANGED";
    throw error;
  }
  return withPlaylistLocks(types, async () => {
    const lease = { active: true, types: new Set(types) };
    return mutationLeases.run(lease, async () => {
      try {
        return await operation();
      } finally {
        lease.active = false;
      }
    });
  });
}

function payloadOwners(payload) {
  const owners = [payload?.playlistId];
  for (const id of [payload?.jobId, ...(payload?.albumGroupJobIds || [])]) {
    const job = downloadTracker.getJob(id);
    if (job) owners.push(job.playlistId || job.playlistType);
  }
  return normalizePlaylistTypes(owners);
}

export async function withDownloadPayloadMutation(payload, operation) {
  while (true) {
    const owners = payloadOwners(resolveTransferredDownloadPayload(payload));
    try {
      return await withPlaylistMutationLock(owners, () => {
        const current = resolveTransferredDownloadPayload(payload);
        if (!payloadOwners(current).every((owner) => owners.includes(owner))) {
          const error = new Error("Download ownership changed before mutation");
          error.code = "DOWNLOAD_LOCK_SET_CHANGED";
          throw error;
        }
        return operation(current);
      });
    } catch (error) {
      if (error.code !== "DOWNLOAD_LOCK_SET_CHANGED" || mutationLeases.getStore()?.active) throw error;
    }
  }
}

export async function restartWorkerIfPending() {
  const stillPending = downloadTracker.getNextPending();
  if (stillPending && !weeklyFlowWorker.running) {
    await weeklyFlowWorker.start();
  }
}

export async function wakeDownloadWorker() {
  if (!weeklyFlowWorker.running) {
    await weeklyFlowWorker.start();
  } else {
    weeklyFlowWorker.wake();
  }
}

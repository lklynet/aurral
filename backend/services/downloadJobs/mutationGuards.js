import { downloadTracker } from "./downloadTracker.js";
import { downloadWorker } from "./downloadWorker.js";
import { withHonkerLock } from "../honkerDb.js";
import { isDownloadOwnerProcess, requestDownloadOwner } from "./downloadOwnerClient.js";
import { logger } from "../logger.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { resolveTransferredDownloadPayload } from "./downloadOwnership.js";

const downloadLeases = new AsyncLocalStorage();

const normalizePlaylistTypes = (playlistTypes) => [
  ...new Set(
    (Array.isArray(playlistTypes) ? playlistTypes : [playlistTypes])
      .map((playlistType) => String(playlistType || "").trim())
      .filter(Boolean),
  ),
];

async function withOwnerLocks(lockKind, ownerIds, operation) {
  const sortedIds = [...ownerIds].sort();
  const runAtIndex = async (index) => {
    if (index >= sortedIds.length) {
      return operation();
    }
    return withHonkerLock(`${lockKind}:${sortedIds[index]}`, () => runAtIndex(index + 1), {
      ttlSeconds: 180,
      waitTimeoutMs: 15 * 60 * 1000,
      retryDelayMs: 250,
    });
  };
  return runAtIndex(0);
}

function runWithLease(lease, operation) {
  return downloadLeases.run(lease, async () => {
    try {
      return await operation();
    } finally {
      lease.active = false;
    }
  });
}

async function withDownloadLocks(ownerIds, { steps = false, imports = false }, operation) {
  const owners = normalizePlaylistTypes(ownerIds);
  const current = downloadLeases.getStore();
  if (current?.active) {
    if (!owners.every((owner) => current.owners.has(owner))) {
      const error = new Error("The download owner changed while holding download locks");
      error.code = "DOWNLOAD_LOCK_SET_CHANGED";
      throw error;
    }
    if (steps && !current.steps) {
      throw new Error("Download step locks must be taken before download import locks");
    }
    if (!imports || current.imports) return operation();
    const lease = { active: true, owners: current.owners, steps: current.steps, imports: true };
    return withOwnerLocks("download-import", current.owners, () => runWithLease(lease, operation));
  }
  const lease = { active: true, owners: new Set(owners), steps, imports };
  const locked = () => runWithLease(lease, operation);
  const lockImports = imports ? () => withOwnerLocks("download-import", owners, locked) : locked;
  return steps ? withOwnerLocks("download-step", owners, lockImports) : lockImports();
}

export async function beginPlaylistMutation(playlistTypes, { clearPending = true } = {}) {
  const types = normalizePlaylistTypes(playlistTypes);
  const blocked = [];
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

export function withPlaylistMutationLock(playlistTypes, operation) {
  return withDownloadLocks(playlistTypes, { steps: true, imports: true }, operation);
}

export function withDownloadImportLock(ownerIds, operation) {
  return withDownloadLocks(ownerIds, { imports: true }, operation);
}

export function withDownloadStepLock(ownerIds, operation) {
  return withDownloadLocks(ownerIds, { steps: true }, operation);
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
    const result = await withDownloadStepLock(owners, async () => {
      const current = resolveTransferredDownloadPayload(payload);
      if (!payloadOwners(current).every((owner) => owners.includes(owner))) return { retryLocks: true };
      return { value: await operation(current) };
    });
    if (!result.retryLocks) return result.value;
  }
}

export async function restartWorkerIfPending() {
  const stillPending = downloadTracker.getNextPending();
  if (stillPending && !downloadWorker.running) {
    await downloadWorker.start();
  }
}

export async function wakeDownloadWorker() {
  if (!downloadWorker.running) {
    await downloadWorker.start();
  } else {
    downloadWorker.wake();
  }
}

import { downloadTracker } from "./downloadTracker.ts";
import { downloadWorker } from "./downloadWorker.ts";
import { withHonkerLock } from "../honkerDb.ts";
import { isDownloadOwnerProcess, requestDownloadOwner } from "./downloadOwnerClient.ts";
import { logger } from "../logger.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import { resolveTransferredDownloadPayload, type OwnedPayload } from "./downloadOwnership.ts";
import { asAppError } from "../../../lib/errors.ts";

type DownloadLease = {
  active: boolean;
  owners: Set<string>;
  steps: boolean;
  imports: boolean;
};

const downloadLeases = new AsyncLocalStorage<DownloadLease>();

const normalizePlaylistTypes = (playlistTypes: unknown) => [
  ...new Set(
    (Array.isArray(playlistTypes) ? playlistTypes : [playlistTypes])
      .map((playlistType) => String(playlistType || "").trim())
      .filter(Boolean),
  ),
];

async function withOwnerLocks<T>(
  lockKind: string,
  ownerIds: Iterable<string>,
  operation: () => T | Promise<T>,
): Promise<T> {
  const sortedIds = [...ownerIds].sort();
  const runAtIndex = async (index: number): Promise<T> => {
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

function runWithLease<T>(lease: DownloadLease, operation: () => T | Promise<T>) {
  return downloadLeases.run(lease, async () => {
    try {
      return await operation();
    } finally {
      lease.active = false;
    }
  });
}

async function withDownloadLocks<T>(
  ownerIds: unknown,
  { steps = false, imports = false }: { steps?: boolean; imports?: boolean },
  operation: () => T | Promise<T>,
): Promise<T> {
  const owners = normalizePlaylistTypes(ownerIds);
  const current = downloadLeases.getStore();
  if (current?.active) {
    if (!owners.every((owner) => current.owners.has(owner))) {
      const error: NodeJS.ErrnoException = new Error(
        "The download owner changed while holding download locks",
      );
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

export async function beginPlaylistMutation(
  playlistTypes: unknown,
  { clearPending = true }: { clearPending?: boolean } = {},
): Promise<() => Promise<void>> {
  const types = normalizePlaylistTypes(playlistTypes);
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

export function withPlaylistMutationLock<T>(
  playlistTypes: unknown,
  operation: () => T | Promise<T>,
) {
  return withDownloadLocks(playlistTypes, { steps: true, imports: true }, operation);
}

export function withDownloadImportLock<T>(ownerIds: unknown, operation: () => T | Promise<T>) {
  return withDownloadLocks(ownerIds, { imports: true }, operation);
}

export function withDownloadStepLock<T>(ownerIds: unknown, operation: () => T | Promise<T>) {
  return withDownloadLocks(ownerIds, { steps: true }, operation);
}

function payloadOwners(payload: OwnedPayload | null) {
  const owners = [payload?.playlistId];
  const groupJobIds = payload?.albumGroupJobIds;
  const jobIds = [payload?.jobId, ...(Array.isArray(groupJobIds) ? groupJobIds : [])];
  for (const id of jobIds.filter((value): value is string => typeof value === "string")) {
    const job = downloadTracker.getJob(id);
    if (job) owners.push(job.playlistId || job.playlistType);
  }
  return normalizePlaylistTypes(owners);
}

export async function withDownloadPayloadMutation<Payload extends OwnedPayload, T>(
  payload: Payload,
  operation: (current: Payload) => T | Promise<T>,
) {
  while (true) {
    const owners = payloadOwners(resolveTransferredDownloadPayload(payload));
    const result = await withDownloadStepLock(owners, async () => {
      const current = resolveTransferredDownloadPayload(payload);
      if (!payloadOwners(current).every((owner) => owners.includes(owner)))
        return { retryLocks: true };
      return { value: await operation(current) };
    });
    if (!result.retryLocks) return result.value;
  }
}

export async function restartWorkerIfPending(): Promise<void> {
  const stillPending = downloadTracker.getNextPending();
  if (stillPending && !downloadWorker.running) {
    await downloadWorker.start();
  }
}

export async function wakeDownloadWorker(): Promise<void> {
  if (!downloadWorker.running) {
    await downloadWorker.start();
  } else {
    downloadWorker.wake();
  }
}

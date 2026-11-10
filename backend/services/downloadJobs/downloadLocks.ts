import { AsyncLocalStorage } from "node:async_hooks";
import { withLock } from "../jobs/queue.ts";

type DownloadLease = {
  active: boolean;
  owners: Set<string>;
  steps: boolean;
  imports: boolean;
};

const downloadLeases = new AsyncLocalStorage<DownloadLease>();

export const normalizeLockOwners = (playlistTypes: unknown) => [
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
    return withLock(`${lockKind}:${sortedIds[index]}`, () => runAtIndex(index + 1), {
      ttlMs: 180_000,
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
  const owners = normalizeLockOwners(ownerIds);
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

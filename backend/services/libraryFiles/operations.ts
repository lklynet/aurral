import path from "node:path";
import { resolveDownloadRoot } from "../downloadPaths.ts";
import { logger, safeLogDiagnostic } from "../logger.ts";
import type { LibraryScanRequest } from "../libraryScanRequest.ts";
import {
  type FiledItem,
  IngestSourceError,
  applyIngestItem,
  finishIngest,
  ingestScanRequest,
  planIngest,
  resolveIngestSource,
  validateIngestOptions,
} from "./ingest.ts";
import { applyCleanupItem, createCleanupContext, finishCleanup, planCleanup } from "./cleanup.ts";
import {
  UNREADABLE_ITEM,
  countLibraryFileOperationItems,
  countRemovableDuplicates,
  createLibraryFileOperation,
  failUnreadableLibraryFileOperation,
  getLibraryFileOperation,
  type LibraryFileOperation,
  type LibraryFileStatus,
  listLibraryFileOperationItems,
  listUnfinishedLibraryFileOperationIds,
  reopenToRemoveDuplicates,
  transitionLibraryFileOperation,
  updateLibraryFileOperation,
  updateLibraryFileOperationItem,
} from "./operationStore.ts";

type LibraryFileItem = ReturnType<typeof listLibraryFileOperationItems>[number];

const BUDGET_MS = 20000;
const BATCH = 50;

async function enqueue(operationId: number, { dedupe = true }: { dedupe?: boolean } = {}) {
  const { enqueueLibraryFileJob, findActiveHonkerJob } = await import("../honkerDb.ts");
  if (
    dedupe &&
    findActiveHonkerJob(
      "library-files",
      (payload) => Number(payload?.operationId) === Number(operationId),
      { recoverExpired: true },
    )
  )
    return;
  enqueueLibraryFileJob({ operationId });
}

export async function startIngest({
  sourcePath,
  mode,
  monitor = "none",
  fillTags = false,
}: {
  sourcePath?: unknown;
  mode?: unknown;
  monitor?: unknown;
  fillTags?: unknown;
} = {}) {
  validateIngestOptions({ mode, monitor });
  const source = await resolveIngestSource(sourcePath);
  const operation = createLibraryFileOperation({
    kind: "ingest",
    options: { sourcePath: source, mode, monitor, fillTags: fillTags === true },
  });
  await enqueue(operation!.id);
  return operation;
}

export async function startCleanup() {
  const operation = createLibraryFileOperation({ kind: "cleanup", options: {} });
  await enqueue(operation!.id);
  return operation;
}

const UNFINISHED_REASONS = {
  ingest: "The ingest stopped before Aurral got to this file. Ingest the folder again to file it.",
  cleanup: "Clean up stopped before Aurral got to this file. Run Clean up Library again.",
};

// A Move ingest keeps sources the Library has in another file, and Clean up
// keeps the extra copies of a track, until the user asks to remove them.
const removesDuplicates = (
  operation: LibraryFileStatus | undefined,
): operation is LibraryFileOperation =>
  operation?.options != null &&
  (operation.kind === "cleanup" ||
    (operation.kind === "ingest" && operation.options.mode === "move"));

export async function removeDuplicateFiles(id: number) {
  const operation = getLibraryFileOperation(id);
  if (!removesDuplicates(operation)) {
    throw new IngestSourceError("Only a Move ingest removes its source files.");
  }
  if (reopenToRemoveDuplicates(id, UNFINISHED_REASONS[operation.kind])) await enqueue(id);
  return getLibraryFileOperation(id);
}

export function cancelLibraryFileOperation(id: number) {
  return transitionLibraryFileOperation(id, ["planning", "running"], "cancelled");
}

export async function resumeLibraryFileOperations() {
  for (const id of listUnfinishedLibraryFileOperationIds()) await enqueue(id);
}

const plan = (operation: LibraryFileOperation, deadline: number) =>
  operation.kind === "ingest" ? planIngest(operation, deadline) : planCleanup(operation, deadline);

const finishWork = (operation: LibraryFileOperation) =>
  operation.kind === "ingest" ? finishIngest(operation) : finishCleanup(operation);

function assertFiled(item: LibraryFileItem): asserts item is FiledItem {
  if (item.targetPath === null) throw new TypeError("Ingest item has no target path");
}

async function requestScan(request: LibraryScanRequest) {
  const changedPaths = [...new Set((request?.changedPaths || []).filter(Boolean))];
  if (!changedPaths.length) return;
  const { scheduleLibraryScan } = await import("../libraryScanWorker.ts");
  scheduleLibraryScan({ includeLidarr: request.includeLidarr === true, changedPaths });
}

async function finish(operation: LibraryFileOperation, status: string) {
  const current = getLibraryFileOperation(operation.id);
  if (!current) return failUnreadableLibraryFileOperation(operation.id);
  if (current.summary.finished) return;
  await requestScan(await finishWork(current));
  updateLibraryFileOperation(operation.id, {
    status,
    summary: { counts: countLibraryFileOperationItems(operation.id), finished: true },
  });
}

function itemApplier(operation: LibraryFileOperation) {
  if (operation.kind === "ingest") {
    return {
      context: null,
      apply: (item: LibraryFileItem) => {
        assertFiled(item);
        return applyIngestItem(operation, item);
      },
    };
  }
  const context = createCleanupContext();
  return { context, apply: (item: LibraryFileItem) => applyCleanupItem(operation, item, context) };
}

async function applyBatch(operation: LibraryFileOperation, deadline: number) {
  const { context, apply } = itemApplier(operation);
  await context?.prepare();
  const processed = [];
  let cancelled = false;
  while (Date.now() < deadline && !cancelled) {
    const batch = listLibraryFileOperationItems(operation.id, {
      statuses: ["pending"],
      limit: BATCH,
    });
    if (!batch.length) break;
    for (const item of batch) {
      if (getLibraryFileOperation(operation.id)?.status !== "running") {
        cancelled = true;
        break;
      }
      let result;
      try {
        result = item.readable ? await apply(item) : { status: "failed", reason: UNREADABLE_ITEM };
      } catch (error) {
        result = { status: "failed", reason: safeLogDiagnostic(error) };
      }
      updateLibraryFileOperationItem(operation.id, item.position, result);
      processed.push({ ...item, ...result });
      if (Date.now() >= deadline) break;
    }
  }
  if (operation.kind === "ingest") await requestScan(ingestScanRequest(operation, processed));
  if (context) await requestScan({ changedPaths: [...context.rescan] });
  return { cancelled };
}

// One bounded slice of work. Each file is checked before anything changes,
// then the changes are applied. The worker queues the next slice until the
// operation finishes or is stopped, so a restart resumes where it stopped.
export async function runLibraryFileOperation(
  id: number,
  { budgetMs = BUDGET_MS }: { budgetMs?: number } = {},
) {
  const operation = getLibraryFileOperation(id);
  if (!operation) {
    failUnreadableLibraryFileOperation(id);
    return { done: true };
  }
  const deadline = Date.now() + budgetMs;
  try {
    if (operation.status === "planning") {
      if (!(await plan(operation, deadline))) return { done: false };
      const next = countLibraryFileOperationItems(id).pending ? "running" : "complete";
      transitionLibraryFileOperation(id, ["planning"], next);
      return { done: next === "complete" };
    }
    if (operation.status === "cancelled") {
      await finish(operation, "cancelled");
      return { done: true };
    }
    if (operation.status !== "running") return { done: true };
    const { cancelled } = await applyBatch(operation, deadline);
    if (cancelled) {
      await finish(operation, "cancelled");
      return { done: true };
    }
    if (listLibraryFileOperationItems(id, { statuses: ["pending"], limit: 1 }).length)
      return { done: false };
    await finish(operation, "complete");
    return { done: true };
  } catch (error) {
    logger.warn("library-files", "Library file operation failed", {
      operationId: id,
      reason: safeLogDiagnostic(error),
    });
    updateLibraryFileOperation(id, { status: "failed", error: safeLogDiagnostic(error) });
    return { done: true };
  }
}

export async function processLibraryFileJob(operationId: number) {
  const { done } = await runLibraryFileOperation(operationId);
  if (!done) await enqueue(operationId, { dedupe: false });
}

const relative = (root: string, filePath: string | null | undefined) => {
  if (!filePath) return null;
  const value = path.relative(root, filePath);
  return value && !value.startsWith("..") && !path.isAbsolute(value) ? value : filePath;
};

export function describeLibraryFileOperation(operation: LibraryFileStatus | undefined) {
  if (!operation) return null;
  const counts = countLibraryFileOperationItems(operation.id);
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  const { cursor, finished: _finished, ...summary } = operation.summary;
  const removing = operation.status === "running" && summary.removingSources;
  return {
    ...operation,
    summary,
    counts,
    progress:
      operation.status === "planning"
        ? {
            done: operation.kind === "cleanup" ? cursor?.next || 0 : total - (counts.new || 0),
            total: operation.kind === "cleanup" ? cursor?.albumIds?.length || 0 : total,
            unit: operation.kind === "cleanup" ? "albums" : "files",
          }
        : removing
          ? { done: removing - (counts.pending || 0), total: removing, unit: "files" }
          : { done: total - (counts.pending || 0), total, unit: "files" },
    sources: removesDuplicates(operation) ? countRemovableDuplicates(operation.id) : null,
  };
}

export function describeLibraryFileOperationItems(
  operation: LibraryFileStatus,
  options: Parameters<typeof listLibraryFileOperationItems>[1],
) {
  const downloadRoot = path.resolve(resolveDownloadRoot());
  const sourceRoot = (operation.kind === "ingest" && operation.options?.sourcePath) || downloadRoot;
  return listLibraryFileOperationItems(operation.id, options).map((item) => ({
    position: item.position,
    status: item.status,
    reason: item.reason,
    source: relative(sourceRoot, item.sourcePath) as string,
    target: relative(downloadRoot, item.targetPath),
    actions: item.details.actions || [item.details.action].filter(Boolean),
    tagFields: item.details.tagFields || [],
    hardlinked: item.details.hardlinked === true,
    results: item.details.results || null,
  }));
}

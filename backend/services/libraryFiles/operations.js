import path from "node:path";
import { resolveDownloadRoot } from "../downloadPaths.js";
import { logger, safeLogDiagnostic } from "../logger.js";
import {
  applyIngestItem,
  finishIngest,
  ingestScanRequest,
  planIngest,
  resolveIngestSource,
  validateIngestOptions,
} from "./ingest.js";
import { applyCleanupItem, createCleanupContext, finishCleanup, planCleanup } from "./cleanup.js";
import {
  countLibraryFileOperationItems,
  createLibraryFileOperation,
  getLibraryFileOperation,
  listLibraryFileOperationItems,
  transitionLibraryFileOperation,
  updateLibraryFileOperation,
  updateLibraryFileOperationItem,
} from "./operationStore.js";

const BUDGET_MS = 20000;
const BATCH = 50;

async function enqueue(operationId, { dedupe = true } = {}) {
  const { enqueueLibraryFileJob, findActiveHonkerJob } = await import("../honkerDb.js");
  if (dedupe && findActiveHonkerJob(
    "library-files",
    (payload) => Number(payload?.operationId) === Number(operationId),
    { recoverExpired: true },
  )) return;
  enqueueLibraryFileJob({ operationId });
}

export async function startIngest({ sourcePath, mode, monitor = "none", fillTags = false } = {}) {
  validateIngestOptions({ mode, monitor });
  const source = await resolveIngestSource(sourcePath);
  const operation = createLibraryFileOperation({
    kind: "ingest",
    options: { sourcePath: source, mode, monitor, fillTags: fillTags === true },
  });
  await enqueue(operation.id);
  return operation;
}

export async function startCleanup() {
  const operation = createLibraryFileOperation({ kind: "cleanup", options: {} });
  await enqueue(operation.id);
  return operation;
}

export function cancelLibraryFileOperation(id) {
  return transitionLibraryFileOperation(id, ["planning", "running"], "cancelled");
}

export async function resumeLibraryFileOperations() {
  const { listUnfinishedLibraryFileOperations } = await import("./operationStore.js");
  for (const operation of listUnfinishedLibraryFileOperations()) await enqueue(operation.id);
}

const handlers = {
  ingest: { plan: planIngest, apply: applyIngestItem, finish: finishIngest },
  cleanup: { plan: planCleanup, apply: applyCleanupItem, finish: finishCleanup },
};

async function requestScan(request) {
  const changedPaths = [...new Set((request?.changedPaths || []).filter(Boolean))];
  if (!changedPaths.length) return;
  const { scheduleLibraryScan } = await import("../libraryScanWorker.js");
  scheduleLibraryScan({ includeLidarr: request.includeLidarr === true, changedPaths });
}

async function finish(operation, handler, status) {
  const current = getLibraryFileOperation(operation.id);
  if (current.summary.finished) return;
  await requestScan(await handler.finish(current));
  updateLibraryFileOperation(operation.id, {
    status,
    summary: { counts: countLibraryFileOperationItems(operation.id), finished: true },
  });
}

async function applyBatch(operation, handler, deadline) {
  const context = operation.kind === "cleanup" ? createCleanupContext() : null;
  await context?.prepare();
  const processed = [];
  let cancelled = false;
  while (Date.now() < deadline && !cancelled) {
    const batch = listLibraryFileOperationItems(operation.id, { statuses: ["pending"], limit: BATCH });
    if (!batch.length) break;
    for (const item of batch) {
      if (getLibraryFileOperation(operation.id)?.status !== "running") {
        cancelled = true;
        break;
      }
      let result;
      try {
        result = await handler.apply(operation, item, context);
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
export async function runLibraryFileOperation(id, { budgetMs = BUDGET_MS } = {}) {
  const operation = getLibraryFileOperation(id);
  const handler = handlers[operation?.kind];
  if (!operation || !handler) return { done: true };
  const deadline = Date.now() + budgetMs;
  try {
    if (operation.status === "planning") {
      if (!(await handler.plan(operation, deadline))) return { done: false };
      const next = countLibraryFileOperationItems(id).pending ? "running" : "complete";
      transitionLibraryFileOperation(id, ["planning"], next);
      return { done: next === "complete" };
    }
    if (operation.status === "cancelled") {
      await finish(operation, handler, "cancelled");
      return { done: true };
    }
    if (operation.status !== "running") return { done: true };
    const { cancelled } = await applyBatch(operation, handler, deadline);
    if (cancelled) {
      await finish(operation, handler, "cancelled");
      return { done: true };
    }
    if (listLibraryFileOperationItems(id, { statuses: ["pending"], limit: 1 }).length) return { done: false };
    await finish(operation, handler, "complete");
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

export async function processLibraryFileJob(payload = {}) {
  const operationId = Number(payload.operationId);
  const { done } = await runLibraryFileOperation(operationId);
  if (!done) await enqueue(operationId, { dedupe: false });
}

const relative = (root, filePath) => {
  if (!filePath) return null;
  const value = path.relative(root, filePath);
  return value && !value.startsWith("..") && !path.isAbsolute(value) ? value : filePath;
};

export function describeLibraryFileOperation(operation) {
  if (!operation) return null;
  const counts = countLibraryFileOperationItems(operation.id);
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  const { cursor, finished: _finished, ...summary } = operation.summary;
  return {
    id: operation.id,
    kind: operation.kind,
    status: operation.status,
    options: operation.options,
    summary,
    counts,
    progress: operation.status === "planning"
      ? {
          done: operation.kind === "cleanup" ? cursor?.next || 0 : total - (counts.new || 0),
          total: operation.kind === "cleanup" ? cursor?.albumIds?.length || 0 : total,
          unit: operation.kind === "cleanup" ? "albums" : "files",
        }
      : { done: total - (counts.pending || 0), total, unit: "files" },
    error: operation.error,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
    finishedAt: operation.finishedAt,
  };
}

export function describeLibraryFileOperationItems(operation, options) {
  const downloadRoot = path.resolve(resolveDownloadRoot());
  const sourceRoot = operation.kind === "ingest" ? operation.options.sourcePath : downloadRoot;
  return listLibraryFileOperationItems(operation.id, options).map((item) => ({
    position: item.position,
    status: item.status,
    reason: item.reason,
    source: relative(sourceRoot, item.sourcePath),
    target: relative(downloadRoot, item.targetPath),
    actions: item.details.actions || [item.details.action].filter(Boolean),
    tagFields: item.details.tagFields || [],
    hardlinked: item.details.hardlinked === true,
    results: item.details.results || null,
  }));
}

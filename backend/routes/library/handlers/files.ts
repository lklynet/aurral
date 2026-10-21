import { noCache } from "../../../middleware/cache.ts";
import { requireAdmin, requireAuth } from "../../../middleware/requirePermission.ts";
import { lidarrClient } from "../../../services/lidarrClient.ts";
import { checkIngestSource } from "../../../services/libraryFiles/ingest.ts";
import {
  cancelLibraryFileOperation,
  describeLibraryFileOperation,
  describeLibraryFileOperationItems,
  removeDuplicateFiles,
  startCleanup,
  startIngest,
} from "../../../services/libraryFiles/operations.ts";
import {
  addReadOnlyFolder,
  describeReadOnlyFolders,
  removeReadOnlyFolder,
} from "../../../services/libraryFiles/readOnlyFolders.ts";
import {
  getLatestLibraryFileOperation,
  getLibraryFileOperation,
} from "../../../services/libraryFiles/operationStore.ts";

const ITEM_STATUSES = new Set([
  "new",
  "pending",
  "done",
  "duplicate",
  "conflict",
  "skipped",
  "failed",
]);

function sendError(res, error) {
  if (error?.code === "LIBRARY_FILE_OPERATION_ACTIVE") {
    return res.status(409).json({
      error: "operation_active",
      message: error.message,
      operation: describeLibraryFileOperation(error.operation),
    });
  }
  if (error?.code === "INGEST_SOURCE_INVALID" || error?.code === "READ_ONLY_FOLDER_INVALID") {
    return res.status(400).json({ error: "invalid_request", message: error.message });
  }
  return res.status(500).json({
    error: "library_files_failed",
    message: error?.message || "Library file operation failed",
  });
}

function findOperation(req, res) {
  const operation = getLibraryFileOperation(req.params.id);
  if (!operation)
    res.status(404).json({ error: "not_found", message: "Library file operation not found" });
  return operation;
}

export function registerFiles(router) {
  router.get("/files", requireAuth, requireAdmin, noCache, (_req, res) => {
    res.json({ operation: describeLibraryFileOperation(getLatestLibraryFileOperation()) });
  });

  router.get("/files/read-only-folders", requireAuth, requireAdmin, noCache, async (_req, res) => {
    try {
      res.json(await describeReadOnlyFolders());
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post("/files/read-only-folders", requireAuth, requireAdmin, async (req, res) => {
    try {
      res.status(201).json(await addReadOnlyFolder(req.body?.path));
    } catch (error) {
      sendError(res, error);
    }
  });

  router.delete("/files/read-only-folders", requireAuth, requireAdmin, async (req, res) => {
    try {
      res.json(await removeReadOnlyFolder(req.body?.path));
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post("/files/ingest/check", requireAuth, requireAdmin, async (req, res) => {
    try {
      res.json(await checkIngestSource({ sourcePath: req.body?.sourcePath, lidarrClient }));
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post("/files/ingest", requireAuth, requireAdmin, async (req, res) => {
    try {
      const operation = await startIngest({
        sourcePath: req.body?.sourcePath,
        mode: req.body?.mode,
        monitor: req.body?.monitor,
        fillTags: req.body?.fillTags === true,
      });
      res.status(202).json({ operation: describeLibraryFileOperation(operation) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post("/files/cleanup", requireAuth, requireAdmin, async (_req, res) => {
    try {
      const operation = await startCleanup();
      res.status(202).json({ operation: describeLibraryFileOperation(operation) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get("/files/operations/:id", requireAuth, requireAdmin, noCache, (req, res) => {
    const operation = findOperation(req, res);
    if (operation) res.json({ operation: describeLibraryFileOperation(operation) });
  });

  router.get("/files/operations/:id/items", requireAuth, requireAdmin, noCache, (req, res) => {
    const operation = findOperation(req, res);
    if (!operation) return;
    const statuses = String(req.query.status || "")
      .split(",")
      .map((status) => status.trim())
      .filter((status) => ITEM_STATUSES.has(status));
    const limit = Math.min(200, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));
    const offset = Math.max(0, Number.parseInt(req.query.offset, 10) || 0);
    res.json({
      items: describeLibraryFileOperationItems(operation, { statuses, offset, limit }),
      offset,
      limit,
    });
  });

  router.post("/files/operations/:id/cancel", requireAuth, requireAdmin, (req, res) => {
    const operation = findOperation(req, res);
    if (!operation) return;
    cancelLibraryFileOperation(operation.id);
    res.json({ operation: describeLibraryFileOperation(getLibraryFileOperation(operation.id)) });
  });

  router.post(
    "/files/operations/:id/remove-sources",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      const operation = findOperation(req, res);
      if (!operation) return;
      try {
        res.json({
          operation: describeLibraryFileOperation(await removeDuplicateFiles(operation.id)),
        });
      } catch (error) {
        sendError(res, error);
      }
    },
  );
}

export type LibraryFileOperationResponse = {
  operation: ReturnType<typeof describeLibraryFileOperation>;
};

export type CheckLibraryIngestSourceResponse = Awaited<ReturnType<typeof checkIngestSource>>;

export type LibraryFileOperationItemsResponse = {
  items: ReturnType<typeof describeLibraryFileOperationItems>;
  offset: number;
  limit: number;
};

import { noCache } from "../../../middleware/cache.js";
import { requireAdmin, requireAuth } from "../../../middleware/requirePermission.js";
import { dbOps } from "../../../db/helpers/index.js";
import { lidarrClient } from "../../../services/lidarrClient.js";
import { checkIngestSource } from "../../../services/libraryFiles/ingest.js";
import { enabledOrganizeActions } from "../../../services/libraryFiles/organize.js";
import {
  cancelLibraryFileOperation,
  confirmLibraryFileOperation,
  describeLibraryFileOperation,
  describeLibraryFileOperationItems,
  startIngest,
  startOrganize,
} from "../../../services/libraryFiles/operations.js";
import {
  getLatestLibraryFileOperation,
  getLibraryFileOperation,
} from "../../../services/libraryFiles/operationStore.js";

const ITEM_STATUSES = new Set(["new", "pending", "done", "duplicate", "conflict", "skipped", "failed"]);

function sendError(res, error) {
  if (error?.code === "LIBRARY_FILE_OPERATION_ACTIVE") {
    return res.status(409).json({
      error: "operation_active",
      message: error.message,
      operation: describeLibraryFileOperation(error.operation),
    });
  }
  if (error?.code === "INGEST_SOURCE_INVALID" || error?.code === "ORGANIZE_OPTIONS_INVALID") {
    return res.status(400).json({ error: "invalid_request", message: error.message });
  }
  return res.status(500).json({ error: "library_files_failed", message: error?.message || "Library file operation failed" });
}

function findOperation(req, res) {
  const operation = getLibraryFileOperation(req.params.id);
  if (!operation) res.status(404).json({ error: "not_found", message: "Library file operation not found" });
  return operation;
}

export function registerFiles(router) {
  router.get("/files", requireAuth, requireAdmin, noCache, (_req, res) => {
    const settings = dbOps.getSettings();
    res.json({
      enabledActions: enabledOrganizeActions(settings),
      operation: describeLibraryFileOperation(getLatestLibraryFileOperation()),
    });
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
      const operation = await startIngest({ sourcePath: req.body?.sourcePath, mode: req.body?.mode });
      res.status(202).json({ operation: describeLibraryFileOperation(operation) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post("/files/organize", requireAuth, requireAdmin, async (req, res) => {
    try {
      const operation = await startOrganize({ scope: req.body?.scope, actions: req.body?.actions });
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

  router.post("/files/operations/:id/start", requireAuth, requireAdmin, async (req, res) => {
    const operation = findOperation(req, res);
    if (!operation) return;
    if (!(await confirmLibraryFileOperation(operation.id))) {
      return res.status(409).json({
        error: "not_ready",
        message: "Only a finished preview can start.",
        operation: describeLibraryFileOperation(getLibraryFileOperation(operation.id)),
      });
    }
    res.status(202).json({ operation: describeLibraryFileOperation(getLibraryFileOperation(operation.id)) });
  });

  router.post("/files/operations/:id/cancel", requireAuth, requireAdmin, (req, res) => {
    const operation = findOperation(req, res);
    if (!operation) return;
    cancelLibraryFileOperation(operation.id);
    res.json({ operation: describeLibraryFileOperation(getLibraryFileOperation(operation.id)) });
  });
}

import { Hono, type Context } from "hono";
import * as v from "valibot";
import { noCache } from "../../../middleware/cacheHeaders.ts";
import { requireAdmin, requireAuth } from "../../../middleware/guards.ts";
import type { AppEnv } from "../../../middleware/requestUser.ts";
import { validate } from "../../../middleware/validate.ts";
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
  getLibraryFileOperationStatus,
  OperationConflictError,
} from "../../../services/libraryFiles/operationStore.ts";
import { asAppError } from "../../../../lib/errors.ts";

const ITEM_STATUSES = new Set([
  "new",
  "pending",
  "done",
  "duplicate",
  "conflict",
  "skipped",
  "failed",
]);

function sendError<E extends AppEnv>(c: Context<E>, error: unknown) {
  if (error instanceof OperationConflictError) {
    return c.json(
      {
        error: "operation_active",
        message: error.message,
        operation: describeLibraryFileOperation(error.operation),
      },
      409,
    );
  }
  const failure = asAppError(error);
  if (failure?.code === "INGEST_SOURCE_INVALID" || failure?.code === "READ_ONLY_FOLDER_INVALID") {
    return c.json({ error: "invalid_request", message: failure.message }, 400);
  }
  return c.json(
    { error: "library_files_failed", message: failure?.message || "Library file operation failed" },
    500,
  );
}

const operationNotFound = <E extends AppEnv>(c: Context<E>) =>
  c.json({ error: "not_found", message: "Library file operation not found" }, 404);

const folderInput = v.object({ path: v.optional(v.nullable(v.string())) });

const sourceInput = v.object({ sourcePath: v.optional(v.string()) });

const ingestInput = v.object({
  sourcePath: v.optional(v.string()),
  mode: v.optional(v.string()),
  monitor: v.optional(v.string()),
  fillTags: v.optional(v.boolean()),
});

const itemsQuery = v.object({
  status: v.optional(v.string()),
  limit: v.optional(v.string()),
  offset: v.optional(v.string()),
});

export default new Hono<AppEnv>()
  .basePath("/library")
  .get("/files", requireAuth, requireAdmin, noCache, (c) =>
    c.json({ operation: describeLibraryFileOperation(getLatestLibraryFileOperation()) }, 200),
  )
  .get("/files/read-only-folders", requireAuth, requireAdmin, noCache, async (c) => {
    try {
      return c.json(await describeReadOnlyFolders(), 200);
    } catch (error) {
      return sendError(c, error);
    }
  })
  .post(
    "/files/read-only-folders",
    requireAuth,
    requireAdmin,
    validate("json", folderInput),
    async (c) => {
      try {
        return c.json(await addReadOnlyFolder(c.req.valid("json").path), 201);
      } catch (error) {
        return sendError(c, error);
      }
    },
  )
  .delete(
    "/files/read-only-folders",
    requireAuth,
    requireAdmin,
    validate("json", folderInput),
    async (c) => {
      try {
        return c.json(await removeReadOnlyFolder(c.req.valid("json").path), 200);
      } catch (error) {
        return sendError(c, error);
      }
    },
  )
  .post(
    "/files/ingest/check",
    requireAuth,
    requireAdmin,
    validate("json", sourceInput),
    async (c) => {
      try {
        return c.json(
          await checkIngestSource({ sourcePath: c.req.valid("json").sourcePath, lidarrClient }),
          200,
        );
      } catch (error) {
        return sendError(c, error);
      }
    },
  )
  .post("/files/ingest", requireAuth, requireAdmin, validate("json", ingestInput), async (c) => {
    const { sourcePath, mode, monitor, fillTags } = c.req.valid("json");
    try {
      const operation = await startIngest({
        sourcePath,
        mode,
        monitor,
        fillTags: fillTags === true,
      });
      return c.json({ operation: describeLibraryFileOperation(operation) }, 202);
    } catch (error) {
      return sendError(c, error);
    }
  })
  .post("/files/cleanup", requireAuth, requireAdmin, async (c) => {
    try {
      const operation = await startCleanup();
      return c.json({ operation: describeLibraryFileOperation(operation) }, 202);
    } catch (error) {
      return sendError(c, error);
    }
  })
  .get("/files/operations/:id", requireAuth, requireAdmin, noCache, (c) => {
    const operation = getLibraryFileOperationStatus(c.req.param("id"));
    if (!operation) return operationNotFound(c);
    return c.json({ operation: describeLibraryFileOperation(operation) }, 200);
  })
  .get(
    "/files/operations/:id/items",
    requireAuth,
    requireAdmin,
    noCache,
    validate("query", itemsQuery),
    (c) => {
      const operation = getLibraryFileOperationStatus(c.req.param("id"));
      if (!operation) return operationNotFound(c);
      const query = c.req.valid("query");
      const statuses = String(query.status || "")
        .split(",")
        .map((status) => status.trim())
        .filter((status) => ITEM_STATUSES.has(status));
      const limit = Math.min(200, Math.max(1, Number.parseInt(query.limit ?? "", 10) || 50));
      const offset = Math.max(0, Number.parseInt(query.offset ?? "", 10) || 0);
      return c.json(
        {
          items: describeLibraryFileOperationItems(operation, { statuses, offset, limit }),
          offset,
          limit,
        },
        200,
      );
    },
  )
  .post("/files/operations/:id/cancel", requireAuth, requireAdmin, (c) => {
    const operation = getLibraryFileOperationStatus(c.req.param("id"));
    if (!operation) return operationNotFound(c);
    cancelLibraryFileOperation(operation.id);
    return c.json(
      { operation: describeLibraryFileOperation(getLibraryFileOperationStatus(operation.id)) },
      200,
    );
  })
  .post("/files/operations/:id/remove-sources", requireAuth, requireAdmin, async (c) => {
    const operation = getLibraryFileOperation(c.req.param("id"));
    if (!operation) return operationNotFound(c);
    try {
      return c.json(
        { operation: describeLibraryFileOperation(await removeDuplicateFiles(operation.id)) },
        200,
      );
    } catch (error) {
      return sendError(c, error);
    }
  });

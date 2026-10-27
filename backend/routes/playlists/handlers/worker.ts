import { Hono } from "hono";
import * as v from "valibot";
import { downloadTracker } from "../../../services/downloadJobs/downloadTracker.ts";
import { downloadWorker } from "../../../services/downloadJobs/downloadWorker.ts";
import { startDownloadPipelineWorker } from "../../../services/downloadPipelineWorker.ts";
import { playlistManager } from "../../../services/playlists/playlistManager.ts";
import { flowPlaylistConfig } from "../../../services/playlists/flowPlaylistConfig.ts";
import { playlistOperationQueue } from "../../../services/playlists/playlistOperationQueue.ts";
import { clearAllDownloadJobs } from "../../../services/downloadJobs/downloadCancellationService.ts";
import { logger } from "../../../services/logger.ts";
import { requireAdmin } from "../../../middleware/guards.ts";
import { validate } from "../../../middleware/validate.ts";
import { asAppError } from "../../../../lib/errors.ts";
import { EXISTING_FILE_MODE_OPTIONS, requireFlowAccess } from "./utils.ts";
import type { AppEnv } from "../../../middleware/requestUser.ts";

const workerSettings = v.object({
  concurrency: v.optional(v.union([v.number(), v.string()])),
  existingFileMode: v.optional(v.string()),
});

export default new Hono<AppEnv>()
  .basePath("/playlists")
  .get("/worker/settings", requireFlowAccess, requireAdmin, (c) =>
    c.json(downloadWorker.getWorkerSettings(), 200),
  )
  .put(
    "/worker/settings",
    requireFlowAccess,
    requireAdmin,
    validate("json", workerSettings),
    async (c) => {
      const { concurrency, existingFileMode } = c.req.valid("json");
      if (concurrency !== undefined) {
        const parsed = Number(concurrency);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 3) {
          return c.json({ error: "concurrency must be an integer between 1 and 3" }, 400);
        }
      }
      if (
        existingFileMode !== undefined &&
        !EXISTING_FILE_MODE_OPTIONS.includes(existingFileMode.trim().toLowerCase())
      ) {
        return c.json({ error: "existingFileMode must be one of: download, reuse" }, 400);
      }
      const settings = await downloadWorker.updateWorkerSettings({
        concurrency: concurrency === undefined ? undefined : Number(concurrency),
        existingFileMode,
      });
      return c.json({ success: true, settings }, 200);
    },
  )
  .post("/worker/start", requireFlowAccess, requireAdmin, async (c) => {
    try {
      void startDownloadPipelineWorker();
      await downloadWorker.start();
      return c.json({ success: true, message: "Worker started" }, 200);
    } catch (error) {
      return c.json({ error: "Failed to start worker", message: asAppError(error)?.message }, 500);
    }
  })
  .post("/worker/stop", requireFlowAccess, requireAdmin, async (c) => {
    try {
      await downloadWorker.stopAndDrain();
      return c.json({ success: true, message: "Worker stopped" }, 200);
    } catch (error) {
      return c.json({ error: "Failed to stop worker", message: asAppError(error)?.message }, 500);
    }
  })
  .delete("/jobs/completed", requireFlowAccess, requireAdmin, (c) =>
    c.json({ success: true, cleared: downloadTracker.clearCompleted() }, 200),
  )
  .delete("/jobs/all", requireFlowAccess, requireAdmin, async (c) => {
    try {
      const count = await clearAllDownloadJobs(downloadTracker);
      return c.json({ success: true, cleared: count }, 200);
    } catch (error) {
      logger.error("downloads", "Could not safely clear download jobs", {
        reason: asAppError(error)?.message || String(error),
      });
      return c.json(
        {
          error:
            "Some provider work could not be cancelled. Affected jobs were stopped in Aurral and marked failed. Retry clearing jobs after fixing the provider connection.",
        },
        500,
      );
    }
  })
  .post(
    "/reset",
    requireFlowAccess,
    requireAdmin,
    validate("json", v.object({ flowIds: v.nullish(v.array(v.string())) })),
    async (c) => {
      try {
        const { flowIds } = c.req.valid("json");
        const types = flowIds || flowPlaylistConfig.getFlows().map((flow) => flow.id);

        await playlistOperationQueue.enqueuePayload({
          kind: "reset-playlists",
          label: "reset:manual",
          playlistTypes: types,
        });

        return c.json(
          { success: true, message: `Weekly reset completed for: ${types.join(", ")}` },
          200,
        );
      } catch (error) {
        return c.json(
          { error: "Failed to perform weekly reset", message: asAppError(error)?.message },
          500,
        );
      }
    },
  )
  .post("/playlist/:playlistType/create", requireFlowAccess, requireAdmin, async (c) => {
    try {
      playlistManager.requestPlaylistSync();
      return c.json(
        {
          success: true,
          message:
            "Playlist sync queued. Media servers publish playlists after indexing downloaded tracks.",
        },
        200,
      );
    } catch (error) {
      return c.json(
        {
          error: "Failed to ensure playlists or trigger scan",
          message: asAppError(error)?.message,
        },
        500,
      );
    }
  });

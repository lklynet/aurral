import fsp from "fs/promises";
import { Hono } from "hono";
import * as v from "valibot";
import { downloadTracker } from "../../../services/downloadJobs/downloadTracker.ts";
import { playlistManager } from "../../../services/playlists/playlistManager.ts";
import {
  buildPlaylistTrackIdentity,
  flowPlaylistConfig,
  isRetiredFlow,
} from "../../../services/playlists/flowPlaylistConfig.ts";
import { playlistOperationQueue } from "../../../services/playlists/playlistOperationQueue.ts";
import { remapLegacyPath } from "../../../services/downloadPaths.ts";
import { downloadWorker } from "../../../services/downloadJobs/downloadWorker.ts";
import { schedulePlaylistMbidEnrichment } from "../../../services/playlistMbidEnrichmentService.ts";
import { buildLidarrImportListItems } from "../../../services/lidarrImportListFeed.ts";
import { withPlaylistMutationLock } from "../../../services/downloadJobs/mutationGuards.ts";
import {
  DEFAULT_LIMIT,
  validateFlowPayload,
  markFlowMutationToken,
  isFlowMutationTokenCurrent,
  restoreFlowMutationToken,
  getAccessibleFlow,
  queueFlowSideEffect,
  enqueueResearchTrack,
  requireFlowAccess,
} from "./utils.ts";
import {
  markPlaylistDownloadWorkCancelled,
  restoreMarkedPlaylistDownloadWork,
} from "../../../services/downloadJobs/downloadCancellationService.ts";
import { buildFlowFromTemplate, listFlowTemplates } from "../../../services/flows/flowTemplates.ts";
import { asAppError } from "../../../../lib/errors.ts";
import { validate } from "../../../middleware/validate.ts";
import { errorStatus } from "../../shared/errorStatus.ts";
import type { AppEnv } from "../../../middleware/requestUser.ts";
import type { DownloadJob } from "../../../services/downloadJobs/downloadTracker.ts";

const RETIRED_FLOW_MESSAGE = "This flow's source was retired, so it no longer updates";

const count = v.union([v.number(), v.string()]);
const flowFields = {
  mix: v.nullish(
    v.object({
      discover: v.nullish(count),
      mix: v.nullish(count),
      trending: v.nullish(count),
      focus: v.nullish(count),
    }),
  ),
  size: v.nullish(count),
  deepDive: v.nullish(v.boolean()),
  recordHistory: v.optional(v.boolean()),
  yearFrom: v.nullish(count),
  yearTo: v.nullish(count),
  tags: v.nullish(v.array(v.string())),
  relatedArtists: v.nullish(v.array(v.string())),
  scheduleDays: v.nullish(v.array(count)),
  scheduleTime: v.nullish(v.string()),
};
const flowCreate = v.object({
  ...flowFields,
  name: v.nullish(v.string(), ""),
  templateId: v.nullish(v.string()),
});
const flowUpdate = v.object({
  ...flowFields,
  name: v.optional(v.string()),
  showInLibrary: v.optional(v.boolean()),
});

export default new Hono<AppEnv>()
  .basePath("/playlists")
  .post(
    "/start/:flowId",
    requireFlowAccess,
    validate("json", v.object({ limit: v.nullish(count) })),
    async (c) => {
      try {
        const flowId = c.req.param("flowId");
        const { limit } = c.req.valid("json");
        const flow = getAccessibleFlow(c.var.user, flowId);
        if (!flow) {
          return c.json({ error: "Flow not found" }, 404);
        }
        if (isRetiredFlow(flow)) {
          return c.json({ error: RETIRED_FLOW_MESSAGE, message: RETIRED_FLOW_MESSAGE }, 409);
        }

        const { token, tokenScope } = markFlowMutationToken(flowId);
        const result = await playlistOperationQueue.enqueuePayload({
          kind: "manual-start-flow",
          label: `manual-start:${flowId}`,
          flowId,
          tokenScope,
          token,
          size:
            Number.isFinite(Number(limit)) && Number(limit) > 0
              ? Number(limit)
              : flow.size || DEFAULT_LIMIT,
        });

        return c.json(
          {
            success: true,
            flowId,
            queued: true,
            operationId: result.operationId,
          },
          200,
        );
      } catch (error) {
        return c.json({ error: "Failed to start flow", message: asAppError(error)?.message }, 500);
      }
    },
  )
  .get("/flow-templates", requireFlowAccess, async (c) => {
    try {
      return c.json({ templates: await listFlowTemplates(c.var.user) }, 200);
    } catch (error) {
      return c.json(
        { error: "Failed to load flow templates", message: asAppError(error)?.message },
        500,
      );
    }
  })
  .post("/flows", requireFlowAccess, validate("json", flowCreate), async (c) => {
    try {
      const user = c.var.user;
      const ownerUserId = Number(user.id);
      if (!Number.isSafeInteger(ownerUserId) || ownerUserId <= 0) {
        return c.json(
          {
            error: "Flow ownership requires a real user",
            message: "Authenticate as a user account before creating a flow.",
          },
          400,
        );
      }
      const { templateId, ...fields } = c.req.valid("json");
      let template = null;
      if (templateId) {
        try {
          template = await buildFlowFromTemplate(user, templateId);
        } catch (error) {
          const failure = asAppError(error);
          if (!failure?.statusCode) throw error;
          return c.json({ error: failure.message, message: failure.message }, errorStatus(failure));
        }
        if (fields.name.trim()) template.name = fields.name.trim();
      }
      const payload = template ?? fields;
      const validationError = validateFlowPayload(payload);
      if (validationError) {
        return c.json({ error: validationError, message: validationError }, 400);
      }
      const flow = flowPlaylistConfig.createFlow({ ...payload, ownerUserId });
      await playlistManager.ensurePlaylistArtwork(flow.id);
      playlistManager.requestPlaylistSync([flow.id]);
      return c.json({ success: true, flow }, 200);
    } catch (error) {
      const failure = asAppError(error);
      if (failure?.code === "FLOW_NAME_CONFLICT") {
        return c.json({ error: "Flow name already exists", message: failure.message }, 400);
      }
      return c.json({ error: "Failed to create flow", message: failure?.message }, 500);
    }
  })
  .put("/flows/:flowId", requireFlowAccess, validate("json", flowUpdate), async (c) => {
    try {
      const flowId = c.req.param("flowId");
      const existingFlow = getAccessibleFlow(c.var.user, flowId);
      if (!existingFlow) {
        return c.json({ error: "Flow not found" }, 404);
      }
      const body = c.req.valid("json");
      const validationError = validateFlowPayload({ ...existingFlow, ...body });
      if (validationError) {
        return c.json({ error: validationError, message: validationError }, 400);
      }
      const { yearFrom: _yearFrom, yearTo: _yearTo, ...updates } = body;
      const updated = await withPlaylistMutationLock(flowId, () =>
        flowPlaylistConfig.updateFlow(flowId, {
          ...updates,
          ...(Object.hasOwn(body, "yearFrom") ? { yearFrom: body.yearFrom } : {}),
          ...(Object.hasOwn(body, "yearTo") ? { yearTo: body.yearTo } : {}),
        }),
      );
      if (!updated) {
        return c.json({ error: "Flow not found" }, 404);
      }
      if (typeof body.showInLibrary === "boolean") {
        playlistManager.scheduleScanLibrary();
      }
      playlistManager.requestPlaylistSync([flowId]);
      return c.json({ success: true, flow: updated }, 200);
    } catch (error) {
      const failure = asAppError(error);
      if (failure?.code === "FLOW_NAME_CONFLICT") {
        return c.json({ error: "Flow name already exists", message: failure.message }, 400);
      }
      return c.json({ error: "Failed to update flow", message: failure?.message }, 500);
    }
  })
  .delete("/flows/:flowId", requireFlowAccess, async (c) => {
    try {
      const flowId = c.req.param("flowId");
      if (!getAccessibleFlow(c.var.user, flowId)) {
        return c.json({ error: "Flow not found" }, 404);
      }
      const jobs = downloadTracker.getByPlaylistId(flowId);
      const cancellation = markPlaylistDownloadWorkCancelled(flowId, jobs);
      const mutation = markFlowMutationToken(flowId);
      let deleted;
      try {
        deleted = await playlistOperationQueue.enqueuePayload({
          kind: "delete-flow",
          label: `delete:${flowId}`,
          flowId,
          tokenScope: mutation.tokenScope,
          token: mutation.token,
        });
      } catch (error) {
        restoreMarkedPlaylistDownloadWork(flowId, cancellation);
        restoreFlowMutationToken(mutation);
        throw error;
      }
      return c.json({ success: true, flowId, queued: true, operationId: deleted.operationId }, 200);
    } catch (error) {
      return c.json({ error: "Failed to delete flow", message: asAppError(error)?.message }, 500);
    }
  })
  .put(
    "/flows/:flowId/enabled",
    requireFlowAccess,
    validate("json", v.object({ enabled: v.boolean() })),
    async (c) => {
      try {
        const flowId = c.req.param("flowId");
        const { enabled } = c.req.valid("json");
        const flow = getAccessibleFlow(c.var.user, flowId);
        if (!flow) {
          return c.json({ error: "Flow not found" }, 404);
        }

        if (enabled) {
          if (isRetiredFlow(flow)) {
            return c.json({ error: RETIRED_FLOW_MESSAGE, message: RETIRED_FLOW_MESSAGE }, 409);
          }
          flowPlaylistConfig.setEnabled(flowId, true);
          flowPlaylistConfig.scheduleNextRun(flowId);
          playlistManager.requestPlaylistSync([flowId]);
          queueFlowSideEffect("enable-flow-refresh", "enable", flowId);
          return c.json(
            {
              success: true,
              flowId,
              enabled: true,
              message: "Flow enabled. Queuing tracks…",
            },
            200,
          );
        }
        const wasEnabled = flow.enabled === true;
        const jobs = downloadTracker.getByPlaylistId(flowId);
        const cancellation = markPlaylistDownloadWorkCancelled(flowId, jobs);
        flowPlaylistConfig.setEnabled(flowId, false);
        const mutation = markFlowMutationToken(flowId);

        let queued;
        try {
          queued = await playlistOperationQueue.enqueuePayload({
            kind: "disable-flow-cleanup",
            label: `disable:${flowId}`,
            flowId,
            tokenScope: mutation.tokenScope,
            token: mutation.token,
          });
        } catch (error) {
          if (!isFlowMutationTokenCurrent(mutation)) throw error;
          flowPlaylistConfig.setEnabled(flowId, wasEnabled);
          if (wasEnabled) flowPlaylistConfig.scheduleNextRun(flowId);
          restoreMarkedPlaylistDownloadWork(flowId, cancellation);
          restoreFlowMutationToken(mutation);
          throw error;
        }
        playlistManager.requestPlaylistSync([flowId]);
        return c.json(
          { success: true, flowId, enabled: false, queued: true, operationId: queued.operationId },
          200,
        );
      } catch (error) {
        return c.json({ error: "Failed to update flow", message: asAppError(error)?.message }, 500);
      }
    },
  )
  .post(
    "/flows/:flowId/static-playlist",
    requireFlowAccess,
    validate("json", v.object({ name: v.nullish(v.string()) })),
    async (c) => {
      let playlist = null;
      try {
        const flowId = c.req.param("flowId");
        const flow = getAccessibleFlow(c.var.user, flowId);
        if (!flow) {
          return c.json({ error: "Flow not found" }, 404);
        }

        const requestedName = String(c.req.valid("json").name || "").trim();
        const flowJobs = downloadTracker.getByPlaylistType(flowId);
        const completedJobs = flowJobs.filter(
          (job) => job?.status === "done" && typeof job?.finalPath === "string",
        );
        if (completedJobs.length === 0) {
          return c.json(
            {
              error: "No completed tracks available",
              message: "Download at least one flow track before saving a playlist.",
            },
            400,
          );
        }

        const uniqueCompletedJobsByIdentity = new Map<string, DownloadJob>();
        for (const job of completedJobs) {
          const identity = buildPlaylistTrackIdentity(job);
          if (uniqueCompletedJobsByIdentity.has(identity)) continue;
          uniqueCompletedJobsByIdentity.set(identity, job);
        }
        const uniqueCompletedJobs = [...uniqueCompletedJobsByIdentity.values()];
        const trackFromJob = (job: DownloadJob) => ({
          artistName: job.artistName,
          trackName: job.trackName,
          albumName: job.albumName || null,
          artistMbid: job.artistMbid || null,
          albumMbid: job.albumMbid || null,
          releaseMbid: job.releaseMbid || null,
          trackMbid: job.trackMbid || null,
          releaseYear: job.releaseYear || null,
          durationMs: job.durationMs || null,
          trackNumber: job.trackNumber || null,
          discNumber: job.discNumber || null,
          artistAliases: job.artistAliases || [],
          reason: job.reason || null,
        });
        const tracks = uniqueCompletedJobs.map(trackFromJob);
        playlist = flowPlaylistConfig.createStaticPlaylist({
          name: requestedName || `${flow.name} Static`,
          sourceName: flow.name,
          sourceFlowId: flowId,
          recordHistory: flow.recordHistory !== false,
          tracks,
          ownerUserId: flow.ownerUserId ?? c.var.user.id,
        });

        for (const job of uniqueCompletedJobs) {
          const safeSourcePath = remapLegacyPath(job.finalPath, downloadWorker.downloadRoot);
          const stat = await fsp.stat(safeSourcePath);
          if (!stat.isFile()) {
            throw new Error(`Track file is missing: ${job.finalPath}`);
          }

          const jobId = downloadTracker.addJob(trackFromJob(job), playlist.id);
          if (jobId) {
            downloadTracker.setDone(jobId, safeSourcePath, job.albumName || null);
          }
        }

        await playlistManager.ensurePlaylistArtwork(playlist.id);
        playlistManager.requestPlaylistSync([playlist.id]);
        await playlistManager.scheduleScanLibrary(true);
        schedulePlaylistMbidEnrichment(playlist.id, {
          reason: "flow-static-playlist",
          priority: 5,
        });

        return c.json({ success: true, playlist, trackCount: uniqueCompletedJobs.length }, 200);
      } catch (error) {
        const failure = asAppError(error);
        if (playlist?.id) {
          try {
            await playlistManager.weeklyReset([playlist.id]);
            flowPlaylistConfig.deleteStaticPlaylist(playlist.id);
          } catch {}
        }
        if (failure?.code === "STATIC_PLAYLIST_NAME_CONFLICT") {
          return c.json({ error: "Playlist name already exists", message: failure.message }, 400);
        }
        return c.json(
          { error: "Failed to create static playlist", message: failure?.message },
          500,
        );
      }
    },
  )
  .post("/flows/:flowId/tracks/:jobId/research", requireFlowAccess, async (c) => {
    try {
      return await enqueueResearchTrack(
        c,
        c.var.user,
        c.req.param("flowId"),
        c.req.param("jobId"),
        "flow",
      );
    } catch (error) {
      return c.json(
        { error: "Failed to re-search flow track", message: asAppError(error)?.message },
        500,
      );
    }
  })
  .get("/flows/:flowId/lidarr-import-list", requireFlowAccess, (c) => {
    const flowId = c.req.param("flowId");
    const flow = getAccessibleFlow(c.var.user, flowId);
    if (!flow) {
      return c.json({ error: "Flow not found" }, 404);
    }
    const ensured = flowPlaylistConfig.ensureLidarrFeedToken(flowId);
    if (!ensured?.lidarrFeedToken) {
      return c.json({ error: "Flow not found" }, 404);
    }
    return c.json(
      {
        token: ensured.lidarrFeedToken,
        itemCount: buildLidarrImportListItems(downloadTracker.getByPlaylistType(flowId)).length,
      },
      200,
    );
  });

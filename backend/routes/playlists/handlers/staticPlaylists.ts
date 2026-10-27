import { Hono } from "hono";
import * as v from "valibot";
import {
  cleanupBulkOperations,
  getBulkOperation,
} from "../../../services/playlists/bulkOperationStore.ts";
import {
  captureStaticPlaylistSelection,
  getSharedDownloadReferences,
} from "../../../services/playlists/trackRemoval.ts";
import { randomUUID } from "crypto";
import { downloadTracker } from "../../../services/downloadJobs/downloadTracker.ts";
import { downloadWorker } from "../../../services/downloadJobs/downloadWorker.ts";
import {
  dedupePlaylistTracks,
  flowPlaylistConfig,
  normalizeImportSource,
} from "../../../services/playlists/flowPlaylistConfig.ts";
import { playlistOperationQueue } from "../../../services/playlists/playlistOperationQueue.ts";
import { syncStaticPlaylistImport } from "../../../services/importLists/importListSync.ts";
import { wakeDownloadWorker } from "../../../services/downloadJobs/mutationGuards.ts";
import {
  enqueueResearchTrack,
  getAccessibleStaticPlaylist,
  pauseStaticPlaylistRetryCycle,
  requireFlowAccess,
} from "./utils.ts";
import {
  markDownloadWorkCancelledForJobs,
  markPlaylistDownloadWorkCancelled,
  restoreMarkedPlaylistDownloadWork,
} from "../../../services/downloadJobs/downloadCancellationService.ts";
import {
  isDownloadJobCancelled,
  restoreDownloadJobCancellations,
} from "../../../services/downloadJobs/downloadCancellation.ts";
import { asAppError } from "../../../../lib/errors.ts";
import { validate } from "../../../middleware/validate.ts";
import { errorStatus } from "../../shared/errorStatus.ts";
import type { Context } from "hono";
import type { AppEnv, RequestUser } from "../../../middleware/requestUser.ts";

const text = v.nullish(v.union([v.string(), v.number()]));
const playlistTrack = v.object({
  artistName: text,
  artist: text,
  artist_name: text,
  "Artist Name(s)": text,
  trackName: text,
  title: text,
  name: text,
  track: text,
  "Track Name": text,
  albumName: text,
  album: text,
  "Album Name": text,
  artistMbid: text,
  artistId: text,
  albumMbid: text,
  releaseGroupMbid: text,
  albumId: text,
  trackMbid: text,
  recordingMbid: text,
  recordingId: text,
  mbid: text,
  releaseMbid: text,
  releaseYear: text,
  year: text,
  durationMs: text,
  trackNumber: text,
  discNumber: text,
  artistAliases: v.nullish(v.array(text)),
  reason: text,
  canonicalJobId: text,
  libraryJobId: text,
  membershipId: text,
});
const playlistTracks = v.nullish(v.array(playlistTrack));

const playlistInput = v.object({
  name: v.nullish(v.string()),
  sourceName: v.nullish(v.string(), null),
  sourceFlowId: v.nullish(v.string(), null),
  tracks: playlistTracks,
});
const enabledInput = v.object({ enabled: v.boolean() });
const bulkInput = v.object({ jobIds: v.array(v.string()) });
const moveInput = v.object({
  jobIds: v.array(v.string()),
  target: v.nullish(v.object({ playlistId: v.optional(v.string()), name: v.optional(v.string()) })),
});
const playlistUpdate = v.object({
  name: v.nullish(v.string()),
  tracks: playlistTracks,
  importSource: v.nullish(
    v.object({
      provider: v.optional(v.string()),
      externalId: v.nullish(v.string()),
      externalUsername: v.nullish(v.string()),
      externalName: v.nullish(v.string()),
      syncEnabled: v.optional(v.boolean()),
      syncIntervalHours: v.nullish(v.union([v.number(), v.string()])),
      keepRemovedTracks: v.optional(v.boolean()),
    }),
  ),
});

async function createOrImportStaticPlaylist<E extends AppEnv>(
  c: Context<E>,
  user: RequestUser,
  { name, sourceName, sourceFlowId, tracks }: v.InferOutput<typeof playlistInput>,
  { requireTracks, label }: { requireTracks: boolean; label: string },
) {
  const safeName = String(name || "").trim();
  const normalizedTracks = Array.isArray(tracks) ? dedupePlaylistTracks(tracks) : [];

  if (!safeName) {
    return c.json({ error: "name is required" }, 400);
  }
  if (requireTracks && normalizedTracks.length === 0) {
    return c.json(
      { error: "tracks are required", message: "Import file must include at least one track" },
      400,
    );
  }
  if (tracks?.length && normalizedTracks.length === 0) {
    return c.json({ error: "tracks are invalid", message: "Add at least one valid track" }, 400);
  }

  const playlistId = randomUUID();
  const result = await playlistOperationQueue.enqueuePayload({
    kind: "shared-playlist-create",
    label,
    playlistId,
    name: safeName,
    sourceName,
    sourceFlowId,
    tracks: normalizedTracks,
    ownerUserId: user.id,
  });

  return c.json({ success: true, playlistId, queued: true, operationId: result.operationId }, 200);
}

const nameConflict = <E extends AppEnv>(c: Context<E>, error: unknown, fallback: string) => {
  const failure = asAppError(error);
  if (failure?.code === "STATIC_PLAYLIST_NAME_CONFLICT") {
    return c.json({ error: "Playlist name already exists", message: failure.message }, 400);
  }
  return c.json({ error: fallback, message: failure?.message }, 500);
};

async function enqueueBulkAction<E extends AppEnv>(
  c: Context<E>,
  user: RequestUser,
  playlistId: string,
  action: "remove" | "move",
  { jobIds, target: requestedTarget }: v.InferOutput<typeof moveInput>,
) {
  const source = getAccessibleStaticPlaylist(user, playlistId);
  if (!source) return c.json({ error: "Playlist not found" }, 404);
  if (!jobIds.length || jobIds.some((id) => !id.trim())) {
    return c.json({ error: "jobIds must contain at least one track ID" }, 400);
  }
  const ids = [...new Set(jobIds.map((id) => id.trim()))];
  let target = null;
  if (action === "move") {
    const targetId = requestedTarget?.playlistId?.trim() ?? "";
    const name = requestedTarget?.name?.trim() ?? "";
    if (Boolean(targetId) === Boolean(name)) {
      return c.json({ error: "Specify a destination playlist ID or name" }, 400);
    }
    if (targetId === source.id) {
      return c.json({ error: "Choose a different destination playlist" }, 400);
    }
    if (targetId && !getAccessibleStaticPlaylist(user, targetId)) {
      return c.json({ error: "Destination playlist not found" }, 404);
    }
    target = targetId ? { playlistId: targetId } : { playlistId: randomUUID(), name, create: true };
  }
  const selections = [];
  const rejected = [];
  for (const jobId of ids) {
    const selection = captureStaticPlaylistSelection(source, jobId);
    if (selection) selections.push(selection);
    else rejected.push({ jobId, message: "Track not found in this playlist" });
  }
  if (!selections.length) return c.json({ queued: false, acceptedJobIds: [], rejected }, 200);
  const result = await playlistOperationQueue.enqueueBulkPayload({
    ownerUserId: user.id,
    sourcePlaylistId: source.id,
    action,
    target,
    selections,
  });
  return c.json(
    { ...result, acceptedJobIds: selections.map((selection) => selection.jobId), rejected },
    200,
  );
}

const bulkActionFailed = <E extends AppEnv>(c: Context<E>, error: unknown) =>
  c.json({ error: "Failed to queue playlist action", message: asAppError(error)?.message }, 500);

export default new Hono<AppEnv>()
  .basePath("/playlists")
  .post(
    "/shared-playlists/:playlistId/track-removals",
    requireFlowAccess,
    validate("json", bulkInput),
    async (c) => {
      try {
        return await enqueueBulkAction(
          c,
          c.var.user,
          c.req.param("playlistId"),
          "remove",
          c.req.valid("json"),
        );
      } catch (error) {
        return bulkActionFailed(c, error);
      }
    },
  )
  .post(
    "/shared-playlists/:playlistId/track-moves",
    requireFlowAccess,
    validate("json", moveInput),
    async (c) => {
      try {
        return await enqueueBulkAction(
          c,
          c.var.user,
          c.req.param("playlistId"),
          "move",
          c.req.valid("json"),
        );
      } catch (error) {
        return bulkActionFailed(c, error);
      }
    },
  )
  .get("/shared-playlists/:playlistId/operations/:operationId", requireFlowAccess, (c) => {
    try {
      const playlistId = c.req.param("playlistId");
      cleanupBulkOperations();
      const record = getBulkOperation(c.req.param("operationId"));
      if (
        !record ||
        record.ownerUserId !== c.var.user.id ||
        record.sourcePlaylistId !== playlistId ||
        !getAccessibleStaticPlaylist(c.var.user, playlistId)
      ) {
        return c.json({ error: "Playlist operation not found" }, 404);
      }
      return c.json(
        {
          operationId: record.operationId,
          state: record.state,
          action: record.action,
          outcomes: record.outcomes,
          targetPlaylistId: record.target?.playlistId || null,
          message: record.message || null,
        },
        200,
      );
    } catch (error) {
      return c.json(
        { error: "Failed to read playlist operation", message: asAppError(error)?.message },
        500,
      );
    }
  })
  .post("/shared-playlists", requireFlowAccess, validate("json", playlistInput), async (c) => {
    try {
      return await createOrImportStaticPlaylist(c, c.var.user, c.req.valid("json"), {
        requireTracks: false,
        label: "shared-playlist:create",
      });
    } catch (error) {
      return nameConflict(c, error, "Failed to create playlist");
    }
  })
  .post(
    "/shared-playlists/import",
    requireFlowAccess,
    validate("json", playlistInput),
    async (c) => {
      try {
        return await createOrImportStaticPlaylist(c, c.var.user, c.req.valid("json"), {
          requireTracks: true,
          label: "shared-playlist:import",
        });
      } catch (error) {
        return nameConflict(c, error, "Failed to import playlist");
      }
    },
  )
  .post(
    "/shared-playlists/:playlistId/tracks",
    requireFlowAccess,
    validate("json", v.object({ tracks: playlistTracks })),
    async (c) => {
      try {
        const playlistId = c.req.param("playlistId");
        if (!getAccessibleStaticPlaylist(c.var.user, playlistId)) {
          return c.json({ error: "Playlist not found" }, 404);
        }
        const { tracks } = c.req.valid("json");
        const normalizedTracks = Array.isArray(tracks) ? dedupePlaylistTracks(tracks) : [];
        if (tracks?.length && normalizedTracks.length === 0) {
          return c.json(
            { error: "tracks are invalid", message: "Add at least one valid track" },
            400,
          );
        }
        if (normalizedTracks.length === 0) {
          return c.json(
            { error: "tracks are required", message: "Add at least one valid track" },
            400,
          );
        }

        const result = await playlistOperationQueue.enqueuePayload({
          kind: "shared-playlist-append-tracks",
          label: `shared-playlist:${playlistId}:tracks:add`,
          playlistId,
          tracks: normalizedTracks,
        });

        return c.json(
          { success: true, playlistId, queued: true, operationId: result.operationId },
          200,
        );
      } catch (error) {
        return c.json(
          { error: "Failed to add playlist tracks", message: asAppError(error)?.message },
          500,
        );
      }
    },
  )
  .put(
    "/shared-playlists/:playlistId/track-availability",
    requireFlowAccess,
    validate("json", enabledInput),
    (c) => {
      const playlistId = c.req.param("playlistId");
      if (!getAccessibleStaticPlaylist(c.var.user, playlistId)) {
        return c.json({ error: "Playlist not found" }, 404);
      }
      const playlist = flowPlaylistConfig.updateStaticPlaylist(playlistId, {
        showTrackAvailability: c.req.valid("json").enabled,
      });
      return c.json({ success: true, showTrackAvailability: playlist!.showTrackAvailability }, 200);
    },
  )
  .put(
    "/shared-playlists/:playlistId/record-history",
    requireFlowAccess,
    validate("json", enabledInput),
    (c) => {
      const playlistId = c.req.param("playlistId");
      if (!getAccessibleStaticPlaylist(c.var.user, playlistId)) {
        return c.json({ error: "Playlist not found" }, 404);
      }
      const playlist = flowPlaylistConfig.updateStaticPlaylist(playlistId, {
        recordHistory: c.req.valid("json").enabled,
      });
      return c.json({ success: true, recordHistory: playlist!.recordHistory }, 200);
    },
  )
  .put(
    "/shared-playlists/:playlistId",
    requireFlowAccess,
    validate("json", playlistUpdate),
    async (c) => {
      try {
        const playlistId = c.req.param("playlistId");
        const body = c.req.valid("json");
        const hasNameUpdate = Object.hasOwn(body, "name");
        const hasTracksUpdate = Object.hasOwn(body, "tracks");
        const hasImportSourceUpdate = Object.hasOwn(body, "importSource");
        if (!hasNameUpdate && !hasTracksUpdate && !hasImportSourceUpdate) {
          return c.json({ error: "At least one playlist field is required" }, 400);
        }
        const currentPlaylist = getAccessibleStaticPlaylist(c.var.user, playlistId);
        if (!currentPlaylist) {
          return c.json({ error: "Playlist not found" }, 404);
        }
        const safeName = hasNameUpdate
          ? String(body.name || "").trim()
          : String(currentPlaylist.name || "").trim();
        if (!safeName) {
          return c.json({ error: "name is required" }, 400);
        }
        const normalizedTracks = hasTracksUpdate
          ? dedupePlaylistTracks(body.tracks)
          : currentPlaylist.tracks;
        if (hasTracksUpdate && body.tracks?.length && normalizedTracks.length === 0) {
          return c.json(
            {
              error: "tracks are invalid",
              message: "Playlist update must include at least one valid track",
            },
            400,
          );
        }
        let importSource = null;
        if (hasImportSourceUpdate) {
          if (!currentPlaylist.importSource) {
            return c.json({ error: "Playlist has no import source" }, 400);
          }
          importSource = normalizeImportSource({
            ...currentPlaylist.importSource,
            ...body.importSource,
          });
          if (!importSource) {
            return c.json({ error: "importSource is invalid" }, 400);
          }
        }

        const result = await playlistOperationQueue.enqueuePayload({
          kind: "shared-playlist-update",
          label: `shared-playlist:${playlistId}:update`,
          playlistId,
          name: safeName,
          tracks: normalizedTracks,
          hasNameUpdate,
          hasTracksUpdate,
          hasImportSourceUpdate,
          importSource,
        });
        return c.json(
          { success: true, playlistId, queued: true, operationId: result.operationId },
          200,
        );
      } catch (error) {
        return nameConflict(c, error, "Failed to update playlist");
      }
    },
  )
  .delete("/shared-playlists/:playlistId/tracks/:jobId", requireFlowAccess, async (c) => {
    try {
      const playlistId = c.req.param("playlistId");
      const jobId = c.req.param("jobId");
      const playlist = getAccessibleStaticPlaylist(c.var.user, playlistId);
      if (!playlist) {
        return c.json({ error: "Playlist not found" }, 404);
      }
      const job = downloadTracker.getJob(jobId);
      const playlistReferencesJob = playlist.tracks?.some(
        (track) => String(track?.canonicalJobId || "") === String(jobId || ""),
      );
      if (!job || (job.playlistType !== playlistId && !playlistReferencesJob)) {
        return c.json({ error: "Track not found" }, 404);
      }
      const shouldCancelJob =
        !playlistReferencesJob && getSharedDownloadReferences(job.id, playlistId).length === 0;
      const wasJobCancelled = isDownloadJobCancelled(job.id);
      if (shouldCancelJob) {
        markDownloadWorkCancelledForJobs([job]);
      }
      let result;
      try {
        result = await playlistOperationQueue.enqueuePayload({
          kind: "shared-playlist-delete-track",
          label: `shared-playlist:${playlistId}:track:${jobId}:delete`,
          playlistId,
          jobId,
        });
      } catch (error) {
        if (shouldCancelJob && !wasJobCancelled) {
          restoreDownloadJobCancellations([job.id]);
        }
        throw error;
      }

      return c.json(
        {
          success: true,
          playlistId,
          removedJobId: jobId,
          queued: true,
          operationId: result.operationId,
        },
        200,
      );
    } catch (error) {
      return c.json(
        { error: "Failed to remove playlist track", message: asAppError(error)?.message },
        500,
      );
    }
  })
  .post("/shared-playlists/:playlistId/tracks/:jobId/research", requireFlowAccess, async (c) => {
    try {
      return await enqueueResearchTrack(
        c,
        c.var.user,
        c.req.param("playlistId"),
        c.req.param("jobId"),
        "shared-playlist",
      );
    } catch (error) {
      return c.json(
        { error: "Failed to re-search playlist track", message: asAppError(error)?.message },
        500,
      );
    }
  })
  .delete("/shared-playlists/:playlistId", requireFlowAccess, async (c) => {
    try {
      const playlistId = c.req.param("playlistId");
      if (!getAccessibleStaticPlaylist(c.var.user, playlistId)) {
        return c.json({ error: "Playlist not found" }, 404);
      }
      const ownedJobs = downloadTracker.getByPlaylistId(playlistId);
      const retainsDownloads = ownedJobs.some(
        (job) => getSharedDownloadReferences(job.id, playlistId).length > 0,
      );
      const cancellation = retainsDownloads
        ? null
        : markPlaylistDownloadWorkCancelled(playlistId, ownedJobs);

      let deleted;
      try {
        deleted = await playlistOperationQueue.enqueuePayload({
          kind: "shared-playlist-delete",
          label: `shared-playlist:${playlistId}:delete`,
          playlistId,
        });
      } catch (error) {
        if (cancellation) restoreMarkedPlaylistDownloadWork(playlistId, cancellation);
        throw error;
      }
      return c.json(
        { success: true, playlistId, queued: true, operationId: deleted.operationId },
        200,
      );
    } catch (error) {
      return c.json(
        { error: "Failed to delete playlist", message: asAppError(error)?.message },
        500,
      );
    }
  })
  .post("/shared-playlists/:playlistId/sync", requireFlowAccess, async (c) => {
    try {
      const playlist = getAccessibleStaticPlaylist(c.var.user, c.req.param("playlistId"));
      if (!playlist) {
        return c.json({ error: "Playlist not found" }, 404);
      }
      const result = await syncStaticPlaylistImport({
        playlistId: playlist.id,
        user: c.var.user,
        force: true,
      });
      return c.json({ success: true, ...result }, 200);
    } catch (error) {
      const failure = asAppError(error);
      return c.json(
        { error: "Failed to sync playlist", message: failure?.message || "Unknown error" },
        errorStatus(failure),
      );
    }
  })
  .put(
    "/playlists/:playlistId/retry-cycle",
    requireFlowAccess,
    validate("json", v.object({ paused: v.boolean() })),
    async (c) => {
      try {
        const playlistId = c.req.param("playlistId");
        const { paused } = c.req.valid("json");
        if (!getAccessibleStaticPlaylist(c.var.user, playlistId)) {
          return c.json({ error: "Static playlist not found" }, 404);
        }
        if (paused) {
          await pauseStaticPlaylistRetryCycle(playlistId);
        } else {
          await downloadWorker.setRetryCyclePaused(playlistId, false);
          await wakeDownloadWorker();
        }
        return c.json({ success: true, playlistId, paused }, 200);
      } catch (error) {
        return c.json(
          { error: "Failed to update retry cycle", message: asAppError(error)?.message },
          500,
        );
      }
    },
  );

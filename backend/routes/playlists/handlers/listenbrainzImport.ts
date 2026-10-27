import { Hono } from "hono";
import * as v from "valibot";
import {
  enqueueImportedPlaylist,
  fetchImportedPlaylistTracks,
} from "../../../services/importLists/importPlaylist.ts";
import { listenbrainzPlaylistClient } from "../../../services/importLists/listenbrainzPlaylists.ts";
import { logger, safeLogDiagnostic } from "../../../services/logger.ts";
import { asAppError } from "../../../../lib/errors.ts";
import { validate } from "../../../middleware/validate.ts";
import { isErrorStatus } from "../../shared/errorStatus.ts";
import { importSettings, requireFlowAccess } from "./utils.ts";
import type { AppEnv } from "../../../middleware/requestUser.ts";

const getErrorStatus = (error: unknown) => {
  const failure = asAppError(error);
  const status = failure?.statusCode || failure?.response?.status;
  return isErrorStatus(status) ? status : 500;
};

const playlistReference = {
  playlistType: v.nullish(v.string()),
  playlistId: v.nullish(v.string()),
};

const getPlaylistImport = ({
  playlistType,
  playlistId,
}: {
  playlistType?: string | null;
  playlistId?: string | null;
}) => {
  const createdFor = String(playlistType || "").trim();
  return createdFor
    ? { provider: "listenbrainz-createdfor", externalId: createdFor }
    : { provider: "listenbrainz-playlist", externalId: String(playlistId || "").trim() };
};

export default new Hono<AppEnv>()
  .get("/import/listenbrainz/playlists", requireFlowAccess, async (c) => {
    try {
      return c.json(await listenbrainzPlaylistClient.listPlaylists(c.var.user.id), 200);
    } catch (error) {
      logger.warn("playlist-import", "ListenBrainz playlist listing failed", {
        reason: safeLogDiagnostic(error),
      });
      return c.json(
        {
          error: "Failed to fetch ListenBrainz playlists",
          message: asAppError(error)?.message || "Unknown error",
        },
        getErrorStatus(error),
      );
    }
  })
  .post(
    "/import/listenbrainz/preview",
    requireFlowAccess,
    validate("json", v.object(playlistReference)),
    async (c) => {
      try {
        const playlistImport = getPlaylistImport(c.req.valid("json"));
        if (!playlistImport.externalId) {
          return c.json({ error: "playlistId is required" }, 400);
        }
        const { tracks, stats } = await fetchImportedPlaylistTracks({
          userId: c.var.user.id,
          ...playlistImport,
        });
        return c.json(
          {
            trackCount: tracks.length,
            skipped: stats.incomplete + stats.duplicate,
            previewTracks: tracks.slice(0, 3),
          },
          200,
        );
      } catch (error) {
        logger.warn("playlist-import", "ListenBrainz playlist preview failed", {
          reason: safeLogDiagnostic(error),
        });
        return c.json(
          {
            error: "Failed to preview ListenBrainz playlist",
            message: asAppError(error)?.message || "Unknown error",
          },
          getErrorStatus(error),
        );
      }
    },
  )
  .post(
    "/import/listenbrainz",
    requireFlowAccess,
    validate(
      "json",
      v.object({ ...playlistReference, ...importSettings, externalName: v.nullish(v.string()) }),
    ),
    async (c) => {
      let stage = "fetch";
      const body = c.req.valid("json");
      const name = body.name.trim();
      try {
        const playlistImport = getPlaylistImport(body);
        const externalName = String(body.externalName || "").trim();
        const syncIntervalHours = Number(body.syncIntervalHours ?? 24);
        const keepRemovedTracks = body.keepRemovedTracks !== false;
        const syncEnabled = body.syncEnabled === false ? false : syncIntervalHours > 0;
        if (!playlistImport.externalId) {
          return c.json({ error: "playlistId is required" }, 400);
        }
        if (!name) return c.json({ error: "name is required" }, 400);
        const { tracks, stats } = await fetchImportedPlaylistTracks({
          userId: c.var.user.id,
          ...playlistImport,
        });
        stage = "enqueue";
        const result = await enqueueImportedPlaylist({
          ownerUserId: c.var.user.id,
          name,
          sourceName: "ListenBrainz",
          ...playlistImport,
          externalName,
          tracks,
          sourceStats: stats,
          syncEnabled,
          syncIntervalHours,
          keepRemovedTracks,
        });
        return c.json(
          {
            success: true,
            playlist: null,
            tracksQueued: Number(result?.tracksQueued || 0),
            tracksReused: 0,
            queued: result?.queued === true,
          },
          200,
        );
      } catch (error) {
        const failure = asAppError(error);
        if (failure?.code === "STATIC_PLAYLIST_NAME_CONFLICT") {
          logger.debug("playlist-import", "ListenBrainz playlist import name already exists", {
            playlistName: name || null,
          });
          return c.json({ error: "Playlist name already exists", message: failure.message }, 409);
        }
        const status = getErrorStatus(error);
        logger[status >= 500 ? "error" : "warn"](
          "playlist-import",
          "ListenBrainz playlist import request failed",
          { playlistName: name || null, stage, reason: safeLogDiagnostic(error) },
        );
        return c.json(
          {
            error: "Failed to import ListenBrainz playlist",
            message: failure?.message || "Unknown error",
          },
          status,
        );
      }
    },
  );

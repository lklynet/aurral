import { Hono } from "hono";
import * as v from "valibot";
import {
  enqueueImportedPlaylist,
  fetchImportedPlaylistTracks,
} from "../../../services/importLists/importPlaylist.ts";
import { lastfmStationClient } from "../../../services/importLists/lastfmStations.ts";
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

const stationReference = {
  playlistId: v.nullish(v.string()),
  username: v.nullish(v.string()),
};

const getPlaylistImport = ({
  playlistId,
  username,
}: {
  playlistId?: string | null;
  username?: string | null;
}) => ({
  provider: "lastfm-station",
  externalId: String(playlistId || "").trim(),
  externalUsername: String(username || "").trim(),
});

export default new Hono<AppEnv>()
  .get(
    "/import/lastfm/playlists",
    requireFlowAccess,
    validate(
      "query",
      v.object({ username: v.optional(v.union([v.string(), v.array(v.string())])) }),
    ),
    async (c) => {
      try {
        const { username } = c.req.valid("query");
        const requestedUsername = Array.isArray(username) ? username[0] : username;
        return c.json(
          await lastfmStationClient.listPlaylists(c.var.user.id, requestedUsername),
          200,
        );
      } catch (error) {
        logger.warn("playlist-import", "Last.fm station listing failed", {
          reason: safeLogDiagnostic(error),
        });
        return c.json(
          {
            error: "Failed to fetch Last.fm stations",
            message: asAppError(error)?.message || "Unknown error",
          },
          getErrorStatus(error),
        );
      }
    },
  )
  .post(
    "/import/lastfm/preview",
    requireFlowAccess,
    validate("json", v.object(stationReference)),
    async (c) => {
      try {
        const { tracks, stats } = await fetchImportedPlaylistTracks({
          userId: c.var.user.id,
          ...getPlaylistImport(c.req.valid("json")),
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
        logger.warn("playlist-import", "Last.fm station preview failed", {
          reason: safeLogDiagnostic(error),
        });
        return c.json(
          {
            error: "Failed to preview Last.fm station",
            message: asAppError(error)?.message || "Unknown error",
          },
          getErrorStatus(error),
        );
      }
    },
  )
  .post(
    "/import/lastfm",
    requireFlowAccess,
    validate(
      "json",
      v.object({ ...stationReference, ...importSettings, externalName: v.nullish(v.string()) }),
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
        const { tracks, stats, user } = await fetchImportedPlaylistTracks({
          userId: c.var.user.id,
          ...playlistImport,
        });
        stage = "enqueue";
        const result = await enqueueImportedPlaylist({
          ownerUserId: c.var.user.id,
          name,
          sourceName: "Last.fm",
          ...playlistImport,
          externalUsername: playlistImport.externalUsername || user || "",
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
          logger.debug("playlist-import", "Last.fm station import name already exists", {
            playlistName: name || null,
          });
          return c.json({ error: "Playlist name already exists", message: failure.message }, 409);
        }
        const status = getErrorStatus(error);
        logger[status >= 500 ? "error" : "warn"](
          "playlist-import",
          "Last.fm station import request failed",
          { playlistName: name || null, stage, reason: safeLogDiagnostic(error) },
        );
        return c.json(
          {
            error: "Failed to import Last.fm station",
            message: failure?.message || "Unknown error",
          },
          status,
        );
      }
    },
  );

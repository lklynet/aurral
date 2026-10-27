import { Hono } from "hono";
import * as v from "valibot";
import {
  extractYoutubePlaylistId,
  validateYoutubePlaylistId,
  youtubeMusicPlaylistClient,
} from "../../../services/importLists/youtubeMusicPlaylists.ts";
import { enqueueImportedPlaylist } from "../../../services/importLists/importPlaylist.ts";
import { logger, safeLogDiagnostic } from "../../../services/logger.ts";
import { asAppError } from "../../../../lib/errors.ts";
import { validate } from "../../../middleware/validate.ts";
import { errorStatus } from "../../shared/errorStatus.ts";
import { importSettings, requireFlowAccess } from "./utils.ts";
import type { Context } from "hono";
import type { AppEnv } from "../../../middleware/requestUser.ts";

type PlaylistStats = Awaited<ReturnType<typeof youtubeMusicPlaylistClient.getPlaylist>>["stats"];

const getSkippedCount = (stats: Partial<PlaylistStats> = {}) =>
  (["unavailable", "podcast", "incomplete", "duplicate"] as const).reduce(
    (sum, key) => sum + Number(stats[key] || 0),
    0,
  );

const sendProviderError = <E extends AppEnv>(c: Context<E>, error: unknown, fallback: string) => {
  const failure = asAppError(error);
  return c.json(
    {
      error: fallback,
      message: failure?.message || "Unknown error",
      ...(failure?.code ? { code: failure.code } : {}),
    },
    errorStatus(failure),
  );
};

export default new Hono<AppEnv>()
  .post(
    "/import/youtube-music/preview",
    requireFlowAccess,
    validate("json", v.object({ url: v.string() })),
    async (c) => {
      try {
        const playlistId = extractYoutubePlaylistId(c.req.valid("json").url);
        const playlist = await youtubeMusicPlaylistClient.getPlaylist(playlistId);
        return c.json(
          {
            playlist: { id: playlist.id, name: playlist.name },
            trackCount: playlist.tracks.length,
            skipped: getSkippedCount(playlist.stats),
            previewTracks: playlist.tracks.slice(0, 3),
          },
          200,
        );
      } catch (error) {
        const status = Number(asAppError(error)?.statusCode) || 500;
        logger[status >= 500 ? "error" : "warn"](
          "playlist-import",
          "YouTube Music playlist preview failed",
          { reason: safeLogDiagnostic(error) },
        );
        return sendProviderError(c, error, "Failed to preview YouTube Music playlist");
      }
    },
  )
  .post(
    "/import/youtube-music",
    requireFlowAccess,
    validate("json", v.object({ ...importSettings, playlistId: v.string() })),
    async (c) => {
      let stage = "fetch";
      const body = c.req.valid("json");
      const name = body.name.trim();
      try {
        const playlistId = validateYoutubePlaylistId(body.playlistId);
        if (!name) return c.json({ error: "name is required" }, 400);
        const syncIntervalHours = Number(body.syncIntervalHours ?? 24);
        if (!Number.isFinite(syncIntervalHours) || syncIntervalHours < 0) {
          return c.json({ error: "syncIntervalHours must be zero or greater" }, 400);
        }
        const syncEnabled = body.syncEnabled === false ? false : syncIntervalHours > 0;
        const keepRemovedTracks = body.keepRemovedTracks !== false;
        const playlist = await youtubeMusicPlaylistClient.getPlaylist(playlistId);
        stage = "enqueue";
        const result = await enqueueImportedPlaylist({
          ownerUserId: c.var.user.id,
          name,
          sourceName: "YouTube Music",
          provider: "youtube-music-playlist",
          externalId: playlist.id,
          externalName: playlist.name,
          tracks: playlist.tracks,
          sourceStats: playlist.stats,
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
          logger.debug("playlist-import", "YouTube Music playlist import name already exists", {
            playlistName: name || null,
          });
          return c.json({ error: "Playlist name already exists", message: failure.message }, 409);
        }
        const status = Number(failure?.statusCode) || 500;
        logger[status >= 500 ? "error" : "warn"](
          "playlist-import",
          "YouTube Music playlist import request failed",
          { playlistName: name || null, stage, reason: safeLogDiagnostic(error) },
        );
        return sendProviderError(c, error, "Failed to import YouTube Music playlist");
      }
    },
  );

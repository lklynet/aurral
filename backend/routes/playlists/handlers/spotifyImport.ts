import { Hono } from "hono";
import * as v from "valibot";
import { buildSpotifyOAuthUrl, SPOTIFY_API_BASE } from "../../../services/spotify/spotifyConfig.ts";
import { spotifyConnectionStore } from "../../../services/spotify/spotifyConnectionStore.ts";
import {
  SPOTIFY_AUTH_REQUIRED_CODE,
  spotifyClient,
} from "../../../services/spotify/spotifyClient.ts";
import { logger, safeLogDiagnostic } from "../../../services/logger.ts";
import {
  enqueueImportedPlaylist,
  fetchImportedPlaylistTracks,
} from "../../../services/importLists/importPlaylist.ts";
import { flowPlaylistConfig } from "../../../services/playlists/flowPlaylistConfig.ts";
import { importSettings, requireFlowAccess } from "./utils.ts";
import { asAppError } from "../../../../lib/errors.ts";
import { validate } from "../../../middleware/validate.ts";
import { errorStatus } from "../../shared/errorStatus.ts";
import type { Context } from "hono";
import type { AppEnv } from "../../../middleware/requestUser.ts";

const parseExpiresAt = (value: unknown) => {
  const expiresIn = Number(value);
  if (Number.isFinite(expiresIn) && expiresIn > 0) {
    return Date.now() + expiresIn * 1000;
  }
  const expiresAt = Number(value);
  if (Number.isFinite(expiresAt) && expiresAt > 0) {
    return expiresAt;
  }
  return Date.now() + 3600 * 1000;
};

function sendSpotifyError<E extends AppEnv>(c: Context<E>, error: unknown, fallback: string) {
  const failure = asAppError(error);
  if (failure?.code === SPOTIFY_AUTH_REQUIRED_CODE) {
    return c.json(
      {
        error: "Spotify authentication required",
        code: SPOTIFY_AUTH_REQUIRED_CODE,
        message: "Your Spotify connection expired. Connect Spotify again.",
      },
      401,
    );
  }
  return c.json(
    { error: fallback, message: failure?.message || "Unknown error" },
    errorStatus(failure),
  );
}

const expiry = v.nullish(v.union([v.number(), v.string()]));

export default new Hono<AppEnv>()
  .get("/import/spotify/status", requireFlowAccess, (c) => {
    const userId = c.var.user.id;
    const status = spotifyConnectionStore.getPublicStatus(userId);
    const hasSyncedPlaylists = flowPlaylistConfig
      .getStaticPlaylists()
      .some(
        (playlist) =>
          Number(playlist?.ownerUserId) === Number(userId) &&
          playlist?.importSource?.provider === "spotify-playlist" &&
          playlist.importSource.syncEnabled,
      );
    return c.json({ ...status, reconnectRequired: !status.connected && hasSyncedPlaylists }, 200);
  })
  .post(
    "/import/spotify/oauth/start",
    requireFlowAccess,
    validate("json", v.object({ callbackUrl: v.string() })),
    (c) => {
      const callbackUrl = c.req.valid("json").callbackUrl.trim();
      if (!callbackUrl) {
        return c.json({ error: "callbackUrl is required" }, 400);
      }
      return c.json({ oauthUrl: buildSpotifyOAuthUrl(callbackUrl) }, 200);
    },
  )
  .post(
    "/import/spotify/oauth/complete",
    requireFlowAccess,
    validate(
      "json",
      v.object({
        accessToken: v.string(),
        refreshToken: v.string(),
        expiresIn: expiry,
        expires_in: expiry,
      }),
    ),
    async (c) => {
      try {
        const body = c.req.valid("json");
        const accessToken = body.accessToken.trim();
        const refreshToken = body.refreshToken.trim();
        if (!accessToken || !refreshToken) {
          return c.json({ error: "Spotify tokens are required" }, 400);
        }
        const expiresAt = parseExpiresAt(body.expiresIn ?? body.expires_in);
        let displayName = null;
        try {
          const response = await fetch(`${SPOTIFY_API_BASE}/me`, {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              Accept: "application/json",
            },
          });
          if (response.ok) {
            const profile = await response.json();
            displayName = profile?.display_name || null;
          }
        } catch (error) {
          logger.warn(
            "spotify",
            `Spotify profile lookup failed after OAuth complete: ${asAppError(error)?.message || "Unknown error"}`,
          );
        }
        const saved = spotifyConnectionStore.saveConnection(c.var.user.id, {
          accessToken,
          refreshToken,
          expiresAt,
          displayName,
        });
        if (!saved) {
          return c.json(
            {
              error: "Failed to complete Spotify connection",
              message: "The saved Spotify connection could not be read back",
            },
            500,
          );
        }
        return c.json(
          { connected: true, displayName: saved.displayName, connectedAt: saved.connectedAt },
          200,
        );
      } catch (error) {
        return c.json(
          {
            error: "Failed to complete Spotify connection",
            message: asAppError(error)?.message || "Unknown error",
          },
          500,
        );
      }
    },
  )
  .delete("/import/spotify", requireFlowAccess, (c) => {
    spotifyConnectionStore.clearConnection(c.var.user.id);
    spotifyClient.clearPlaylistTrackCache(c.var.user.id);
    return c.json({ connected: false }, 200);
  })
  .get("/import/spotify/playlists", requireFlowAccess, async (c) => {
    try {
      return c.json(await spotifyClient.listPlaylists(c.var.user.id), 200);
    } catch (error) {
      logger.warn("playlist-import", "Spotify playlist listing failed", {
        reason: safeLogDiagnostic(error),
      });
      return sendSpotifyError(c, error, "Failed to fetch Spotify playlists");
    }
  })
  .post(
    "/import/spotify/preview",
    requireFlowAccess,
    validate("json", v.object({ playlistId: v.string() })),
    async (c) => {
      try {
        const playlistId = c.req.valid("json").playlistId.trim();
        if (!playlistId) {
          return c.json({ error: "playlistId is required" }, 400);
        }
        const { tracks, stats } = await fetchImportedPlaylistTracks({
          provider: "spotify-playlist",
          userId: c.var.user.id,
          externalId: playlistId,
        });
        const skipped =
          (stats.unavailable ?? 0) + (stats.podcast ?? 0) + stats.incomplete + stats.duplicate;
        return c.json(
          { trackCount: tracks.length, skipped, previewTracks: tracks.slice(0, 3) },
          200,
        );
      } catch (error) {
        logger.warn("playlist-import", "Spotify playlist preview failed", {
          reason: safeLogDiagnostic(error),
        });
        return sendSpotifyError(c, error, "Failed to preview Spotify playlist");
      }
    },
  )
  .post(
    "/import/spotify",
    requireFlowAccess,
    validate(
      "json",
      v.object({
        ...importSettings,
        playlistId: v.string(),
        externalName: v.nullish(v.string()),
      }),
    ),
    async (c) => {
      let stage = "fetch";
      const body = c.req.valid("json");
      const name = body.name.trim();
      try {
        const playlistId = body.playlistId.trim();
        const externalName = String(body.externalName || "").trim();
        const syncIntervalHours = Number(body.syncIntervalHours ?? 24);
        const keepRemovedTracks = body.keepRemovedTracks !== false;
        const syncEnabled = body.syncEnabled === false ? false : syncIntervalHours > 0;
        if (!playlistId) {
          return c.json({ error: "playlistId is required" }, 400);
        }
        if (!name) {
          return c.json({ error: "name is required" }, 400);
        }
        const { tracks, stats } = await fetchImportedPlaylistTracks({
          provider: "spotify-playlist",
          userId: c.var.user.id,
          externalId: playlistId,
        });
        stage = "enqueue";
        const result = await enqueueImportedPlaylist({
          ownerUserId: c.var.user.id,
          name,
          sourceName: "Spotify",
          provider: "spotify-playlist",
          externalId: playlistId,
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
          logger.debug("playlist-import", "Spotify playlist import name already exists", {
            playlistName: name || null,
          });
          return c.json({ error: "Playlist name already exists", message: failure.message }, 409);
        }
        const status =
          failure?.code === SPOTIFY_AUTH_REQUIRED_CODE ? 401 : failure?.statusCode || 500;
        logger[status >= 500 ? "error" : "warn"](
          "playlist-import",
          "Spotify playlist import request failed",
          { playlistName: name || null, stage, reason: safeLogDiagnostic(error) },
        );
        return sendSpotifyError(c, error, "Failed to import Spotify playlist");
      }
    },
  );

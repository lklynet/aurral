import { Hono } from "hono";
import * as v from "valibot";
import {
  buildSpotifyOAuthUrl,
  SPOTIFY_API_BASE,
  SPOTIFY_SCOPES,
} from "../../../services/spotify/spotifyConfig.ts";
import { spotifyConnectionStore } from "../../../services/spotify/spotifyConnectionStore.ts";
import {
  SPOTIFY_AUTH_REQUIRED_CODE,
  spotifyClient,
} from "../../../services/spotify/spotifyClient.ts";
import { logger, safeLogDiagnostic } from "../../../services/logger.ts";
import { flowPlaylistConfig } from "../../../services/playlists/flowPlaylistConfig.ts";
import { requirePlaylistAccess } from "./utils.ts";
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
        message: failure.message,
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
  .get("/import/spotify/status", requirePlaylistAccess, (c) => {
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
    requirePlaylistAccess,
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
    requirePlaylistAccess,
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
        let displayName: string | null = null;
        try {
          const response = await fetch(`${SPOTIFY_API_BASE}/me`, {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              Accept: "application/json",
            },
          });
          if (response.ok) {
            const profile: unknown = await response.json();
            const name =
              profile && typeof profile === "object" && "display_name" in profile
                ? profile.display_name
                : null;
            displayName = typeof name === "string" && name ? name : null;
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
          scope: SPOTIFY_SCOPES,
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
  .delete("/import/spotify", requirePlaylistAccess, (c) => {
    spotifyConnectionStore.clearConnection(c.var.user.id);
    spotifyClient.clearPlaylistTrackCache(c.var.user.id);
    return c.json({ connected: false }, 200);
  })
  .get("/import/spotify/playlists", requirePlaylistAccess, async (c) => {
    try {
      return c.json(await spotifyClient.listPlaylists(c.var.user.id), 200);
    } catch (error) {
      logger.warn("playlist-import", "Spotify playlist listing failed", {
        reason: safeLogDiagnostic(error),
      });
      return sendSpotifyError(c, error, "Failed to fetch Spotify playlists");
    }
  });

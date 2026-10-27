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
import { syncStaticPlaylistImport } from "../../../services/importLists/importListSync.ts";
import { flowPlaylistConfig } from "../../../services/playlists/flowPlaylistConfig.ts";
import { getAccessibleStaticPlaylist } from "./utils.ts";
import { asAppError } from "../../../../lib/errors.ts";
import type { Response, Router } from "express";

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

function sendSpotifyError(res: Response, error: unknown, fallback: string) {
  const failure = asAppError(error);
  if (failure?.code === SPOTIFY_AUTH_REQUIRED_CODE) {
    return res.status(401).json({
      error: "Spotify authentication required",
      code: SPOTIFY_AUTH_REQUIRED_CODE,
      message: "Your Spotify connection expired. Connect Spotify again.",
    });
  }
  return res.status(failure?.statusCode || 500).json({
    error: fallback,
    message: failure?.message || "Unknown error",
  });
}

export type GetSpotifyImportStatusResponse = {
  connected: boolean;
  displayName: string | null;
  connectedAt: number | null;
  reconnectRequired: boolean;
};

export type StartSpotifyOAuthResponse = { oauthUrl: string };

export type CompleteSpotifyOAuthResponse = {
  connected: true;
  displayName: string | null;
  connectedAt: number;
};

export type DisconnectSpotifyResponse = { connected: false };

export function registerSpotifyImport(router: Router) {
  router.get("/import/spotify/status", (req, res) => {
    const status = spotifyConnectionStore.getPublicStatus(req.user!.id);
    const hasSyncedPlaylists = flowPlaylistConfig
      .getStaticPlaylists()
      .some(
        (playlist) =>
          Number(playlist?.ownerUserId) === Number(req.user!.id) &&
          playlist?.importSource?.provider === "spotify-playlist" &&
          playlist.importSource.syncEnabled,
      );
    res.json({ ...status, reconnectRequired: !status.connected && hasSyncedPlaylists });
  });

  router.post("/import/spotify/oauth/start", (req, res) => {
    const callbackUrl = String(req.body?.callbackUrl || "").trim();
    if (!callbackUrl) {
      return res.status(400).json({ error: "callbackUrl is required" });
    }
    res.json({ oauthUrl: buildSpotifyOAuthUrl(callbackUrl) });
  });

  router.post("/import/spotify/oauth/complete", async (req, res) => {
    try {
      const accessToken = String(req.body?.accessToken || "").trim();
      const refreshToken = String(req.body?.refreshToken || "").trim();
      const expiresIn = req.body?.expiresIn ?? req.body?.expires_in;
      if (!accessToken || !refreshToken) {
        return res.status(400).json({ error: "Spotify tokens are required" });
      }
      const expiresAt = parseExpiresAt(expiresIn);
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
      const saved = spotifyConnectionStore.saveConnection(req.user!.id, {
        accessToken,
        refreshToken,
        expiresAt,
        displayName,
      });
      if (!saved) {
        return res.status(500).json({
          error: "Failed to complete Spotify connection",
          message: "The saved Spotify connection could not be read back",
        });
      }
      res.json({
        connected: true,
        displayName: saved.displayName,
        connectedAt: saved.connectedAt,
      });
    } catch (error) {
      res.status(500).json({
        error: "Failed to complete Spotify connection",
        message: asAppError(error)?.message || "Unknown error",
      });
    }
  });

  router.delete("/import/spotify", (req, res) => {
    spotifyConnectionStore.clearConnection(req.user!.id);
    spotifyClient.clearPlaylistTrackCache(req.user!.id);
    res.json({ connected: false });
  });

  router.get("/import/spotify/playlists", async (req, res) => {
    try {
      const payload = await spotifyClient.listPlaylists(req.user!.id);
      res.json(payload);
    } catch (error) {
      logger.warn("playlist-import", "Spotify playlist listing failed", {
        reason: safeLogDiagnostic(error),
      });
      sendSpotifyError(res, error, "Failed to fetch Spotify playlists");
    }
  });

  router.post("/import/spotify/preview", async (req, res) => {
    try {
      const playlistId = String(req.body?.playlistId || "").trim();
      if (!playlistId) {
        return res.status(400).json({ error: "playlistId is required" });
      }
      const { tracks, stats } = await fetchImportedPlaylistTracks({
        provider: "spotify-playlist",
        userId: req.user!.id,
        externalId: playlistId,
      });
      const skipped =
        (stats.unavailable ?? 0) + (stats.podcast ?? 0) + stats.incomplete + stats.duplicate;
      res.json({
        trackCount: tracks.length,
        skipped,
        previewTracks: tracks.slice(0, 3),
      });
    } catch (error) {
      logger.warn("playlist-import", "Spotify playlist preview failed", {
        reason: safeLogDiagnostic(error),
      });
      sendSpotifyError(res, error, "Failed to preview Spotify playlist");
    }
  });

  router.post("/import/spotify", async (req, res) => {
    let stage = "fetch";
    try {
      const playlistId = String(req.body?.playlistId || "").trim();
      const name = String(req.body?.name || "").trim();
      const externalName = String(req.body?.externalName || "").trim();
      const syncIntervalHours = Number(req.body?.syncIntervalHours ?? 24);
      const keepRemovedTracks = req.body?.keepRemovedTracks !== false;
      const syncEnabled = req.body?.syncEnabled === false ? false : syncIntervalHours > 0;
      if (!playlistId) {
        return res.status(400).json({ error: "playlistId is required" });
      }
      if (!name) {
        return res.status(400).json({ error: "name is required" });
      }
      const { tracks, stats, artworkUrl } = await fetchImportedPlaylistTracks({
        provider: "spotify-playlist",
        userId: req.user!.id,
        externalId: playlistId,
      });
      stage = "enqueue";
      const result = await enqueueImportedPlaylist({
        ownerUserId: req.user!.id,
        name,
        sourceName: "Spotify",
        provider: "spotify-playlist",
        externalId: playlistId,
        externalName,
        tracks,
        sourceStats: stats,
        artworkUrl,
        syncEnabled,
        syncIntervalHours,
        keepRemovedTracks,
      });
      res.json({
        success: true,
        playlist: null,
        tracksQueued: Number(result?.tracksQueued || 0),
        tracksReused: 0,
        queued: result?.queued === true,
      });
    } catch (error) {
      const failure = asAppError(error);
      if (failure?.code === "STATIC_PLAYLIST_NAME_CONFLICT") {
        logger.debug("playlist-import", "Spotify playlist import name already exists", {
          playlistName: String(req.body?.name || "").trim() || null,
        });
        return res.status(409).json({
          error: "Playlist name already exists",
          message: failure?.message,
        });
      }
      const status =
        failure?.code === SPOTIFY_AUTH_REQUIRED_CODE ? 401 : failure?.statusCode || 500;
      logger[status >= 500 ? "error" : "warn"](
        "playlist-import",
        "Spotify playlist import request failed",
        {
          playlistName: String(req.body?.name || "").trim() || null,
          stage,
          reason: safeLogDiagnostic(error),
        },
      );
      sendSpotifyError(res, error, "Failed to import Spotify playlist");
    }
  });

  router.post<"/shared-playlists/:playlistId/sync">(
    "/shared-playlists/:playlistId/sync",
    async (req, res) => {
      try {
        const playlist = getAccessibleStaticPlaylist(req.user, req.params.playlistId);
        if (!playlist) {
          return res.status(404).json({ error: "Playlist not found" });
        }
        const result = await syncStaticPlaylistImport({
          playlistId: playlist.id,
          user: req.user,
          force: true,
        });
        res.json({ success: true, ...result });
      } catch (error) {
        const failure = asAppError(error);
        res.status(failure?.statusCode || 500).json({
          error: "Failed to sync playlist",
          message: failure?.message || "Unknown error",
        });
      }
    },
  );
}

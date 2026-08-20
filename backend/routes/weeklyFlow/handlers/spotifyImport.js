import { buildSpotifyOAuthUrl, SPOTIFY_API_BASE } from "../../../services/spotify/spotifyConfig.js";
import { spotifyConnectionStore } from "../../../services/spotify/spotifyConnectionStore.js";
import {
  SPOTIFY_AUTH_REQUIRED_CODE,
  spotifyClient,
} from "../../../services/spotify/spotifyClient.js";
import { logger } from "../../../services/logger.js";
import { parseSpotifyPlaylistItems } from "../../../services/importLists/spotifyTracks.js";
import { syncSharedPlaylistImport } from "../../../services/importLists/importListSync.js";
import { normalizeImportSource } from "../../../services/weeklyFlow/weeklyFlowPlaylistConfig.js";
import { weeklyFlowOperationQueue } from "../../../services/weeklyFlow/weeklyFlowOperationQueue.js";
import { randomUUID } from "crypto";
import { getAccessibleSharedPlaylist } from "./utils.js";

const parseExpiresAt = (value) => {
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

function sendSpotifyError(res, error, fallback) {
  if (error?.code === SPOTIFY_AUTH_REQUIRED_CODE) {
    return res.status(401).json({
      error: "Spotify authentication required",
      code: SPOTIFY_AUTH_REQUIRED_CODE,
      message: "Your Spotify connection expired. Connect Spotify again.",
    });
  }
  return res.status(error?.statusCode || 500).json({
    error: fallback,
    message: error?.message || "Unknown error",
  });
}

export function registerSpotifyImport(router) {
  router.get("/import/spotify/status", (req, res) => {
    res.json(spotifyConnectionStore.getPublicStatus(req.user.id));
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
          `Spotify profile lookup failed after OAuth complete: ${error?.message || "Unknown error"}`,
        );
      }
      const saved = spotifyConnectionStore.saveConnection(req.user.id, {
        accessToken,
        refreshToken,
        expiresAt,
        displayName,
      });
      res.json({
        connected: true,
        displayName: saved.displayName,
        connectedAt: saved.connectedAt,
      });
    } catch (error) {
      res.status(500).json({
        error: "Failed to complete Spotify connection",
        message: error?.message || "Unknown error",
      });
    }
  });

  router.delete("/import/spotify", (req, res) => {
    spotifyConnectionStore.clearConnection(req.user.id);
    spotifyClient.clearPlaylistTrackCache(req.user.id);
    res.json({ connected: false });
  });

  router.get("/import/spotify/playlists", async (req, res) => {
    try {
      const payload = await spotifyClient.listPlaylists(req.user.id);
      res.json(payload);
    } catch (error) {
      sendSpotifyError(res, error, "Failed to fetch Spotify playlists");
    }
  });

  router.post("/import/spotify/preview", async (req, res) => {
    try {
      const playlistId = String(req.body?.playlistId || "").trim();
      if (!playlistId) {
        return res.status(400).json({ error: "playlistId is required" });
      }
      const items = await spotifyClient.listPlaylistTracks(req.user.id, playlistId);
      const { tracks, stats } = parseSpotifyPlaylistItems(items);
      const skipped =
        stats.unavailable + stats.podcast + stats.incomplete + stats.duplicate;
      res.json({
        trackCount: tracks.length,
        skipped,
        previewTracks: tracks.slice(0, 3),
      });
    } catch (error) {
      sendSpotifyError(res, error, "Failed to preview Spotify playlist");
    }
  });

  router.post("/import/spotify", async (req, res) => {
    try {
      const playlistId = String(req.body?.playlistId || "").trim();
      const name = String(req.body?.name || "").trim();
      const externalName = String(req.body?.externalName || "").trim();
      const syncIntervalHours = Number(req.body?.syncIntervalHours ?? 24);
      const keepRemovedTracks = req.body?.keepRemovedTracks !== false;
      const syncEnabled =
        req.body?.syncEnabled === false
          ? false
          : syncIntervalHours > 0;
      if (!playlistId) {
        return res.status(400).json({ error: "playlistId is required" });
      }
      if (!name) {
        return res.status(400).json({ error: "name is required" });
      }
      const items = await spotifyClient.listPlaylistTracks(req.user.id, playlistId);
      const tracks = parseSpotifyPlaylistItems(items).tracks;
      const safePlaylistId = randomUUID();
      const importSource = normalizeImportSource({
        provider: "spotify-playlist",
        externalId: playlistId,
        externalName: externalName || name,
        syncEnabled,
        syncIntervalHours: syncEnabled ? syncIntervalHours : 0,
        keepRemovedTracks,
        lastSyncAt: Date.now(),
        lastSyncTrackCount: tracks.length,
      });
      const result = await weeklyFlowOperationQueue.enqueuePayload({
        kind: "shared-playlist-create",
        label: "shared-playlist:create",
        playlistId: safePlaylistId,
        name,
        sourceName: "Spotify",
        tracks,
        ownerUserId: req.user.id,
        importSource,
      });
      res.json({
        success: true,
        playlist: result?.playlist || null,
        tracksQueued: Number(result?.tracksQueued || 0),
        tracksReused: Number(result?.tracksReused || 0),
        queued: result?.queued === true,
      });
    } catch (error) {
      if (error?.code === "SHARED_PLAYLIST_NAME_CONFLICT") {
        return res.status(409).json({
          error: "Playlist name already exists",
          message: error.message,
        });
      }
      sendSpotifyError(res, error, "Failed to import Spotify playlist");
    }
  });

  router.post("/shared-playlists/:playlistId/sync", async (req, res) => {
    try {
      const playlist = getAccessibleSharedPlaylist(req.user, req.params.playlistId);
      if (!playlist) {
        return res.status(404).json({ error: "Playlist not found" });
      }
      const result = await syncSharedPlaylistImport({
        playlistId: playlist.id,
        user: req.user,
        force: true,
      });
      res.json({ success: true, ...result });
    } catch (error) {
      res.status(error?.statusCode || 500).json({
        error: "Failed to sync playlist",
        message: error?.message || "Unknown error",
      });
    }
  });
}

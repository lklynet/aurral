import express from "express";
import { playlistManager } from "../../../services/playlists/playlistManager.ts";
import { canAccessPlaylistType } from "./utils.ts";
import {
  getPlaylistArtworkState,
  type PlaylistArtworkStyle,
} from "../../../services/playlistArtworkState.ts";
import {
  parsePlaylistCoverPick,
  type PlaylistCoverPick,
} from "../../../services/playlistArtworkGenerator.ts";
import { asAppError } from "../../../../lib/errors.ts";
import type { Router } from "express";

const artworkUploadParser = express.raw({
  limit: "8mb",
  type: (req) => {
    const contentType = String(req.headers["content-type"] || "").toLowerCase();
    return contentType.startsWith("image/");
  },
});

export type PlaylistArtworkOkResponse = { ok: true; fallback?: boolean };
export type PlaylistArtworkGenerateRequest = {
  style?: PlaylistArtworkStyle;
  pick?: PlaylistCoverPick;
};
export type PlaylistArtworkShuffleRequest = {
  style: PlaylistArtworkStyle;
  previous?: PlaylistCoverPick | null;
};
export type PlaylistArtworkPickResponse = { pick: PlaylistCoverPick | null };

export function registerArtworkManagement(router: Router) {
  router.put<"/artwork/:playlistId">(
    "/artwork/:playlistId",
    artworkUploadParser,
    async (req, res) => {
      const { playlistId } = req.params;
      if (!canAccessPlaylistType(req.user, playlistId)) {
        return res.status(404).json({ error: "Playlist not found" });
      }
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return res.status(400).json({
          error: "Bad Request",
          message: "Image body is required",
        });
      }
      try {
        await playlistManager.saveArtworkUpload(playlistId, req.body);
        return res.json({ ok: true });
      } catch (error) {
        return res.status(400).json({
          error: "Bad Request",
          message: asAppError(error)?.message || "Failed to save artwork",
        });
      }
    },
  );

  router.delete<"/artwork/:playlistId">("/artwork/:playlistId", async (req, res) => {
    const { playlistId } = req.params;
    if (!canAccessPlaylistType(req.user, playlistId)) {
      return res.status(404).json({ error: "Playlist not found" });
    }
    try {
      await playlistManager.removeArtwork(playlistId);
      return res.json({ ok: true });
    } catch (error) {
      return res.status(400).json({
        error: "Bad Request",
        message: asAppError(error)?.message || "Failed to remove artwork",
      });
    }
  });

  router.post<"/artwork/:playlistId/restore">("/artwork/:playlistId/restore", async (req, res) => {
    const { playlistId } = req.params;
    if (!canAccessPlaylistType(req.user, playlistId))
      return res.status(404).json({ error: "Playlist not found" });
    try {
      await playlistManager.restoreOriginalArtwork(playlistId);
      return res.json({ ok: true });
    } catch (error) {
      return res.status(400).json({
        error: "Bad Request",
        message: asAppError(error)?.message || "Failed to restore original cover",
      });
    }
  });

  router.get<"/artwork/:playlistId/pick">("/artwork/:playlistId/pick", (req, res) => {
    const { playlistId } = req.params;
    if (!canAccessPlaylistType(req.user, playlistId))
      return res.status(404).json({ error: "Playlist not found" });
    return res.json({
      pick: playlistManager.getArtworkPick(playlistId),
    } satisfies PlaylistArtworkPickResponse);
  });

  router.post<"/artwork/:playlistId/shuffle">("/artwork/:playlistId/shuffle", async (req, res) => {
    const { playlistId } = req.params;
    if (!canAccessPlaylistType(req.user, playlistId))
      return res.status(404).json({ error: "Playlist not found" });
    const style: unknown = req.body?.style;
    if (style !== "artist" && style !== "simple")
      return res.status(400).json({ error: "Choose artist or simple cover art" });
    try {
      const pick = await playlistManager.shuffleArtwork(
        playlistId,
        style,
        parsePlaylistCoverPick(req.body?.previous),
      );
      return res.json({ pick } satisfies PlaylistArtworkPickResponse);
    } catch (error) {
      return res.status(400).json({
        error: "Bad Request",
        message: asAppError(error)?.message || "Failed to shuffle cover",
      });
    }
  });

  router.post<"/artwork/:playlistId/generate">(
    "/artwork/:playlistId/generate",
    async (req, res) => {
      const { playlistId } = req.params;
      if (!canAccessPlaylistType(req.user, playlistId)) {
        return res.status(404).json({ error: "Playlist not found" });
      }
      try {
        const style: unknown = req.body?.style ?? "artist";
        if (style !== "artist" && style !== "simple")
          return res.status(400).json({ error: "Choose artist or simple cover art" });
        const pick = req.body?.pick == null ? null : parsePlaylistCoverPick(req.body.pick);
        if (req.body?.pick != null && !pick)
          return res.status(400).json({ error: "Invalid cover choice" });
        await playlistManager.generateArtwork(playlistId, style, pick);
        return res.json({
          ok: true,
          fallback: getPlaylistArtworkState(playlistId)?.fallbackSignature != null,
        });
      } catch (error) {
        return res.status(400).json({
          error: "Bad Request",
          message: asAppError(error)?.message || "Failed to generate artwork",
        });
      }
    },
  );
}

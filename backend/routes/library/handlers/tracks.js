import { libraryManager } from "../../../services/libraryManager.js";
import { cacheMiddleware } from "../../../middleware/cache.js";
import { noCache } from "../../../middleware/cache.js";
import { hasPermission, verifyTokenAuth } from "../../../middleware/auth.js";
import { requireAuth } from "../../../middleware/requirePermission.js";
import { getAlbumTracksByAlbumMbid } from "../../../services/providers/brainzmashProvider.js";
import { enrichTracksWithDeezerPreviews } from "../../../services/apiClients/index.js";
import fsp from "fs/promises";
import path from "path";
import { logger } from "../../../services/logger.js";
import {
  buildCanonicalLibraryReadModel,
  findCanonicalTracksForAlbum,
  resolveCanonicalTrackPath,
} from "../../../services/canonicalLibraryReadAdapter.js";
import { getCanonicalLibrary } from "../../../services/libraryQueryService.js";
import { stripFilesystemPaths } from "./canonical.js";
import { streamAudioFile } from "../../../services/audioFileStream.js";

const canReadAudioFile = async (filePath) => {
  if (!filePath) return false;
  try {
    const stat = await fsp.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
};

const requireTrackDeletion = (req, res, next) => {
  if (hasPermission(req.user, "deleteTrack") || hasPermission(req.user, "deleteAlbum")) {
    return next();
  }
  return res.status(403).json({
    error: "Forbidden",
    message: "Permission required: deleteTrack or deleteAlbum",
  });
};

export function registerTracks(router) {
  router.delete(
    "/tracks/:id",
    requireAuth,
    requireTrackDeletion,
    async (req, res) => {
      try {
        const result = await libraryManager.deleteTrack(req.params.id);
        if (!result?.success) {
          if (result?.code === "not_found") {
            return res.status(404).json({
              error: "Track not found",
              message: "The track or its file no longer exists.",
            });
          }
          if (result?.code === "lidarr_unavailable") {
            return res.status(503).json({
              error: "Lidarr unavailable",
              message: "Lidarr is not available. Try again later.",
            });
          }
          logger.error("library", `Track deletion failed: ${String(result?.error || "Unknown error")}`);
          return res.status(500).json({
            error: "Failed to delete track",
            message: "Failed to delete track",
          });
        }
        return res.json({ success: true, message: "Track deleted successfully" });
      } catch (error) {
        logger.error("library", `Track deletion threw: ${error.message}`);
        return res.status(500).json({
          error: "Failed to delete track",
          message: "Failed to delete track",
        });
      }
    },
  );

  router.get("/playback-queue", cacheMiddleware(120), async (req, res) => {
    try {
      const tracks = await libraryManager.getPlaybackQueue();
      res.json(tracks);
    } catch (error) {
      res.status(500).json({
        error: "Failed to build playback queue",
        message: error.message,
      });
    }
  });

  router.get("/tracks", cacheMiddleware(120), async (req, res) => {
    try {
      const { albumId, releaseGroupMbid } = req.query;

      if (req.query.readPath === "canonical") {
        const canonicalLibrary = getCanonicalLibrary({
          source: req.query.source || "all",
          availableOnly: true,
        });
        const { albums, tracks } = buildCanonicalLibraryReadModel(canonicalLibrary);
        const album = [albumId, releaseGroupMbid]
          .filter(Boolean)
          .map((reference) =>
            albums.find((candidate) =>
              [candidate.id, candidate.mbid, candidate.foreignAlbumId].some(
                (value) => String(value ?? "") === String(reference),
              ),
            ),
          )
          .find(Boolean);
        const canonicalTracks = album
          ? findCanonicalTracksForAlbum(tracks, album.id).map((track) => ({
              ...stripFilesystemPaths(track),
              streamPath: track.hasFile
                ? `/library/canonical-stream/${encodeURIComponent(track.id)}`
                : null,
            }))
          : [];
        return res.json(canonicalTracks);
      }

      let tracks = [];

      if (albumId) {
        tracks = await libraryManager.getTracks(albumId);
      }

      if (tracks.length === 0 && releaseGroupMbid) {
        if (String(releaseGroupMbid).startsWith("dz-")) {
          const { deezerGetAlbumTracks } = await import(
            "../../../services/apiClients/index.js"
          );          const dzTracks = await deezerGetAlbumTracks(releaseGroupMbid);
          tracks = dzTracks.map((t) => ({
            ...t,
            path: null,
            hasFile: false,
            size: 0,
            quality: null,
            addedAt: new Date().toISOString(),
          }));
        } else {
          try {
            const metadataTracks = await getAlbumTracksByAlbumMbid(releaseGroupMbid);
            if (metadataTracks.length > 0) {
              tracks = metadataTracks.map((track) => ({
                id: track.recordingId || track.id,
                mbid: track.recordingId || track.id,
                trackName: track.title,
                trackNumber: track.trackPosition || track.trackNumber || 0,
                title: track.title,
                path: null,
                hasFile: false,
                size: 0,
                quality: null,
                addedAt: new Date().toISOString(),
              }));
            }
          } catch (mbError) {
            logger.warn("library", `Failed to fetch tracks from metadata provider: ${mbError.message}`);          }
        }
      }

      const formatted = tracks.map((track) => ({
        ...track,
        title: track.trackName || track.title,
        trackNumber: track.trackNumber || 0,
      }));

      const tracksWithStreamState = await Promise.all(
        formatted.map(async (track) => {
          const readable = track.hasFile && (await canReadAudioFile(track.path));
          const canStream = readable && track.id != null;
          const streamFormat =
            canStream && track.path
              ? path.extname(track.path).replace(/^\./, "").toLowerCase()
              : null;
          return {
            ...track,
            streamPath: canStream
              ? `/library/file-stream/${encodeURIComponent(
                  track.albumId || albumId,
                )}/${encodeURIComponent(track.id)}`
              : null,
            streamFormat,
            path: undefined,
          };
        }),
      );

      const needsPreview = tracksWithStreamState.some((track) => !track.streamPath);
      if (!needsPreview) {
        return res.json(tracksWithStreamState);
      }

      const artistName =
        typeof req.query.artistName === "string" ? req.query.artistName.trim() : "";
      const albumTitle =
        typeof req.query.albumTitle === "string" ? req.query.albumTitle.trim() : "";
      const releaseType =
        typeof req.query.releaseType === "string" ? req.query.releaseType.trim() : "";
      const releaseDate =
        typeof req.query.releaseDate === "string" ? req.query.releaseDate.trim() : "";
      const deezerAlbumId =
        typeof req.query.deezerAlbumId === "string" ? req.query.deezerAlbumId.trim() : "";

      const enriched = await enrichTracksWithDeezerPreviews(tracksWithStreamState, {
        artistName,
        albumTitle,
        releaseType,
        releaseDate,
        deezerAlbumId,
        cacheKey: `library:${albumId || releaseGroupMbid}:${deezerAlbumId || artistName}`,
      }).catch(() => tracksWithStreamState);

      res.json(
        enriched.map((track) => ({
          ...track,
          preview_url: track.streamPath ? null : track.preview_url || null,
        })),
      );
    } catch (error) {
      res.status(500).json({
        error: "Failed to fetch tracks",
        message: error.message,
      });
    }
  });

  router.get("/canonical-stream/:trackId", noCache, async (req, res) => {
    if (!verifyTokenAuth(req)) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const filePath = resolveCanonicalTrackPath(req.params.trackId);
    if (!filePath) return res.status(404).json({ error: "Track file missing" });
    try {
      if (!(await streamAudioFile(req, res, filePath)) && !res.headersSent) {
        return res.status(404).json({ error: "Track file missing" });
      }
    } catch (error) {
      if (!res.headersSent) {
        return res.status(500).json({ error: "Stream failed", message: error.message });
      }
    }
    return undefined;
  });

  router.get("/file-stream/:albumId/:trackId", noCache, async (req, res) => {
    if (!verifyTokenAuth(req)) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    try {
      const canonicalPath = resolveCanonicalTrackPath(req.params.trackId);
      if (canonicalPath && await streamAudioFile(req, res, canonicalPath)) return undefined;
      const tracks = await libraryManager.getTracks(req.params.albumId);
      const track = tracks.find((item) => String(item.id) === String(req.params.trackId));
      if (!track?.hasFile || !track.path) {
        return res.status(404).json({ error: "Track file missing" });
      }
      if (!(await streamAudioFile(req, res, track.path))) {
        if (!res.headersSent) return res.status(404).json({ error: "Track file missing" });
      }
    } catch (error) {
      if (!res.headersSent) {
        res.status(500).json({
          error: "Stream failed",
          message: error.message,
        });
      }
    }
  });
}

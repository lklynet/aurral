import type { NextFunction, Request, Response, Router } from "express";
import { libraryManager } from "../../../services/libraryManager.ts";
import { cacheMiddleware } from "../../../middleware/cache.ts";
import { noCache } from "../../../middleware/cache.ts";
import { hasPermission } from "../../../middleware/auth.ts";
import {
  requireAdmin,
  requireAuth,
  requirePermission,
} from "../../../middleware/requirePermission.ts";
import { getAlbumTracksByAlbumMbid } from "../../../services/providers/brainzmashProvider.ts";
import { chooseLibraryRelease } from "../../../services/releaseResolver.ts";
import type { deezerGetAlbumTracks } from "../../../services/apiClients/index.ts";
import { enrichTracksWithDeezerPreviews } from "../../../services/apiClients/index.ts";
import fsp from "fs/promises";
import path from "path";
import { logger } from "../../../services/logger.ts";
import {
  findLibraryTracksForAlbum,
  getLibraryReadModelForAlbumReferences,
} from "../../../services/libraryReadModel.ts";
import { getLibraryForTrackIds } from "../../../services/libraryQueryService.ts";
import { stripFilesystemPaths } from "./libraryIndex.ts";
import { asAppError } from "../../../../lib/errors.ts";

const canReadAudioFile = async (filePath: string | null | undefined) => {
  if (!filePath) return false;
  try {
    const stat = await fsp.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
};

type PreviewOnlyTrack = {
  path: null;
  hasFile: false;
  size: number;
  quality: null;
  addedAt: string;
  albumId?: undefined;
};

type TrackListEntry =
  | (Awaited<ReturnType<typeof libraryManager.getTracks>>[number] & { title?: string })
  | (Awaited<ReturnType<typeof deezerGetAlbumTracks>>[number] & PreviewOnlyTrack)
  | (PreviewOnlyTrack & {
      id: string;
      mbid: string;
      trackName: string;
      trackNumber: number;
      discNumber: number;
      releaseMbid: string | null;
      title: string;
    });

const requireTrackDeletion = (req: Request, res: Response, next: NextFunction) => {
  if (hasPermission(req.user, "deleteTrack") || hasPermission(req.user, "deleteAlbum")) {
    return next();
  }
  return res.status(403).json({
    error: "Forbidden",
    message: "Permission required: deleteTrack or deleteAlbum",
  });
};

export function registerTracks(router: Router) {
  router.delete<"/tracks/:id">(
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
          if (result?.code === "read_only") {
            return res.status(409).json({
              error: "Read-only file",
              message:
                "This file is in a read-only folder, so Aurral did not delete it. Remove it from the folder yourself.",
            });
          }
          if (result?.code === "lidarr_unavailable") {
            return res.status(503).json({
              error: "Lidarr unavailable",
              message: "Lidarr is not available. Try again later.",
            });
          }
          logger.error(
            "library",
            `Track deletion failed: ${String(result?.error || "Unknown error")}`,
          );
          return res.status(500).json({
            error: "Failed to delete track",
            message: "Failed to delete track",
          });
        }
        return res.json({ success: true, message: "Track deleted successfully" });
      } catch (error) {
        const failure = asAppError(error);
        logger.error("library", `Track deletion threw: ${failure?.message}`);
        return res.status(500).json({
          error: "Failed to delete track",
          message: "Failed to delete track",
        });
      }
    },
  );

  router.put<"/tracks/aurral/:canonicalId">(
    "/tracks/aurral/:canonicalId",
    requireAuth,
    requirePermission("changeMonitoring"),
    async (req, res) => {
      try {
        const result =
          req.body?.keepFile !== undefined
            ? await libraryManager.setTrackKeepFile(req.params.canonicalId, {
                keepFile: req.body.keepFile,
              })
            : await libraryManager.setAurralTrackMonitoring(req.params.canonicalId, {
                monitored: req.body?.monitored,
              });
        if (result?.error) {
          const { error, statusCode, ...details } = result;
          return res.status(statusCode || 500).json({ ...details, error });
        }
        return res.json(result);
      } catch (error) {
        const failure = asAppError(error);
        return res.status(500).json({
          error: "Failed to update track monitoring",
          message: failure?.message,
        });
      }
    },
  );

  router.get("/playback-queue", cacheMiddleware(120), async (req, res) => {
    try {
      const tracks = await libraryManager.getPlaybackQueue({
        page: Number.parseInt(String(req.query.page), 10) || 1,
        pageSize: Number.parseInt(String(req.query.pageSize), 10) || 100,
      });
      res.json(tracks);
    } catch (error) {
      const failure = asAppError(error);
      res.status(500).json({
        error: "Failed to build playback queue",
        message: failure?.message,
      });
    }
  });

  router.get<"/tracks/:id/files">("/tracks/:id/files", requireAdmin, noCache, (req, res) => {
    const [track] = getLibraryForTrackIds({ ids: [req.params.id] }).tracks;
    if (!track) return res.status(404).json({ error: "Track not found" });
    res.json({ paths: track.files.map((file) => file.path).filter(Boolean) });
  });

  router.get("/tracks", cacheMiddleware(120), async (req, res) => {
    try {
      const { albumId, releaseGroupMbid } = req.query;
      if (
        (albumId !== undefined && typeof albumId !== "string") ||
        (releaseGroupMbid !== undefined && typeof releaseGroupMbid !== "string")
      ) {
        return res.status(400).json({
          error: "albumId and releaseGroupMbid must each be a single value",
        });
      }

      if (req.query.readPath === "canonical") {
        let readModel = albumId
          ? getLibraryReadModelForAlbumReferences({
              source: req.query.source || "all",
              availableOnly: true,
              references: [albumId],
            })
          : getLibraryReadModelForAlbumReferences({
              source: req.query.source || "all",
              availableOnly: true,
              references: releaseGroupMbid ? [releaseGroupMbid] : [],
            });
        if (albumId && readModel.albums.length === 0 && releaseGroupMbid) {
          readModel = getLibraryReadModelForAlbumReferences({
            source: req.query.source || "all",
            availableOnly: true,
            references: [releaseGroupMbid],
          });
        }
        const { albums, tracks } = readModel;
        const album = [albumId, releaseGroupMbid]
          .filter(Boolean)
          .map((reference) =>
            albums.find((candidate) =>
              [candidate.id, candidate.providerId, candidate.mbid, candidate.foreignAlbumId].some(
                (value) => String(value ?? "") === String(reference),
              ),
            ),
          )
          .find(Boolean);
        const libraryTracks = album
          ? findLibraryTracksForAlbum(tracks, album.id).map((track) => ({
              ...stripFilesystemPaths(track),
              streamPath: track.hasFile
                ? `/library/canonical-stream/${encodeURIComponent(album.id)}/${encodeURIComponent(track.id)}`
                : null,
            }))
          : [];
        return res.json(libraryTracks);
      }

      let tracks: TrackListEntry[] = [];

      if (albumId) {
        tracks = await libraryManager.getTracks(albumId);
      }

      if (tracks.length === 0 && releaseGroupMbid) {
        if (String(releaseGroupMbid).startsWith("dz-")) {
          const { deezerGetAlbumTracks } = await import("../../../services/apiClients/index.ts");
          const dzTracks = await deezerGetAlbumTracks(releaseGroupMbid);
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
            const metadataTracks = await getAlbumTracksByAlbumMbid(releaseGroupMbid, {
              chooseRelease: chooseLibraryRelease,
            });
            if (metadataTracks.length > 0) {
              tracks = metadataTracks.map((track) => ({
                id: track.recordingId || track.id,
                mbid: track.recordingId || track.id,
                trackName: track.title,
                trackNumber: track.trackPosition || track.trackNumber || 0,
                discNumber: track.mediumNumber || 1,
                releaseMbid: track.releaseMbid || null,
                title: track.title,
                path: null,
                hasFile: false,
                size: 0,
                quality: null,
                addedAt: new Date().toISOString(),
              }));
            }
          } catch (mbError) {
            const failure = asAppError(mbError);
            logger.warn(
              "library",
              `Failed to fetch tracks from metadata provider: ${failure?.message}`,
            );
          }
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
                  track.albumId || albumId!,
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

      const enriched: ((typeof tracksWithStreamState)[number] & {
        preview_url?: string | null;
      })[] = await enrichTracksWithDeezerPreviews(tracksWithStreamState, {
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
      const failure = asAppError(error);
      res.status(500).json({
        error: "Failed to fetch tracks",
        message: failure?.message,
      });
    }
  });
}

export type DeleteLibraryTrackResponse = { success: true; message: string };

export type GetLibraryTrackFilesResponse = { paths: string[] };

export type SetAurralTrackKeepFileResponse = Awaited<
  ReturnType<typeof libraryManager.setTrackKeepFile>
>;

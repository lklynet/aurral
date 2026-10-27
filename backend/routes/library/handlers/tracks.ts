import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import * as v from "valibot";
import { libraryManager } from "../../../services/libraryManager.ts";
import { cacheFor, noCache } from "../../../middleware/cacheHeaders.ts";
import { hasPermission } from "../../../middleware/auth.ts";
import { requireAdmin, requireAuth, requirePermission } from "../../../middleware/guards.ts";
import type { AppEnv } from "../../../middleware/requestUser.ts";
import { validate } from "../../../middleware/validate.ts";
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
import { isErrorStatus, isFailure } from "../../shared/errorStatus.ts";

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

const requireTrackDeletion = createMiddleware<AppEnv>(async (c, next) => {
  const user = c.var.user;
  if (!hasPermission(user, "deleteTrack") && !hasPermission(user, "deleteAlbum")) {
    return c.json(
      { error: "Forbidden", message: "Permission required: deleteTrack or deleteAlbum" },
      403,
    );
  }
  await next();
});

const aurralTrackInput = v.object({
  keepFile: v.optional(v.boolean()),
  monitored: v.optional(v.boolean()),
});

const queueQuery = v.object({ page: v.optional(v.string()), pageSize: v.optional(v.string()) });

const tracksQuery = v.object({
  albumId: v.optional(v.string()),
  releaseGroupMbid: v.optional(v.string()),
  readPath: v.optional(v.string()),
  source: v.optional(v.string()),
  artistName: v.optional(v.string()),
  albumTitle: v.optional(v.string()),
  releaseType: v.optional(v.string()),
  releaseDate: v.optional(v.string()),
  deezerAlbumId: v.optional(v.string()),
});

export default new Hono<AppEnv>()
  .basePath("/library")
  .delete("/tracks/:id", requireAuth, requireTrackDeletion, async (c) => {
    try {
      const result = await libraryManager.deleteTrack(c.req.param("id"));
      if (!result?.success) {
        if (result?.code === "not_found") {
          return c.json(
            { error: "Track not found", message: "The track or its file no longer exists." },
            404,
          );
        }
        if (result?.code === "read_only") {
          return c.json(
            {
              error: "Read-only file",
              message:
                "This file is in a read-only folder, so Aurral did not delete it. Remove it from the folder yourself.",
            },
            409,
          );
        }
        if (result?.code === "lidarr_unavailable") {
          return c.json(
            { error: "Lidarr unavailable", message: "Lidarr is not available. Try again later." },
            503,
          );
        }
        logger.error(
          "library",
          `Track deletion failed: ${String(result?.error || "Unknown error")}`,
        );
        return c.json({ error: "Failed to delete track", message: "Failed to delete track" }, 500);
      }
      return c.json({ success: true, message: "Track deleted successfully" }, 200);
    } catch (error) {
      logger.error("library", `Track deletion threw: ${asAppError(error)?.message}`);
      return c.json({ error: "Failed to delete track", message: "Failed to delete track" }, 500);
    }
  })
  .put(
    "/tracks/aurral/:canonicalId",
    requireAuth,
    requirePermission("changeMonitoring"),
    validate("json", aurralTrackInput),
    async (c) => {
      const canonicalId = c.req.param("canonicalId");
      const { keepFile, monitored } = c.req.valid("json");
      try {
        const result =
          keepFile !== undefined
            ? await libraryManager.setTrackKeepFile(canonicalId, { keepFile })
            : await libraryManager.setAurralTrackMonitoring(canonicalId, { monitored });
        if (isFailure(result)) {
          const { error, statusCode, ...details } = result;
          return c.json({ ...details, error }, isErrorStatus(statusCode) ? statusCode : 500);
        }
        return c.json(result, 200);
      } catch (error) {
        return c.json(
          { error: "Failed to update track monitoring", message: asAppError(error)?.message },
          500,
        );
      }
    },
  )
  .get("/playback-queue", cacheFor(120), validate("query", queueQuery), async (c) => {
    const query = c.req.valid("query");
    try {
      const tracks = await libraryManager.getPlaybackQueue({
        page: Number.parseInt(query.page ?? "", 10) || 1,
        pageSize: Number.parseInt(query.pageSize ?? "", 10) || 100,
      });
      return c.json(tracks, 200);
    } catch (error) {
      return c.json(
        { error: "Failed to build playback queue", message: asAppError(error)?.message },
        500,
      );
    }
  })
  .get("/tracks/:id/files", requireAdmin, noCache, (c) => {
    const [track] = getLibraryForTrackIds({ ids: [c.req.param("id")] }).tracks;
    if (!track) return c.json({ error: "Track not found" }, 404);
    return c.json({ paths: track.files.map((file) => file.path).filter(Boolean) }, 200);
  })
  .get("/tracks", cacheFor(120), validate("query", tracksQuery), async (c) => {
    const query = c.req.valid("query");
    try {
      const { albumId, releaseGroupMbid } = query;
      if (query.readPath === "canonical") {
        let readModel = albumId
          ? getLibraryReadModelForAlbumReferences({
              source: query.source || "all",
              availableOnly: true,
              references: [albumId],
            })
          : getLibraryReadModelForAlbumReferences({
              source: query.source || "all",
              availableOnly: true,
              references: releaseGroupMbid ? [releaseGroupMbid] : [],
            });
        if (albumId && readModel.albums.length === 0 && releaseGroupMbid) {
          readModel = getLibraryReadModelForAlbumReferences({
            source: query.source || "all",
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
        return c.json(libraryTracks, 200);
      }

      let tracks: TrackListEntry[] = [];

      if (albumId) {
        tracks = await libraryManager.getTracks(albumId);
      }

      if (tracks.length === 0 && releaseGroupMbid) {
        if (releaseGroupMbid.startsWith("dz-")) {
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
        return c.json(tracksWithStreamState, 200);
      }

      const artistName = query.artistName?.trim() ?? "";
      const albumTitle = query.albumTitle?.trim() ?? "";
      const releaseType = query.releaseType?.trim() ?? "";
      const releaseDate = query.releaseDate?.trim() ?? "";
      const deezerAlbumId = query.deezerAlbumId?.trim() ?? "";

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

      return c.json(
        enriched.map((track) => ({
          ...track,
          preview_url: track.streamPath ? null : track.preview_url || null,
        })),
        200,
      );
    } catch (error) {
      return c.json({ error: "Failed to fetch tracks", message: asAppError(error)?.message }, 500);
    }
  });

import { Hono, type Context } from "hono";
import { createMiddleware } from "hono/factory";
import * as v from "valibot";
import { libraryManager } from "../../../services/libraryManager.ts";
import { dbOps } from "../../../db/helpers/index.ts";
import { hasPermission } from "../../../middleware/auth.ts";
import { cacheFor, noCache } from "../../../middleware/cacheHeaders.ts";
import { requireAuth, requirePermission } from "../../../middleware/guards.ts";
import type { AppEnv } from "../../../middleware/requestUser.ts";
import { validate } from "../../../middleware/validate.ts";
import { logger } from "../../../services/logger.ts";
import { invalidateAllDownloadStatusesCache } from "./downloads.ts";
import { getLibraryReadModelForArtistReferences } from "../../../services/libraryReadModel.ts";
import { asAppError, type AppError } from "../../../../lib/errors.ts";
import { isErrorStatus, isFailure } from "../../shared/errorStatus.ts";

type AlbumAddFailure = Extract<
  Awaited<ReturnType<typeof libraryManager.addAlbum>>,
  { error: string }
>;

type AlbumRequestFailure = AppError &
  Partial<
    Pick<
      AlbumAddFailure,
      "managedBy" | "sources" | "canonicalId" | "providerId" | "availability" | "conflict"
    >
  >;

type AurralAlbumFailure = { error?: string; statusCode?: number };

const sendAurralFailure = <E extends AppEnv>(
  c: Context<E>,
  { error, statusCode, ...details }: AurralAlbumFailure,
) => c.json({ ...details, error }, isErrorStatus(statusCode) ? statusCode : 500);

const canUpdateAlbum = createMiddleware<AppEnv>(async (c, next) => {
  const user = c.var.user;
  if (!hasPermission(user, "changeMonitoring") && !hasPermission(user, "addAlbum")) {
    return c.json(
      { error: "Forbidden", message: "Permission required: changeMonitoring or addAlbum" },
      403,
    );
  }
  await next();
});

const id = v.union([v.string(), v.number()]);

const listQuery = v.object({
  artistId: v.optional(v.string()),
  readPath: v.optional(v.string()),
  source: v.optional(v.string()),
  managedBy: v.optional(v.string()),
});

const addInput = v.object({
  artistId: v.optional(id),
  releaseGroupMbid: v.optional(v.string()),
  albumName: v.optional(v.string()),
  managedBy: v.optional(v.nullable(v.string())),
});

const requestInput = v.object({
  albumMbid: v.optional(v.nullable(v.string())),
  albumName: v.optional(v.nullable(v.string())),
  artistMbid: v.optional(v.nullable(v.string())),
  artistName: v.optional(v.nullable(v.string())),
  triggerSearch: v.optional(v.boolean()),
  managedBy: v.optional(v.nullable(v.string())),
});

const monitoredInput = v.object({ monitored: v.optional(v.boolean()) });

const deleteQuery = v.object({ deleteFiles: v.optional(v.string()) });

export default new Hono<AppEnv>()
  .basePath("/library")
  .get("/albums", cacheFor(5), validate("query", listQuery), async (c) => {
    const query = c.req.valid("query");
    try {
      const { artistId } = query;
      if (!artistId) return c.json({ error: "artistId parameter is required" }, 400);

      if (query.readPath === "canonical") {
        const { albums } = getLibraryReadModelForArtistReferences({
          source: query.source || "all",
          availableOnly: true,
          references: [artistId],
          includeSharedAlbums: true,
        });
        return c.json(albums, 200);
      }

      const { managedBy = null } = query;
      if (managedBy !== null && managedBy !== "aurral" && managedBy !== "lidarr") {
        return c.json({ error: "managedBy must be 'aurral' or 'lidarr'" }, 400);
      }
      const albums = await libraryManager.getAlbums(artistId, null, {
        managedBy,
        includeAurral: true,
      });
      return c.json(
        albums.map((album) => ({
          ...album,
          foreignAlbumId: album.foreignAlbumId || album.mbid,
          title: album.albumName,
          statistics: album.statistics || { trackCount: 0, sizeOnDisk: 0, percentOfTracks: 0 },
        })),
        200,
      );
    } catch (error) {
      return c.json({ error: "Failed to fetch albums", message: asAppError(error)?.message }, 500);
    }
  })
  .post(
    "/albums",
    requireAuth,
    requirePermission("addAlbum"),
    validate("json", addInput),
    async (c) => {
      const user = c.var.user;
      try {
        const {
          artistId,
          releaseGroupMbid,
          albumName,
          managedBy: requestedManagedBy,
        } = c.req.valid("json");

        if (!artistId || !releaseGroupMbid || !albumName) {
          return c.json({ error: "artistId, releaseGroupMbid, and albumName are required" }, 400);
        }

        let managedBy;
        try {
          managedBy = await libraryManager.resolveManagedBy(requestedManagedBy);
        } catch (error) {
          const failure = asAppError(error);
          return c.json(
            { error: failure?.message, code: failure?.code || null },
            isErrorStatus(failure?.statusCode) ? failure.statusCode : 400,
          );
        }

        let mbid = releaseGroupMbid;
        if (releaseGroupMbid.startsWith("dz-")) {
          const { resolveDeezerAlbumToMbid } =
            await import("../../../services/apiClients/index.ts");
          const artist = await libraryManager.getArtistById(artistId, { managedBy });
          const artistName = artist?.artistName || "";
          const resolved = await resolveDeezerAlbumToMbid(artistName, albumName, releaseGroupMbid);
          if (!resolved) {
            return c.json(
              {
                error:
                  "Could not resolve metadata for this album. Try adding the artist to Lidarr first or use a different album.",
              },
              400,
            );
          }
          mbid = resolved;
        }

        const settings = dbOps.getSettings();
        const searchOnAdd =
          managedBy === "lidarr" && (settings.integrations?.lidarr?.searchOnAdd ?? false);

        const album = await libraryManager.addAlbum(artistId, mbid, albumName, {
          triggerSearch: searchOnAdd,
          managedBy,
          user,
        });
        if (isFailure(album)) {
          logger.error("library", `Failed to add album ${albumName}:`, {
            message: album.error,
          });
          return c.json(
            {
              error: "Failed to add album",
              message: album.error,
              code: album.code || null,
              managedBy: album.managedBy || null,
              sources: album.sources || [],
              canonicalId: album.canonicalId || null,
              providerId: album.providerId || null,
              availability: album.availability || null,
              conflict: album.conflict || null,
            },
            isErrorStatus(album.statusCode) ? album.statusCode : 503,
          );
        }
        const { recordAlbumRequested } = await import("../../../services/aurralHistoryService.ts");
        recordAlbumRequested({
          albumId: album.id,
          requestGroupId: album.requestGroupId,
          albumName: album.albumName || albumName,
          artistName: album.artistName,
          artistMbid: album.mbid || album.foreignAlbumId,
          managedBy,
          searching: managedBy === "lidarr" && searchOnAdd,
          user,
        });
        return c.json({ ...album, queued: false }, 201);
      } catch (error) {
        return c.json({ error: "Failed to add album", message: asAppError(error)?.message }, 500);
      }
    },
  )
  .post(
    "/albums/request",
    requireAuth,
    requirePermission("addAlbum"),
    validate("json", requestInput),
    async (c) => {
      const user = c.var.user;
      try {
        const {
          albumMbid,
          albumName,
          artistMbid,
          artistName,
          triggerSearch = false,
          managedBy: requestedManagedBy,
        } = c.req.valid("json");

        if (!albumMbid || !albumName || !artistMbid || !artistName) {
          return c.json(
            { error: "albumMbid, albumName, artistMbid, and artistName are required" },
            400,
          );
        }

        const result = await libraryManager.requestAlbumFromSearch({
          albumMbid,
          albumName,
          artistName,
          artistMbid,
          triggerSearch,
          managedBy: requestedManagedBy,
          user,
        });
        const settings = dbOps.getSettings();
        const searchOnAdd = settings.integrations?.lidarr?.searchOnAdd ?? false;
        const searching =
          result?.managedBy === "aurral"
            ? result?.status === "queued"
            : triggerSearch || searchOnAdd || result?.status === "searching";
        const { recordAlbumRequested, recordAlbumSearchCompleted } =
          await import("../../../services/aurralHistoryService.ts");
        const historyAlbum = {
          albumId: result?.album?.id,
          albumName: result?.album?.albumName || albumName,
          artistName: result?.artist?.artistName || artistName,
          artistMbid: result?.artist?.mbid || artistMbid,
          managedBy: result?.managedBy || null,
          user,
        };
        recordAlbumRequested({
          ...historyAlbum,
          requestGroupId: result?.requestGroupId || result?.album?.requestGroupId,
          searching: result?.status === "available" ? false : searching,
        });
        if (result?.status === "available") {
          recordAlbumSearchCompleted(historyAlbum);
        }
        invalidateAllDownloadStatusesCache();
        return c.json(
          {
            ...result,
            queued: result?.managedBy === "aurral" ? (result?.jobIds?.length || 0) > 0 : false,
          },
          201,
        );
      } catch (error) {
        const failure: AlbumRequestFailure | undefined = asAppError(error);
        return c.json(
          {
            error: failure?.message || "Failed to request album",
            code: failure?.code || null,
            managedBy: failure?.managedBy || null,
            sources: failure?.sources || [],
            canonicalId: failure?.canonicalId || null,
            providerId: failure?.providerId || null,
            availability: failure?.availability || null,
            conflict: failure?.conflict || null,
          },
          isErrorStatus(failure?.statusCode) ? failure.statusCode : 500,
        );
      }
    },
  )
  .get("/albums/aurral/:canonicalId/status", noCache, (c) => {
    try {
      const result = libraryManager.getAurralAlbumStatus(c.req.param("canonicalId"));
      if (isFailure(result)) return sendAurralFailure(c, result);
      return c.json(result, 200);
    } catch (error) {
      return c.json(
        { error: "Failed to fetch album status", message: asAppError(error)?.message },
        500,
      );
    }
  })
  .put(
    "/albums/aurral/:canonicalId",
    requireAuth,
    requirePermission("changeMonitoring"),
    validate("json", monitoredInput),
    async (c) => {
      try {
        const result = await libraryManager.setAurralAlbumMonitoring(
          c.req.param("canonicalId"),
          c.req.valid("json"),
        );
        if (isFailure(result)) return sendAurralFailure(c, result);
        return c.json(result, 200);
      } catch (error) {
        return c.json(
          { error: "Failed to update album monitoring", message: asAppError(error)?.message },
          500,
        );
      }
    },
  )
  .delete(
    "/albums/aurral/:canonicalId",
    requireAuth,
    requirePermission("deleteAlbum"),
    validate("query", deleteQuery),
    async (c) => {
      try {
        const result = await libraryManager.deleteAurralAlbum(
          c.req.param("canonicalId"),
          c.req.valid("query").deleteFiles === "true",
        );
        if (isFailure(result)) return sendAurralFailure(c, result);
        return c.json(result, 200);
      } catch (error) {
        return c.json(
          { error: "Failed to remove album", message: asAppError(error)?.message },
          500,
        );
      }
    },
  )
  .post(
    "/albums/aurral/:canonicalId/cancel",
    requireAuth,
    requirePermission("addAlbum"),
    async (c) => {
      try {
        const result = await libraryManager.cancelAurralAlbum(c.req.param("canonicalId"));
        if (isFailure(result)) return sendAurralFailure(c, result);
        return c.json(result, 200);
      } catch (error) {
        return c.json(
          { error: "Failed to cancel album", message: asAppError(error)?.message },
          500,
        );
      }
    },
  )
  .get("/albums/:id", cacheFor(120), async (c) => {
    try {
      const album = await libraryManager.getAlbumById(c.req.param("id"));
      if (!album) return c.json({ error: "Album not found" }, 404);
      return c.json(album, 200);
    } catch (error) {
      return c.json({ error: "Failed to fetch album", message: asAppError(error)?.message }, 500);
    }
  })
  .put("/albums/:id", requireAuth, canUpdateAlbum, validate("json", monitoredInput), async (c) => {
    try {
      const album = await libraryManager.updateAlbum(c.req.param("id"), c.req.valid("json"));
      if (isFailure(album)) return c.json({ error: album.error }, 503);
      return c.json(album, 200);
    } catch (error) {
      return c.json({ error: "Failed to update album", message: asAppError(error)?.message }, 500);
    }
  })
  .delete(
    "/albums/lidarr/:mbid",
    requireAuth,
    requirePermission("deleteAlbum"),
    validate("query", deleteQuery),
    async (c) => {
      try {
        const result = await libraryManager.deleteLidarrAlbumByMbid(
          c.req.param("mbid"),
          c.req.valid("query").deleteFiles === "true",
        );
        if (!result?.success) {
          return c.json(
            { error: result?.error || "Failed to delete album" },
            isErrorStatus(result?.statusCode) ? result.statusCode : 503,
          );
        }
        return c.json({ success: true, message: "Album deleted successfully" }, 200);
      } catch (error) {
        return c.json(
          { error: "Failed to delete album", message: asAppError(error)?.message },
          500,
        );
      }
    },
  )
  .delete(
    "/albums/:id",
    requireAuth,
    requirePermission("deleteAlbum"),
    validate("query", deleteQuery),
    async (c) => {
      try {
        const result = await libraryManager.deleteAlbum(
          c.req.param("id"),
          c.req.valid("query").deleteFiles === "true",
        );
        if (!result?.success) {
          return c.json({ error: result?.error || "Failed to delete album" }, 503);
        }
        return c.json({ success: true, message: "Album deleted successfully" }, 200);
      } catch (error) {
        return c.json(
          { error: "Failed to delete album", message: asAppError(error)?.message },
          500,
        );
      }
    },
  );

import { Hono, type Context } from "hono";
import * as v from "valibot";
import { libraryManager } from "../../../services/libraryManager.ts";
import { cacheFor, noCache } from "../../../middleware/cacheHeaders.ts";
import { requireAuth, requirePermission } from "../../../middleware/guards.ts";
import type { AppEnv } from "../../../middleware/requestUser.ts";
import { validate } from "../../../middleware/validate.ts";
import { logger } from "../../../services/logger.ts";
import { getLibraryReadModelForArtistReferences } from "../../../services/libraryReadModel.ts";
import { asAppError } from "../../../../lib/errors.ts";
import { isErrorStatus, isFailure } from "../../shared/errorStatus.ts";
import { resolveDeezerAlbumToMbid } from "../../../services/apiClients/index.ts";
import {
  recordAlbumRequested,
  recordAlbumSearchCompleted,
} from "../../../services/aurralHistoryService.ts";

type AlbumFailure = { error?: string; statusCode?: number };

const sendFailure = <E extends AppEnv>(
  c: Context<E>,
  { error, statusCode, ...details }: AlbumFailure,
) => c.json({ ...details, error }, isErrorStatus(statusCode) ? statusCode : 500);

const id = v.union([v.string(), v.number()]);

const listQuery = v.object({
  artistId: v.optional(v.string()),
  readPath: v.optional(v.string()),
  source: v.optional(v.string()),
});

const addInput = v.object({
  artistId: v.optional(id),
  releaseGroupMbid: v.optional(v.string()),
  albumName: v.optional(v.string()),
});

const requestInput = v.object({
  albumMbid: v.optional(v.nullable(v.string())),
  albumName: v.optional(v.nullable(v.string())),
  artistMbid: v.optional(v.nullable(v.string())),
  artistName: v.optional(v.nullable(v.string())),
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

      if (query.readPath === "library") {
        const { albums } = getLibraryReadModelForArtistReferences({
          source: query.source || "all",
          availableOnly: true,
          references: [artistId],
          includeSharedAlbums: true,
        });
        return c.json(albums, 200);
      }

      const albums = libraryManager.getAlbums(artistId);
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
        const { artistId, releaseGroupMbid, albumName } = c.req.valid("json");

        if (!artistId || !releaseGroupMbid || !albumName) {
          return c.json({ error: "artistId, releaseGroupMbid, and albumName are required" }, 400);
        }

        let mbid = releaseGroupMbid;
        if (releaseGroupMbid.startsWith("dz-")) {
          const artistName = libraryManager.getArtist(artistId)?.artistName || "";
          const resolved = await resolveDeezerAlbumToMbid(artistName, albumName, releaseGroupMbid);
          if (!resolved) {
            return c.json(
              {
                error: "Could not resolve metadata for this album. Try a different album.",
              },
              400,
            );
          }
          mbid = resolved;
        }

        const album = await libraryManager.addAlbum(artistId, mbid, albumName, { user });
        if (isFailure(album)) {
          logger.error("library", `Failed to add album ${albumName}:`, {
            message: album.error,
          });
          return c.json(
            {
              error: "Failed to add album",
              message: album.error,
              code: album.code || null,
            },
            isErrorStatus(album.statusCode) ? album.statusCode : 503,
          );
        }
        recordAlbumRequested({
          albumId: album.id,
          requestGroupId: album.requestGroupId,
          albumName: album.albumName || albumName,
          artistName: album.artistName,
          artistMbid: album.mbid || album.foreignAlbumId,
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
        const { albumMbid, albumName, artistMbid, artistName } = c.req.valid("json");

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
          user,
        });
        const historyAlbum = {
          albumId: result?.album?.id,
          albumName: result?.album?.albumName || albumName,
          artistName: result?.artist?.artistName || artistName,
          artistMbid: result?.artist?.mbid || artistMbid,
          user,
        };
        recordAlbumRequested({
          ...historyAlbum,
          requestGroupId: result?.requestGroupId || result?.album?.requestGroupId,
        });
        if (result?.status === "available") {
          recordAlbumSearchCompleted(historyAlbum);
        }
        return c.json({ ...result, queued: (result?.jobIds?.length || 0) > 0 }, 201);
      } catch (error) {
        const failure = asAppError(error);
        return c.json(
          {
            error: failure?.message || "Failed to request album",
            code: failure?.code || null,
          },
          isErrorStatus(failure?.statusCode) ? failure.statusCode : 500,
        );
      }
    },
  )
  .get("/albums/:albumId/status", noCache, (c) => {
    try {
      const result = libraryManager.getAlbumStatus(c.req.param("albumId"));
      if (isFailure(result)) return sendFailure(c, result);
      return c.json(result, 200);
    } catch (error) {
      return c.json(
        { error: "Failed to fetch album status", message: asAppError(error)?.message },
        500,
      );
    }
  })
  .put(
    "/albums/:albumId",
    requireAuth,
    requirePermission("changeMonitoring"),
    validate("json", monitoredInput),
    async (c) => {
      try {
        const result = await libraryManager.setAlbumMonitoring(
          c.req.param("albumId"),
          c.req.valid("json"),
        );
        if (isFailure(result)) return sendFailure(c, result);
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
    "/albums/:albumId",
    requireAuth,
    requirePermission("deleteAlbum"),
    validate("query", deleteQuery),
    async (c) => {
      try {
        const result = await libraryManager.deleteAlbum(
          c.req.param("albumId"),
          c.req.valid("query").deleteFiles === "true",
        );
        if (isFailure(result)) return sendFailure(c, result);
        return c.json(result, 200);
      } catch (error) {
        return c.json(
          { error: "Failed to remove album", message: asAppError(error)?.message },
          500,
        );
      }
    },
  )
  .post("/albums/:albumId/cancel", requireAuth, requirePermission("addAlbum"), async (c) => {
    try {
      const result = await libraryManager.cancelAlbum(c.req.param("albumId"));
      if (isFailure(result)) return sendFailure(c, result);
      return c.json(result, 200);
    } catch (error) {
      return c.json({ error: "Failed to cancel album", message: asAppError(error)?.message }, 500);
    }
  })
  .get("/albums/:id", cacheFor(120), async (c) => {
    try {
      const album = libraryManager.getAlbumById(c.req.param("id"));
      if (!album) return c.json({ error: "Album not found" }, 404);
      return c.json(album, 200);
    } catch (error) {
      return c.json({ error: "Failed to fetch album", message: asAppError(error)?.message }, 500);
    }
  });

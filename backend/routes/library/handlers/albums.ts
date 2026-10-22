import type { Router } from "express";
import { libraryManager } from "../../../services/libraryManager.ts";
import type { MappedLibraryAlbum } from "../../../services/libraryManager.ts";
import { playlistManager } from "../../../services/playlists/playlistManager.ts";
import { dbOps } from "../../../db/helpers/index.ts";
import { hasPermission } from "../../../middleware/auth.ts";
import { cacheMiddleware, noCache } from "../../../middleware/cache.ts";
import { requireAuth, requirePermission } from "../../../middleware/requirePermission.ts";
import { logger } from "../../../services/logger.ts";
import { invalidateAllDownloadStatusesCache } from "./downloads.ts";
import { getLibraryReadModelForArtistReferences } from "../../../services/libraryReadModel.ts";
import { asAppError, type AppError } from "../../../../lib/errors.ts";

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

export function registerAlbums(router: Router) {
  router.get("/albums", cacheMiddleware(5), async (req, res) => {
    try {
      const { artistId } = req.query;
      if (!artistId) {
        return res.status(400).json({ error: "artistId parameter is required" });
      }

      if (req.query.readPath === "canonical") {
        const { albums } = getLibraryReadModelForArtistReferences({
          source: req.query.source || "all",
          availableOnly: true,
          references: [artistId],
        });
        return res.json(albums);
      }

      const { managedBy = null } = req.query;
      if (managedBy !== null && managedBy !== "aurral" && managedBy !== "lidarr") {
        return res.status(400).json({ error: "managedBy must be 'aurral' or 'lidarr'" });
      }
      const albums = await libraryManager.getAlbums(artistId, null, {
        managedBy,
        includeAurral: true,
      });
      const formatted = albums.map((album) => ({
        ...album,
        foreignAlbumId: album.foreignAlbumId || album.mbid,
        title: album.albumName,
        statistics: album.statistics || {
          trackCount: 0,
          sizeOnDisk: 0,
          percentOfTracks: 0,
        },
      }));
      res.json(formatted);
    } catch (error) {
      const failure = asAppError(error);
      res.status(500).json({
        error: "Failed to fetch albums",
        message: failure?.message,
      });
    }
  });

  router.post("/albums", requireAuth, requirePermission("addAlbum"), async (req, res) => {
    try {
      const { artistId, releaseGroupMbid, albumName, managedBy: requestedManagedBy } = req.body;

      if (!artistId || !releaseGroupMbid || !albumName) {
        return res.status(400).json({
          error: "artistId, releaseGroupMbid, and albumName are required",
        });
      }

      let managedBy;
      try {
        managedBy = await libraryManager.resolveManagedBy(requestedManagedBy);
      } catch (error) {
        const failure = asAppError(error);
        return res.status(failure?.statusCode || 400).json({
          error: failure?.message,
          code: failure?.code || null,
        });
      }

      let mbid = releaseGroupMbid;
      if (String(releaseGroupMbid).startsWith("dz-")) {
        const { resolveDeezerAlbumToMbid } = await import("../../../services/apiClients/index.ts");
        const artist = await libraryManager.getArtistById(artistId, { managedBy });
        const artistName = artist?.artistName || "";
        mbid = (await resolveDeezerAlbumToMbid(artistName, albumName, releaseGroupMbid)) || null;
        if (!mbid) {
          return res.status(400).json({
            error:
              "Could not resolve metadata for this album. Try adding the artist to Lidarr first or use a different album.",
          });
        }
      }

      const settings = dbOps.getSettings();
      const searchOnAdd =
        managedBy === "lidarr" && (settings.integrations?.lidarr?.searchOnAdd ?? false);

      const album = await libraryManager.addAlbum(artistId, mbid, albumName, {
        triggerSearch: searchOnAdd,
        managedBy,
        user: req.user,
      });
      if (album?.error) {
        logger.error("library", `Failed to add album ${albumName}:`, {
          message: album.error,
        });
        const statusCode =
          typeof album.statusCode === "number" &&
          Number.isInteger(album.statusCode) &&
          album.statusCode >= 400
            ? album.statusCode
            : 503;
        return res.status(statusCode).json({
          error: "Failed to add album",
          message: album.error,
          code: album.code || null,
          managedBy: album.managedBy || null,
          sources: album.sources || [],
          canonicalId: album.canonicalId || null,
          providerId: album.providerId || null,
          availability: album.availability || null,
          conflict: album.conflict || null,
        });
      }
      if (album.artistName && album.albumName) {
        playlistManager
          .removeDiscoverSymlinksForAlbum(album.artistName, album.albumName)
          .catch(() => {});
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
        user: req.user,
      });
      return res.status(201).json({ ...album, queued: false });
    } catch (error) {
      const failure = asAppError(error);
      res.status(500).json({
        error: "Failed to add album",
        message: failure?.message,
      });
    }
  });

  router.post("/albums/request", requireAuth, requirePermission("addAlbum"), async (req, res) => {
    try {
      const {
        albumMbid,
        albumName,
        artistMbid,
        artistName,
        triggerSearch = false,
        managedBy: requestedManagedBy,
      } = req.body || {};

      if (!albumMbid || !albumName || !artistMbid || !artistName) {
        return res.status(400).json({
          error: "albumMbid, albumName, artistMbid, and artistName are required",
        });
      }

      const result = await libraryManager.requestAlbumFromSearch({
        albumMbid,
        albumName,
        artistName,
        artistMbid,
        triggerSearch,
        managedBy: requestedManagedBy,
        user: req.user,
      });
      const settings = dbOps.getSettings();
      const searchOnAdd = settings.integrations?.lidarr?.searchOnAdd ?? false;
      const searching =
        result?.managedBy === "aurral"
          ? result?.status === "queued"
          : triggerSearch === true || searchOnAdd || result?.status === "searching";
      const { recordAlbumRequested, recordAlbumSearchCompleted } =
        await import("../../../services/aurralHistoryService.ts");
      const historyAlbum = {
        albumId: result?.album?.id,
        albumName: result?.album?.albumName || albumName,
        artistName: result?.artist?.artistName || artistName,
        artistMbid: result?.artist?.mbid || artistMbid,
        managedBy: result?.managedBy || null,
        user: req.user,
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
      return res.status(201).json({
        ...result,
        queued: result?.managedBy === "aurral" ? (result?.jobIds?.length || 0) > 0 : false,
      });
    } catch (error) {
      const failure: AlbumRequestFailure | undefined = asAppError(error);
      const statusCode =
        typeof failure?.statusCode === "number" &&
        Number.isInteger(failure.statusCode) &&
        failure.statusCode >= 400
          ? failure.statusCode
          : 500;
      res.status(statusCode).json({
        error: failure?.message || "Failed to request album",
        code: failure?.code || null,
        managedBy: failure?.managedBy || null,
        sources: failure?.sources || [],
        canonicalId: failure?.canonicalId || null,
        providerId: failure?.providerId || null,
        availability: failure?.availability || null,
        conflict: failure?.conflict || null,
      });
    }
  });

  router.get<"/albums/aurral/:canonicalId/status">(
    "/albums/aurral/:canonicalId/status",
    noCache,
    (req, res) => {
      try {
        const result = libraryManager.getAurralAlbumStatus(req.params.canonicalId);
        if (result?.error) {
          const { error, statusCode, ...details } = result;
          return res.status(statusCode || 500).json({ ...details, error });
        }
        return res.json(result);
      } catch (error) {
        const failure = asAppError(error);
        return res.status(500).json({
          error: "Failed to fetch album status",
          message: failure?.message,
        });
      }
    },
  );

  router.put<"/albums/aurral/:canonicalId">(
    "/albums/aurral/:canonicalId",
    requireAuth,
    requirePermission("changeMonitoring"),
    async (req, res) => {
      try {
        const result = await libraryManager.setAurralAlbumMonitoring(req.params.canonicalId, {
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
          error: "Failed to update album monitoring",
          message: failure?.message,
        });
      }
    },
  );

  router.delete<"/albums/aurral/:canonicalId">(
    "/albums/aurral/:canonicalId",
    requireAuth,
    requirePermission("deleteAlbum"),
    async (req, res) => {
      try {
        const result = await libraryManager.deleteAurralAlbum(
          req.params.canonicalId,
          req.query?.deleteFiles === "true",
        );
        if (result?.error) {
          const { error, statusCode, ...details } = result;
          return res.status(statusCode || 500).json({ ...details, error });
        }
        return res.json(result);
      } catch (error) {
        const failure = asAppError(error);
        return res.status(500).json({
          error: "Failed to remove album",
          message: failure?.message,
        });
      }
    },
  );

  router.post<"/albums/aurral/:canonicalId/cancel">(
    "/albums/aurral/:canonicalId/cancel",
    requireAuth,
    requirePermission("addAlbum"),
    async (req, res) => {
      try {
        const result = await libraryManager.cancelAurralAlbum(req.params.canonicalId);
        if (result?.error) {
          const { error, statusCode, ...details } = result;
          return res.status(statusCode || 500).json({ ...details, error });
        }
        return res.json(result);
      } catch (error) {
        const failure = asAppError(error);
        return res.status(500).json({
          error: "Failed to cancel album",
          message: failure?.message,
        });
      }
    },
  );

  router.get<"/albums/:id">("/albums/:id", cacheMiddleware(120), async (req, res) => {
    try {
      const { id } = req.params;
      const album = await libraryManager.getAlbumById(id);
      if (!album) {
        return res.status(404).json({ error: "Album not found" });
      }
      res.json(album);
    } catch (error) {
      const failure = asAppError(error);
      res.status(500).json({
        error: "Failed to fetch album",
        message: failure?.message,
      });
    }
  });

  router.put<"/albums/:id">(
    "/albums/:id",
    requireAuth,
    (req, res, next) => {
      if (hasPermission(req.user, "changeMonitoring") || hasPermission(req.user, "addAlbum")) {
        return next();
      }
      return res.status(403).json({
        error: "Forbidden",
        message: "Permission required: changeMonitoring or addAlbum",
      });
    },
    async (req, res) => {
      try {
        const { id } = req.params;
        const album = await libraryManager.updateAlbum(id, req.body);
        if (album?.error) {
          return res.status(503).json({ error: album.error });
        }
        res.json(album);
      } catch (error) {
        const failure = asAppError(error);
        res.status(500).json({
          error: "Failed to update album",
          message: failure?.message,
        });
      }
    },
  );

  router.delete<"/albums/lidarr/:mbid">(
    "/albums/lidarr/:mbid",
    requireAuth,
    requirePermission("deleteAlbum"),
    async (req, res) => {
      try {
        const result = await libraryManager.deleteLidarrAlbumByMbid(
          req.params.mbid,
          req.query?.deleteFiles === "true",
        );
        if (!result?.success) {
          return res
            .status(result?.statusCode || 503)
            .json({ error: result?.error || "Failed to delete album" });
        }
        res.json({ success: true, message: "Album deleted successfully" });
      } catch (error) {
        const failure = asAppError(error);
        res.status(500).json({ error: "Failed to delete album", message: failure?.message });
      }
    },
  );

  router.delete<"/albums/:id">(
    "/albums/:id",
    requireAuth,
    requirePermission("deleteAlbum"),
    async (req, res) => {
      try {
        const { id } = req.params;
        const { deleteFiles = false } = req.query;
        const result = await libraryManager.deleteAlbum(id, deleteFiles === "true");
        if (!result?.success) {
          return res.status(503).json({ error: result?.error || "Failed to delete album" });
        }
        res.json({ success: true, message: "Album deleted successfully" });
      } catch (error) {
        const failure = asAppError(error);
        res.status(500).json({
          error: "Failed to delete album",
          message: failure?.message,
        });
      }
    },
  );
}

type LibraryAlbumRecord = Awaited<ReturnType<typeof libraryManager.getAlbums>>[number];

export type GetLibraryAlbumsResponse = (LibraryAlbumRecord &
  Partial<MappedLibraryAlbum> & {
    foreignAlbumId: string;
    title: string;
    statistics: NonNullable<LibraryAlbumRecord["statistics"]>;
  })[];

type AurralAlbumRecord = Exclude<
  Awaited<ReturnType<typeof libraryManager._finishAurralAlbum>>,
  { error: string }
>;

export type AddLibraryAlbumResponse = (
  | ReturnType<typeof libraryManager.mapLidarrAlbum>
  | AurralAlbumRecord
) & {
  queued: false;
};

export type RequestAlbumFromSearchResponse = Awaited<
  ReturnType<typeof libraryManager.requestAlbumFromSearch>
> & { queued: boolean };

export type GetAurralAlbumStatusResponse = ReturnType<typeof libraryManager.getAurralAlbumStatus>;

export type DeleteAurralAlbumFromLibraryResponse = Awaited<
  ReturnType<typeof libraryManager.deleteAurralAlbum>
>;

export type CancelAurralAlbumResponse = Awaited<
  ReturnType<typeof libraryManager.cancelAurralAlbum>
>;

export type UpdateLibraryAlbumResponse = Awaited<ReturnType<typeof libraryManager.updateAlbum>>;

export type DeleteLibraryAlbumResponse = { success: true; message: string };

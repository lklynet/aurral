import type { Router } from "express";
import { UUID_REGEX } from "../../../../lib/uuid.ts";
import { libraryManager } from "../../../services/libraryManager.ts";
import { cacheMiddleware, noCache } from "../../../middleware/cache.ts";
import { requireAuth, requirePermission } from "../../../middleware/requirePermission.ts";
import { logger } from "../../../services/logger.ts";
import { getLibraryReadModelForArtistPage } from "../../../services/libraryReadModel.ts";
import { getLibraryArtistProjection } from "../../../services/libraryQueryService.ts";
import { setLibraryArtistMbid } from "../../../services/libraryMediaStore.ts";
import {
  getArtistByMbid,
  isMetadataNotFoundError,
} from "../../../services/providers/brainzmashProvider.ts";
import { asAppError, type AppError } from "../../../../lib/errors.ts";
export function registerArtists(router: Router) {
  router.get("/artists", cacheMiddleware(120), async (req, res) => {
    try {
      const limit = Math.min(Math.max(parseInt(String(req.query.limit), 10) || 10000, 1), 10000);
      const offset = Math.max(parseInt(String(req.query.offset), 10) || 0, 0);
      if (req.query.readPath === "canonical") {
        const { artists } = getLibraryReadModelForArtistPage({
          source: req.query.source || "all",
          limit,
          offset,
        });
        return res.json(
          artists.map((artist) => ({
            ...artist,
            added: artist.addedAt,
          })),
        );
      }
      const artists = getLibraryArtistProjection({ pageSize: limit, offset });
      const formatted = artists.map((artist) => ({
        ...artist,
        foreignArtistId: artist.foreignArtistId || artist.mbid,
        added: artist.addedAt,
      }));
      res.json(formatted);
    } catch (error) {
      const failure = asAppError(error);
      res.status(500).json({
        error: "Failed to fetch artists",
        message: failure?.message,
      });
    }
  });

  router.get<"/artists/:mbid/monitoring">(
    "/artists/:mbid/monitoring",
    noCache,
    async (req, res) => {
      try {
        const { mbid } = req.params;
        if (!UUID_REGEX.test(mbid)) {
          return res.status(400).json({ error: "Invalid MBID format" });
        }
        res.json(await libraryManager.getArtistMonitoring(mbid));
      } catch (error) {
        const failure = asAppError(error);
        res.status(500).json({
          error: "Failed to read artist monitoring",
          message: failure?.message,
        });
      }
    },
  );

  router.get<"/artists/:mbid">("/artists/:mbid", cacheMiddleware(120), async (req, res) => {
    try {
      const { mbid } = req.params;
      if (!UUID_REGEX.test(mbid)) {
        return res.status(400).json({ error: "Invalid MBID format" });
      }

      const artist = await libraryManager.getArtist(mbid);
      if (!artist) {
        return res.status(404).json({ error: "Artist not found" });
      }

      const formatted = {
        ...artist,
        foreignArtistId: artist.foreignArtistId || artist.mbid,
        added: artist.addedAt,
      };
      res.json(formatted);
    } catch (error) {
      const failure = asAppError(error);
      res.status(500).json({
        error: "Failed to fetch artist",
        message: failure?.message,
      });
    }
  });

  router.post("/artists", requireAuth, requirePermission("addArtist"), async (req, res) => {
    try {
      const {
        foreignArtistId: mbid,
        artistName,
        quality,
        monitorOption,
        monitoring,
        rootFolderPath,
        qualityProfileId,
        tagId,
        releaseGroupMbid,
        managedBy: requestedManagedBy,
      } = req.body;

      if (!mbid || !artistName) {
        return res.status(400).json({
          error: "foreignArtistId and artistName are required",
        });
      }

      if (!UUID_REGEX.test(mbid)) {
        return res.status(400).json({ error: "Invalid MBID format" });
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

      const existingArtist = await libraryManager.getArtist(mbid, { managedBy });
      if (existingArtist?.id) {
        return res.status(200).json({
          queued: false,
          foreignArtistId: mbid,
          artistName,
          artist: {
            ...existingArtist,
            foreignArtistId: existingArtist.foreignArtistId || existingArtist.mbid,
            added: existingArtist.addedAt,
          },
        });
      }

      let preparedAddOptions = null;
      try {
        preparedAddOptions = await libraryManager.resolveArtistAddOptions({
          user: req.user,
          managedBy,
          quality,
          monitorOption,
          monitoring,
          rootFolderPath,
          qualityProfileId,
          tagId,
          albumOnly: Boolean(releaseGroupMbid),
          albumMbid: releaseGroupMbid || null,
        });
      } catch (error) {
        const failure: (AppError & { field?: string }) | undefined = asAppError(error);
        const statusCode =
          failure?.statusCode === 400 || failure?.statusCode === 409 ? failure?.statusCode : 500;
        return res.status(statusCode).json({
          error:
            statusCode === 409
              ? "Saved Lidarr default is no longer valid"
              : "Failed to validate Lidarr add options",
          message: failure?.message,
          field: failure?.field || null,
          code: failure?.code || null,
        });
      }

      const artist = await libraryManager.addArtistWithResolvedOptions(mbid, artistName, {
        ...preparedAddOptions,
        user: req.user,
      });
      if (artist?.error) {
        logger.error("library", `Failed to add artist ${artistName}:`, {
          message: artist.error,
        });
        const statusCode =
          typeof artist.statusCode === "number" &&
          Number.isInteger(artist.statusCode) &&
          artist.statusCode >= 400
            ? artist.statusCode
            : 503;
        return res.status(statusCode).json({
          error: "Failed to add artist",
          message: artist.error,
          code: artist.code || null,
        });
      }

      return res.status(201).json({
        queued: false,
        foreignArtistId: mbid,
        artistName,
        artist: {
          ...artist,
          foreignArtistId: artist.foreignArtistId || artist.mbid || mbid,
          added: artist.addedAt,
        },
      });
    } catch (error) {
      const failure = asAppError(error);
      res.status(500).json({
        error: "Failed to add artist",
        message: failure?.message,
      });
    }
  });

  router.put<"/canonical/artists/:id/mbid">(
    "/canonical/artists/:id/mbid",
    requireAuth,
    requirePermission("addArtist"),
    async (req, res) => {
      const artistId = Number(req.params.id);
      const rawMbid = req.body?.mbid;
      const mbid = typeof rawMbid === "string" ? rawMbid.trim().toLowerCase() : rawMbid;
      if (!Number.isSafeInteger(artistId) || (mbid !== null && !UUID_REGEX.test(String(mbid)))) {
        return res.status(400).json({ error: "A MusicBrainz artist ID or null is required" });
      }
      let musicbrainzName = null;
      if (mbid) {
        try {
          const artist = await getArtistByMbid(mbid);
          musicbrainzName = artist.name || null;
        } catch (error) {
          if (isMetadataNotFoundError(error)) {
            return res.status(404).json({ error: "MusicBrainz has no artist with that ID" });
          }
          return res
            .status(503)
            .json({ error: "Could not reach the metadata provider. Try again." });
        }
      }
      const result = setLibraryArtistMbid(artistId, mbid);
      if (result.error === "not_found") {
        return res.status(404).json({ error: "Artist not found" });
      }
      if (result.error === "lidarr_managed") {
        return res
          .status(409)
          .json({ error: "Lidarr manages this artist. Change its MusicBrainz ID in Lidarr." });
      }
      res.json({
        id: result.artist!.id,
        mbid: result.artist!.mbid,
        name: result.artist!.name,
        musicbrainzName,
        merged: Boolean(result.mergedArtistId),
      });
    },
  );

  router.put<"/artists/:mbid">(
    "/artists/:mbid",
    requireAuth,
    requirePermission("changeMonitoring"),
    async (req, res) => {
      try {
        const { mbid } = req.params;
        if (!UUID_REGEX.test(mbid)) {
          return res.status(400).json({ error: "Invalid MBID format" });
        }

        const artist = await libraryManager.setArtistMonitoring(mbid, {
          monitorOption: req.body?.monitorOption,
          monitoring: req.body?.monitoring,
          artistName: req.body?.artistName,
          user: req.user,
        });
        if (artist?.error) {
          return res.status(artist.statusCode || 503).json({
            error: artist.error,
            message: artist.error,
            code: artist.code || null,
          });
        }
        res.json(artist);
      } catch (error) {
        const failure = asAppError(error);
        res.status(500).json({
          error: "Failed to update artist",
          message: failure?.message,
        });
      }
    },
  );

  router.delete<"/artists/:mbid">(
    "/artists/:mbid",
    requireAuth,
    requirePermission("deleteArtist"),
    async (req, res) => {
      try {
        const { mbid } = req.params;
        const { deleteFiles = false, manager = null } = req.query;

        if (!UUID_REGEX.test(mbid) && !/^[1-9]\d*$/.test(mbid)) {
          return res.status(400).json({ error: "Use an artist's MusicBrainz ID or Library id" });
        }
        if (manager !== null && manager !== "aurral" && manager !== "lidarr") {
          return res.status(400).json({ error: "manager must be 'aurral' or 'lidarr'" });
        }

        const result = await libraryManager.deleteArtist(mbid, deleteFiles === "true", { manager });
        if (!result?.success) {
          const message = result?.error || "Failed to delete artist";
          return res
            .status(result?.statusCode || 503)
            .json({ error: message, message, code: result?.code });
        }
        res.json({ success: true, message: "Artist deleted successfully" });
      } catch (error) {
        const failure = asAppError(error);
        res.status(500).json({
          error: "Failed to delete artist",
          message: failure?.message,
        });
      }
    },
  );

  router.post<"/artists/:mbid/refresh">(
    "/artists/:mbid/refresh",
    requireAuth,
    requirePermission("changeMonitoring"),
    async (req, res) => {
      try {
        const { mbid } = req.params;
        if (!UUID_REGEX.test(mbid)) {
          return res.status(400).json({ error: "Invalid MBID format" });
        }

        const artist = await libraryManager.getArtist(mbid);
        if (!artist) {
          return res.status(404).json({ error: "Artist not found" });
        }

        const { lidarrClient } = await import("../../../services/lidarrClient.ts");

        const albums = await libraryManager.getAlbums(artist.id);

        if (artist.id && lidarrClient && lidarrClient.isConfigured()) {
          const lidarrArtist = await lidarrClient.getArtist(artist.id);
          if (lidarrArtist?.monitored) {
            await lidarrClient.triggerArtistSearch(lidarrArtist.id);
          }
        }

        res.json({
          success: true,
          message: "Artist refreshed successfully",
          albums: albums.length,
        });
      } catch (error) {
        const failure = asAppError(error);
        res.status(500).json({
          error: "Failed to refresh artist",
          message: failure?.message,
        });
      }
    },
  );
}

type LibraryArtistRecord =
  | ReturnType<typeof libraryManager.mapLidarrArtist>
  | ReturnType<typeof getLibraryArtistProjection>[number];

type WithNullableForeignArtistId<Artist> = Artist extends unknown
  ? Omit<Artist, "foreignArtistId"> & { foreignArtistId: string | null }
  : never;

export type FetchLibraryArtistResponse = WithNullableForeignArtistId<LibraryArtistRecord> & {
  added: LibraryArtistRecord["addedAt"];
};

export type AddArtistToLibraryResponse = {
  queued: false;
  foreignArtistId: string;
  artistName: string;
  artist: FetchLibraryArtistResponse;
};

export type UpdateLibraryArtistMbidResponse = {
  id: number;
  mbid: string | null;
  name: string;
  musicbrainzName: string | null;
  merged: boolean;
};

export type UpdateLibraryArtistResponse = Awaited<
  ReturnType<typeof libraryManager.setArtistMonitoring>
>;

export type GetArtistMonitoringResponse = Awaited<
  ReturnType<typeof libraryManager.getArtistMonitoring>
>;

export type DeleteArtistFromLibraryResponse = { success: true; message: string };

export type RefreshLibraryArtistResponse = { success: true; message: string; albums: number };

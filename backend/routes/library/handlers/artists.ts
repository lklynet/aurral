import { Hono } from "hono";
import * as v from "valibot";
import { UUID_REGEX } from "../../../../lib/uuid.ts";
import { libraryManager } from "../../../services/libraryManager.ts";
import { cacheFor, noCache } from "../../../middleware/cacheHeaders.ts";
import { requireAuth, requirePermission } from "../../../middleware/guards.ts";
import type { AppEnv } from "../../../middleware/requestUser.ts";
import { validate } from "../../../middleware/validate.ts";
import { logger } from "../../../services/logger.ts";
import { getLibraryReadModelForArtistPage } from "../../../services/libraryReadModel.ts";
import { getLibraryArtistProjection } from "../../../services/libraryQueryService.ts";
import { setLibraryArtistMbid } from "../../../services/libraryMediaStore.ts";
import {
  getArtistByMbid,
  isMetadataNotFoundError,
} from "../../../services/providers/brainzmashProvider.ts";
import { asAppError, type AppError } from "../../../../lib/errors.ts";
import { isErrorStatus, isFailure } from "../../shared/errorStatus.ts";

const listQuery = v.object({
  limit: v.optional(v.string()),
  offset: v.optional(v.string()),
  readPath: v.optional(v.string()),
  source: v.optional(v.string()),
});

const id = v.union([v.string(), v.number()]);

const monitoringInput = v.object({
  monitored: v.optional(v.boolean()),
  useDefault: v.optional(v.boolean()),
  rules: v.optional(v.unknown()),
});

const addInput = v.object({
  foreignArtistId: v.optional(v.string()),
  artistName: v.optional(v.string()),
  quality: v.optional(v.nullable(v.string())),
  monitorOption: v.optional(v.nullable(v.string())),
  monitoring: v.optional(v.nullable(monitoringInput)),
  rootFolderPath: v.optional(v.nullable(v.string())),
  qualityProfileId: v.optional(v.nullable(id)),
  tagId: v.optional(v.nullable(id)),
  releaseGroupMbid: v.optional(v.nullable(v.string())),
  managedBy: v.optional(v.nullable(v.string())),
});

const mbidInput = v.object({ mbid: v.optional(v.nullable(v.string())) });

const updateInput = v.object({
  monitorOption: v.optional(v.nullable(v.string())),
  monitoring: v.optional(v.nullable(monitoringInput)),
  artistName: v.optional(v.nullable(v.string())),
});

const deleteQuery = v.object({
  deleteFiles: v.optional(v.string()),
  manager: v.optional(v.string()),
});

export default new Hono<AppEnv>()
  .basePath("/library")
  .get("/artists", cacheFor(120), validate("query", listQuery), (c) => {
    const query = c.req.valid("query");
    try {
      const limit = Math.min(Math.max(Number.parseInt(query.limit ?? "", 10) || 10000, 1), 10000);
      const offset = Math.max(Number.parseInt(query.offset ?? "", 10) || 0, 0);
      if (query.readPath === "canonical") {
        const { artists } = getLibraryReadModelForArtistPage({
          source: query.source || "all",
          limit,
          offset,
        });
        return c.json(
          artists.map((artist) => ({ ...artist, added: artist.addedAt })),
          200,
        );
      }
      const artists = getLibraryArtistProjection({ pageSize: limit, offset });
      return c.json(
        artists.map((artist) => ({
          ...artist,
          foreignArtistId: artist.foreignArtistId || artist.mbid,
          added: artist.addedAt,
        })),
        200,
      );
    } catch (error) {
      return c.json({ error: "Failed to fetch artists", message: asAppError(error)?.message }, 500);
    }
  })
  .get("/artists/:mbid/monitoring", noCache, async (c) => {
    try {
      const mbid = c.req.param("mbid");
      if (!UUID_REGEX.test(mbid)) return c.json({ error: "Invalid MBID format" }, 400);
      return c.json(await libraryManager.getArtistMonitoring(mbid), 200);
    } catch (error) {
      return c.json(
        { error: "Failed to read artist monitoring", message: asAppError(error)?.message },
        500,
      );
    }
  })
  .get("/artists/:mbid", cacheFor(120), async (c) => {
    try {
      const mbid = c.req.param("mbid");
      if (!UUID_REGEX.test(mbid)) return c.json({ error: "Invalid MBID format" }, 400);
      const artist = await libraryManager.getArtist(mbid);
      if (!artist) return c.json({ error: "Artist not found" }, 404);
      return c.json(
        {
          ...artist,
          foreignArtistId: artist.foreignArtistId || artist.mbid,
          added: artist.addedAt,
        },
        200,
      );
    } catch (error) {
      return c.json({ error: "Failed to fetch artist", message: asAppError(error)?.message }, 500);
    }
  })
  .post(
    "/artists",
    requireAuth,
    requirePermission("addArtist"),
    validate("json", addInput),
    async (c) => {
      const user = c.var.user;
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
        } = c.req.valid("json");

        if (!mbid || !artistName) {
          return c.json({ error: "foreignArtistId and artistName are required" }, 400);
        }
        if (!UUID_REGEX.test(mbid)) return c.json({ error: "Invalid MBID format" }, 400);

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

        const existingArtist = await libraryManager.getArtist(mbid, { managedBy });
        if (existingArtist?.id) {
          return c.json(
            {
              queued: false,
              foreignArtistId: mbid,
              artistName,
              artist: {
                ...existingArtist,
                foreignArtistId: existingArtist.foreignArtistId || existingArtist.mbid,
                added: existingArtist.addedAt,
              },
            },
            200,
          );
        }

        let preparedAddOptions = null;
        try {
          preparedAddOptions = await libraryManager.resolveArtistAddOptions({
            user,
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
            failure?.statusCode === 400 || failure?.statusCode === 409 ? failure.statusCode : 500;
          return c.json(
            {
              error:
                statusCode === 409
                  ? "Saved Lidarr default is no longer valid"
                  : "Failed to validate Lidarr add options",
              message: failure?.message,
              field: failure?.field || null,
              code: failure?.code || null,
            },
            statusCode,
          );
        }

        const artist = await libraryManager.addArtistWithResolvedOptions(mbid, artistName, {
          ...preparedAddOptions,
          user,
        });
        if (isFailure(artist)) {
          logger.error("library", `Failed to add artist ${artistName}:`, {
            message: artist.error,
          });
          return c.json(
            { error: "Failed to add artist", message: artist.error, code: artist.code || null },
            isErrorStatus(artist.statusCode) ? artist.statusCode : 503,
          );
        }

        return c.json(
          {
            queued: false,
            foreignArtistId: mbid,
            artistName,
            artist: {
              ...artist,
              foreignArtistId: artist.foreignArtistId || artist.mbid || mbid,
              added: artist.addedAt,
            },
          },
          201,
        );
      } catch (error) {
        return c.json({ error: "Failed to add artist", message: asAppError(error)?.message }, 500);
      }
    },
  )
  .put(
    "/canonical/artists/:id/mbid",
    requireAuth,
    requirePermission("addArtist"),
    validate("json", mbidInput),
    async (c) => {
      const artistId = Number(c.req.param("id"));
      const rawMbid = c.req.valid("json").mbid;
      const mbid = typeof rawMbid === "string" ? rawMbid.trim().toLowerCase() : rawMbid;
      if (!Number.isSafeInteger(artistId) || (mbid !== null && !UUID_REGEX.test(String(mbid)))) {
        return c.json({ error: "A MusicBrainz artist ID or null is required" }, 400);
      }
      let musicbrainzName = null;
      if (mbid) {
        try {
          const artist = await getArtistByMbid(mbid);
          musicbrainzName = artist.name || null;
        } catch (error) {
          if (isMetadataNotFoundError(error)) {
            return c.json({ error: "MusicBrainz has no artist with that ID" }, 404);
          }
          return c.json({ error: "Could not reach the metadata provider. Try again." }, 503);
        }
      }
      const result = setLibraryArtistMbid(artistId, mbid ?? null);
      if (result.error === "lidarr_managed") {
        return c.json(
          { error: "Lidarr manages this artist. Change its MusicBrainz ID in Lidarr." },
          409,
        );
      }
      const { artist } = result;
      if (!artist) return c.json({ error: "Artist not found" }, 404);
      return c.json(
        {
          id: artist.id,
          mbid: artist.mbid,
          name: artist.name,
          musicbrainzName,
          merged: Boolean(result.mergedArtistId),
        },
        200,
      );
    },
  )
  .put(
    "/artists/:mbid",
    requireAuth,
    requirePermission("changeMonitoring"),
    validate("json", updateInput),
    async (c) => {
      try {
        const mbid = c.req.param("mbid");
        if (!UUID_REGEX.test(mbid)) return c.json({ error: "Invalid MBID format" }, 400);
        const artist = await libraryManager.setArtistMonitoring(mbid, {
          ...c.req.valid("json"),
          user: c.var.user,
        });
        if (isFailure(artist)) {
          return c.json(
            { error: artist.error, message: artist.error, code: artist.code || null },
            isErrorStatus(artist.statusCode) ? artist.statusCode : 503,
          );
        }
        return c.json(artist, 200);
      } catch (error) {
        return c.json(
          { error: "Failed to update artist", message: asAppError(error)?.message },
          500,
        );
      }
    },
  )
  .delete(
    "/artists/:mbid",
    requireAuth,
    requirePermission("deleteArtist"),
    validate("query", deleteQuery),
    async (c) => {
      try {
        const mbid = c.req.param("mbid");
        const { deleteFiles, manager = null } = c.req.valid("query");
        if (!UUID_REGEX.test(mbid) && !/^[1-9]\d*$/.test(mbid)) {
          return c.json({ error: "Use an artist's MusicBrainz ID or Library id" }, 400);
        }
        if (manager !== null && manager !== "aurral" && manager !== "lidarr") {
          return c.json({ error: "manager must be 'aurral' or 'lidarr'" }, 400);
        }
        const result = await libraryManager.deleteArtist(mbid, deleteFiles === "true", {
          manager,
        });
        if (!result?.success) {
          const message = result?.error || "Failed to delete artist";
          return c.json(
            { error: message, message, code: result?.code },
            isErrorStatus(result?.statusCode) ? result.statusCode : 503,
          );
        }
        return c.json({ success: true, message: "Artist deleted successfully" }, 200);
      } catch (error) {
        return c.json(
          { error: "Failed to delete artist", message: asAppError(error)?.message },
          500,
        );
      }
    },
  )
  .post("/artists/:mbid/refresh", requireAuth, requirePermission("changeMonitoring"), async (c) => {
    try {
      const mbid = c.req.param("mbid");
      if (!UUID_REGEX.test(mbid)) return c.json({ error: "Invalid MBID format" }, 400);
      const artist = await libraryManager.getArtist(mbid);
      if (!artist) return c.json({ error: "Artist not found" }, 404);

      const { lidarrClient } = await import("../../../services/lidarrClient.ts");
      const albums = await libraryManager.getAlbums(artist.id);
      if (lidarrClient && lidarrClient.isConfigured()) {
        const lidarrArtist = await lidarrClient.getArtistByMbid(mbid, { forceRefresh: true });
        const monitoring = lidarrArtist ? libraryManager.mapLidarrArtist(lidarrArtist) : null;
        if (lidarrArtist && monitoring?.monitored && monitoring.monitorOption !== "none") {
          await lidarrClient.triggerArtistSearch(lidarrArtist.id);
        }
      }
      return c.json(
        { success: true, message: "Artist refreshed successfully", albums: albums.length },
        200,
      );
    } catch (error) {
      return c.json(
        { error: "Failed to refresh artist", message: asAppError(error)?.message },
        500,
      );
    }
  });

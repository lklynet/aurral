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
import { artistQueueTracks } from "../../../services/queueTracks.ts";
import { asAppError } from "../../../../lib/errors.ts";
import { isErrorStatus, isFailure } from "../../shared/errorStatus.ts";

const listQuery = v.object({
  limit: v.optional(v.string()),
  offset: v.optional(v.string()),
  readPath: v.optional(v.string()),
  source: v.optional(v.string()),
});

const monitoringInput = v.object({
  monitored: v.optional(v.boolean()),
  useDefault: v.optional(v.boolean()),
  rules: v.optional(v.unknown()),
});

const addInput = v.object({
  foreignArtistId: v.optional(v.string()),
  artistName: v.optional(v.string()),
  monitoring: v.optional(v.nullable(monitoringInput)),
  releaseGroupMbid: v.optional(v.nullable(v.string())),
});

const updateInput = v.object({
  monitoring: v.optional(v.nullable(monitoringInput)),
  artistName: v.optional(v.nullable(v.string())),
});

const deleteQuery = v.object({
  deleteFiles: v.optional(v.string()),
});

export default new Hono<AppEnv>()
  .basePath("/library")
  .get("/artists", cacheFor(120), validate("query", listQuery), (c) => {
    const query = c.req.valid("query");
    try {
      const limit = Math.min(Math.max(Number.parseInt(query.limit ?? "", 10) || 10000, 1), 10000);
      const offset = Math.max(Number.parseInt(query.offset ?? "", 10) || 0, 0);
      if (query.readPath === "library") {
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
      return c.json(libraryManager.getArtistMonitoring(mbid), 200);
    } catch (error) {
      return c.json(
        { error: "Failed to read artist monitoring", message: asAppError(error)?.message },
        500,
      );
    }
  })
  .get("/artists/:mbid/queue", noCache, (c) => {
    const mbid = c.req.param("mbid");
    if (!UUID_REGEX.test(mbid)) return c.json({ error: "Invalid MBID format" }, 400);
    return c.json({ tracks: artistQueueTracks(mbid) }, 200);
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
          monitoring,
          releaseGroupMbid,
        } = c.req.valid("json");

        if (!mbid || !artistName) {
          return c.json({ error: "foreignArtistId and artistName are required" }, 400);
        }
        if (!UUID_REGEX.test(mbid)) return c.json({ error: "Invalid MBID format" }, 400);

        const existingArtist = libraryManager.getArtist(mbid);
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

        const artist = await libraryManager.addArtist(mbid, artistName, {
          user,
          monitoring,
          albumOnly: Boolean(releaseGroupMbid),
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
        const { deleteFiles } = c.req.valid("query");
        if (!UUID_REGEX.test(mbid) && !/^[1-9]\d*$/.test(mbid)) {
          return c.json({ error: "Use an artist's MusicBrainz ID or Library id" }, 400);
        }
        const result = await libraryManager.deleteArtist(mbid, deleteFiles === "true");
        if (!result?.success) {
          const message = result?.error || "Failed to delete artist";
          return c.json(
            { error: message, message, code: result?.code },
            isErrorStatus(result?.statusCode) ? result.statusCode : 503,
          );
        }
        return c.json(
          {
            success: true,
            remains: result.remains === true,
            message: "Artist deleted successfully",
          },
          200,
        );
      } catch (error) {
        return c.json(
          { error: "Failed to delete artist", message: asAppError(error)?.message },
          500,
        );
      }
    },
  );

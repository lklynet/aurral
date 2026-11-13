import { Hono } from "hono";
import * as v from "valibot";
import { lastfmStationClient } from "../../../services/importLists/lastfmStations.ts";
import { logger, safeLogDiagnostic } from "../../../services/logger.ts";
import { asAppError } from "../../../../lib/errors.ts";
import { validate } from "../../../middleware/validate.ts";
import { getErrorStatus } from "../../shared/errorStatus.ts";
import { requirePlaylistAccess } from "./utils.ts";
import type { AppEnv } from "../../../middleware/requestUser.ts";

export default new Hono<AppEnv>().get(
  "/import/lastfm/playlists",
  requirePlaylistAccess,
  validate("query", v.object({ username: v.optional(v.union([v.string(), v.array(v.string())])) })),
  async (c) => {
    try {
      const { username } = c.req.valid("query");
      const requestedUsername = Array.isArray(username) ? username[0] : username;
      return c.json(await lastfmStationClient.listPlaylists(c.var.user.id, requestedUsername), 200);
    } catch (error) {
      logger.warn("playlist-import", "Last.fm station listing failed", {
        reason: safeLogDiagnostic(error),
      });
      return c.json(
        {
          error: "Failed to fetch Last.fm stations",
          message: asAppError(error)?.message || "Unknown error",
        },
        getErrorStatus(error),
      );
    }
  },
);

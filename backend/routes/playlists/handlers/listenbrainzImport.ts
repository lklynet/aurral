import { Hono } from "hono";
import { listenbrainzPlaylistClient } from "../../../services/importLists/listenbrainzPlaylists.ts";
import { logger, safeLogDiagnostic } from "../../../services/logger.ts";
import { asAppError } from "../../../../lib/errors.ts";
import { getErrorStatus } from "../../shared/errorStatus.ts";
import { requirePlaylistAccess } from "./utils.ts";
import type { AppEnv } from "../../../middleware/requestUser.ts";

export default new Hono<AppEnv>().get(
  "/import/listenbrainz/playlists",
  requirePlaylistAccess,
  async (c) => {
    try {
      return c.json(await listenbrainzPlaylistClient.listPlaylists(c.var.user.id), 200);
    } catch (error) {
      logger.warn("playlist-import", "ListenBrainz playlist listing failed", {
        reason: safeLogDiagnostic(error),
      });
      return c.json(
        {
          error: "Failed to fetch ListenBrainz playlists",
          message: asAppError(error)?.message || "Unknown error",
        },
        getErrorStatus(error),
      );
    }
  },
);

import { Hono, type Context } from "hono";
import * as v from "valibot";
import { requireAuth, requirePermission } from "../../../middleware/guards.ts";
import type { AppEnv } from "../../../middleware/requestUser.ts";
import { validate } from "../../../middleware/validate.ts";
import {
  addEditorialPlaylistToLibrary,
  getEditorialPlaylist,
  getEditorialShelf,
  resolveEditorialTrackLinks,
} from "../../../services/discovery/editorialPlaylists.ts";
import { logger, safeLogDiagnostic } from "../../../services/logger.ts";
import { errorStatus } from "../../shared/errorStatus.ts";
import { asAppError } from "../../../../lib/errors.ts";

const sendEditorialError = <E extends AppEnv>(c: Context<E>, error: unknown, fallback: string) => {
  const failure = asAppError(error);
  const status = errorStatus(failure);
  logger[status >= 500 ? "warn" : "debug"]("discovery", fallback, {
    reason: safeLogDiagnostic(error),
  });
  return c.json(
    {
      error: fallback,
      message: failure?.message || "Unknown error",
      ...(failure?.code ? { code: failure.code } : {}),
    },
    status,
  );
};

const linksQuery = v.object({
  artist: v.optional(v.string()),
  album: v.optional(v.string()),
  albumId: v.optional(v.string()),
});

export default new Hono<AppEnv>()
  .get("/editorial", requireAuth, async (c) => {
    try {
      return c.json(await getEditorialShelf(c.var.user), 200);
    } catch (error) {
      return sendEditorialError(c, error, "Failed to load editorial playlists");
    }
  })
  .get("/editorial/links", requireAuth, validate("query", linksQuery), async (c) => {
    const { artist, album, albumId } = c.req.valid("query");
    try {
      return c.json(
        await resolveEditorialTrackLinks({
          artistName: artist,
          albumName: album,
          deezerAlbumId: albumId,
        }),
        200,
      );
    } catch (error) {
      return sendEditorialError(c, error, "Failed to find this artist or album");
    }
  })
  .get("/editorial/:playlistId", requireAuth, async (c) => {
    try {
      c.header("Cache-Control", "no-store");
      return c.json(await getEditorialPlaylist(c.var.user, c.req.param("playlistId")), 200);
    } catch (error) {
      return sendEditorialError(c, error, "Failed to load editorial playlist");
    }
  })
  .post(
    "/editorial/:playlistId/library",
    requireAuth,
    requirePermission("accessFlow"),
    async (c) => {
      try {
        return c.json(
          await addEditorialPlaylistToLibrary(c.var.user, c.req.param("playlistId")),
          200,
        );
      } catch (error) {
        return sendEditorialError(c, error, "Failed to add editorial playlist");
      }
    },
  );

import { Hono, type Context } from "hono";
import * as v from "valibot";
import { requireAuth, requirePermission } from "../../../middleware/guards.ts";
import type { AppEnv } from "../../../middleware/requestUser.ts";
import { validate } from "../../../middleware/validate.ts";
import {
  browseProviderSchema,
  getBrowsePlaylist,
  getMadeForYou,
  getPlaylistShelf,
  saveBrowsePlaylist,
} from "../../../services/discovery/browsePlaylists.ts";
import { resolveEditorialTrackLinks } from "../../../services/discovery/editorialPlaylists.ts";
import { logger, safeLogDiagnostic } from "../../../services/logger.ts";
import { errorStatus } from "../../shared/errorStatus.ts";
import { asAppError } from "../../../../lib/errors.ts";

const sendPlaylistError = <E extends AppEnv>(c: Context<E>, error: unknown, fallback: string) => {
  const failure = asAppError(error);
  const status = errorStatus(failure);
  logger[status >= 500 ? "warn" : "debug"]("discovery", fallback, {
    reason: safeLogDiagnostic(error),
  });
  return c.json(
    {
      error: fallback,
      message: failure?.message || "Unknown error",
      ...(failure?.code && { code: failure.code }),
    },
    status,
  );
};

const linksQuery = v.object({
  artist: v.optional(v.string()),
  album: v.optional(v.string()),
  albumId: v.optional(v.string()),
});

const shelfQuery = v.object({ scope: v.optional(v.picklist(["featured", "all"])) });

const playlistParams = v.object({ provider: browseProviderSchema, playlistId: v.string() });

export default new Hono<AppEnv>()
  .get("/playlists", requireAuth, validate("query", shelfQuery), async (c) => {
    try {
      return c.json(await getPlaylistShelf(c.var.user, c.req.valid("query").scope), 200);
    } catch (error) {
      return sendPlaylistError(c, error, "Failed to load playlists");
    }
  })
  .get("/playlists/made-for-you", requireAuth, async (c) => {
    try {
      c.header("Cache-Control", "no-store");
      return c.json(await getMadeForYou(c.var.user), 200);
    } catch (error) {
      return sendPlaylistError(c, error, "Failed to load your playlists");
    }
  })
  .get("/playlists/links", requireAuth, validate("query", linksQuery), async (c) => {
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
      return sendPlaylistError(c, error, "Failed to find this artist or album");
    }
  })
  .get(
    "/playlists/:provider/:playlistId",
    requireAuth,
    validate("param", playlistParams),
    async (c) => {
      const { provider, playlistId } = c.req.valid("param");
      try {
        c.header("Cache-Control", "no-store");
        return c.json(await getBrowsePlaylist(c.var.user, provider, playlistId), 200);
      } catch (error) {
        return sendPlaylistError(c, error, "Failed to load playlist");
      }
    },
  )
  .post(
    "/playlists/:provider/:playlistId/library",
    requireAuth,
    requirePermission("accessFlow"),
    validate("param", playlistParams),
    async (c) => {
      const { provider, playlistId } = c.req.valid("param");
      try {
        return c.json(await saveBrowsePlaylist(c.var.user, provider, playlistId), 200);
      } catch (error) {
        return sendPlaylistError(c, error, "Failed to add playlist");
      }
    },
  );

import { Hono } from "hono";
import * as v from "valibot";
import { requireAuth } from "../middleware/guards.ts";
import type { AppEnv } from "../middleware/requestUser.ts";
import { validate } from "../middleware/validate.ts";
import { resolveLibraryTrackPath } from "../services/libraryReadModel.ts";
import { findTrackLyrics } from "../services/lyricsService.ts";

const lyricsQuery = v.object({
  artist: v.string(),
  title: v.string(),
  album: v.optional(v.string()),
  durationMs: v.optional(v.string()),
  libraryAlbumId: v.optional(v.string()),
  libraryTrackId: v.optional(v.string()),
});

export default new Hono<AppEnv>()
  .basePath("/lyrics")
  .use(requireAuth)
  .get("/", validate("query", lyricsQuery), async (c) => {
    const { libraryAlbumId, libraryTrackId, durationMs, ...track } = c.req.valid("query");
    const lyrics = await findTrackLyrics({
      ...track,
      filePath:
        libraryAlbumId && libraryTrackId
          ? resolveLibraryTrackPath(libraryAlbumId, libraryTrackId)
          : null,
      durationSec: Number(durationMs) / 1000 || null,
    });
    return c.json({ lyrics }, 200);
  });

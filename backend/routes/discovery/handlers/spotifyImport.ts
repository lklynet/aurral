import { Hono } from "hono";
import * as v from "valibot";
import { requireAuth, requireUserAccount } from "../../../middleware/guards.ts";
import type { AppEnv } from "../../../middleware/requestUser.ts";
import { validate } from "../../../middleware/validate.ts";
import { SPOTIFY_IMPORT_MAX_ARTISTS } from "../../../../lib/spotifyExport.ts";
import { requestUserDiscoveryRefresh } from "../../../services/discovery/provider.ts";
import {
  clearSpotifyImport,
  getSpotifyImportSummary,
  saveSpotifyImport,
} from "../../../services/spotify/spotifyImport.ts";

const count = v.pipe(v.number(), v.integer(), v.minValue(0));
const timestamp = v.nullable(count);

const importInput = v.object({
  artists: v.pipe(
    v.array(
      v.object({
        name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(500)),
        plays: count,
        score: v.pipe(v.number(), v.minValue(0)),
        likedTracks: count,
        followed: v.boolean(),
        firstPlayedAt: timestamp,
        lastPlayedAt: timestamp,
      }),
    ),
    v.minLength(1),
    v.maxLength(SPOTIFY_IMPORT_MAX_ARTISTS),
  ),
});

const refresh = (userId: number) =>
  requestUserDiscoveryRefresh(userId, { reason: "spotify_import", delaySeconds: 0 });

export default new Hono<AppEnv>()
  .get("/spotify-import", requireAuth, requireUserAccount, (c) =>
    c.json({ summary: getSpotifyImportSummary(c.var.user.id) }, 200),
  )
  .put("/spotify-import", requireAuth, requireUserAccount, validate("json", importInput), (c) => {
    const userId = c.var.user.id;
    saveSpotifyImport(userId, c.req.valid("json").artists);
    refresh(userId);
    return c.json({ summary: getSpotifyImportSummary(userId) }, 200);
  })
  .delete("/spotify-import", requireAuth, requireUserAccount, (c) => {
    const userId = c.var.user.id;
    if (clearSpotifyImport(userId)) refresh(userId);
    return c.json({ summary: null }, 200);
  });

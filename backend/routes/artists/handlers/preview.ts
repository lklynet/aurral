import { Hono } from "hono";
import * as v from "valibot";
import { deezerGetArtistTopTracksById } from "../../../services/apiClients/index.ts";
import { dbOps } from "../../../db/helpers/index.ts";
import { getArtistByMbid } from "../../../services/providers/metadataProvider.ts";
import { UUID_REGEX } from "../../../../lib/uuid.ts";
import { cacheFor } from "../../../middleware/cacheHeaders.ts";
import type { AppEnv } from "../../../middleware/requestUser.ts";
import { validate } from "../../../middleware/validate.ts";
import { resolveDeezerArtistId } from "../shared/deezerArtist.ts";
import { toArtistTopTracks } from "../shared/transform.ts";
import { invalidMbid, queryText } from "../utils.ts";

export default new Hono<AppEnv>()
  .basePath("/artists")
  .get(
    "/:mbid/preview",
    cacheFor(60),
    validate("query", v.object({ artistName: queryText })),
    async (c) => {
      const mbid = c.req.param("mbid");
      if (!UUID_REGEX.test(mbid)) return c.json(invalidMbid(mbid), 400);
      const { artistName } = c.req.valid("query");
      const override = dbOps.getArtistOverride(mbid);
      const artist = await getArtistByMbid(override?.musicbrainzId || mbid).catch(() => null);
      const listed = toArtistTopTracks(artist, artistName);
      if (listed.length) return c.json({ tracks: listed }, 200);
      const deezerArtistId = await resolveDeezerArtistId(mbid, artistName);
      const tracks = deezerArtistId ? await deezerGetArtistTopTracksById(deezerArtistId) : [];
      return c.json({ tracks }, 200);
    },
  );

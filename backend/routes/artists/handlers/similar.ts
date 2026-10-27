import { Hono } from "hono";
import * as v from "valibot";
import { musicbrainzGetArtistNameByMbid } from "../../../services/apiClients/index.ts";
import { dbOps } from "../../../db/helpers/index.ts";
import { getSimilarArtistCards } from "../shared/transform.ts";
import { UUID_REGEX } from "../../../../lib/uuid.ts";
import { cacheFor } from "../../../middleware/cacheHeaders.ts";
import type { AppEnv } from "../../../middleware/requestUser.ts";
import { validate } from "../../../middleware/validate.ts";
import { invalidMbid, queryText } from "../utils.ts";

const similarQuery = v.object({
  limit: v.optional(
    v.pipe(
      v.string(),
      v.transform((limit) => Math.min(Math.max(Number.parseInt(limit, 10) || 7, 1), 20)),
    ),
    "10",
  ),
  artistName: queryText,
});

export default new Hono<AppEnv>()
  .basePath("/artists")
  .get("/:mbid/similar", cacheFor(300), validate("query", similarQuery), async (c) => {
    const mbid = c.req.param("mbid");
    if (!UUID_REGEX.test(mbid)) return c.json(invalidMbid(mbid), 400);

    const { limit, artistName } = c.req.valid("query");
    const resolvedMbid = dbOps.getArtistOverride(mbid)?.musicbrainzId || mbid;
    const artists = await getSimilarArtistCards(resolvedMbid, {
      artistName,
      limit,
      resolveArtistName: () => musicbrainzGetArtistNameByMbid(resolvedMbid),
    });
    return c.json({ artists }, 200);
  });

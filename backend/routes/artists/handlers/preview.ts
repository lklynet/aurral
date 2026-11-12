import { Hono } from "hono";
import * as v from "valibot";
import { deezerGetArtistTopTracksById } from "../../../services/apiClients/index.ts";
import { UUID_REGEX } from "../../../../lib/uuid.ts";
import { cacheFor } from "../../../middleware/cacheHeaders.ts";
import type { AppEnv } from "../../../middleware/requestUser.ts";
import { validate } from "../../../middleware/validate.ts";
import { resolveDeezerArtistId } from "../shared/deezerArtist.ts";
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
      const deezerArtistId = await resolveDeezerArtistId(mbid, c.req.valid("query").artistName);
      const tracks = deezerArtistId ? await deezerGetArtistTopTracksById(deezerArtistId) : [];
      return c.json({ tracks }, 200);
    },
  );

import { Hono } from "hono";
import * as v from "valibot";
import { youtubeFindTopSongVideo } from "../../../services/apiClients/index.ts";
import { UUID_REGEX } from "../../../../lib/uuid.ts";
import { noCache } from "../../../middleware/cacheHeaders.ts";
import type { AppEnv } from "../../../middleware/requestUser.ts";
import { validate } from "../../../middleware/validate.ts";
import { invalidMbid, queryText } from "../utils.ts";

const videoQuery = v.object({ artistName: queryText, trackTitle: queryText });

export default new Hono<AppEnv>()
  .basePath("/artists")
  .get("/:mbid/video", noCache, validate("query", videoQuery), async (c) => {
    const mbid = c.req.param("mbid");
    if (!UUID_REGEX.test(mbid)) return c.json(invalidMbid(mbid), 400);

    const { artistName, trackTitle } = c.req.valid("query");
    if (!artistName || !trackTitle) return c.json({ video: null }, 200);

    try {
      return c.json({ video: await youtubeFindTopSongVideo(artistName, trackTitle) }, 200);
    } catch {
      return c.json({ error: "Video search is unavailable. Try again." }, 503);
    }
  });

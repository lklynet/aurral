import { Hono } from "hono";
import * as v from "valibot";
import { UUID_REGEX } from "../../../../lib/uuid.ts";
import { requireAuth } from "../../../middleware/guards.ts";
import type { AppEnv } from "../../../middleware/requestUser.ts";
import { validate } from "../../../middleware/validate.ts";
import { getArtistListening } from "../../../services/artistListening.ts";
import { invalidMbid, queryText } from "../utils.ts";

export default new Hono<AppEnv>()
  .basePath("/artists")
  .get(
    "/:mbid/listening",
    requireAuth,
    validate("query", v.object({ artistName: queryText })),
    (c) => {
      const mbid = c.req.param("mbid");
      if (!UUID_REGEX.test(mbid)) return c.json(invalidMbid(mbid), 400);
      const listening = getArtistListening(
        c.var.user.id,
        mbid,
        c.req.valid("query").artistName ?? "",
      );
      c.header("Cache-Control", "private, no-cache");
      return c.json({ listening }, 200);
    },
  );

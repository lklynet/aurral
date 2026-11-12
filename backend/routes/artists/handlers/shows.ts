import { Hono } from "hono";
import * as v from "valibot";
import { UUID_REGEX } from "../../../../lib/uuid.ts";
import { asAppError } from "../../../../lib/errors.ts";
import { requireAuth } from "../../../middleware/guards.ts";
import type { AppEnv } from "../../../middleware/requestUser.ts";
import { validate } from "../../../middleware/validate.ts";
import { getArtistShows } from "../../../services/nearbyShowsService.ts";
import { logger, safeLogDiagnostic } from "../../../services/logger.ts";
import { errorStatus } from "../../shared/errorStatus.ts";
import { invalidMbid, queryText } from "../utils.ts";

export default new Hono<AppEnv>()
  .basePath("/artists")
  .get(
    "/:mbid/shows",
    requireAuth,
    validate("query", v.object({ artistName: queryText })),
    async (c) => {
      const mbid = c.req.param("mbid");
      if (!UUID_REGEX.test(mbid)) return c.json(invalidMbid(mbid), 400);
      try {
        return c.json(
          { shows: await getArtistShows(c.var.user.id, c.req.valid("query").artistName ?? "") },
          200,
        );
      } catch (error) {
        const failure = asAppError(error);
        logger.info("api", "Ticketmaster shows for this artist could not be loaded", {
          reason: safeLogDiagnostic(error),
        });
        return c.json(
          { error: "Failed to load shows", message: failure?.message || "Unknown error" },
          errorStatus(failure),
        );
      }
    },
  );

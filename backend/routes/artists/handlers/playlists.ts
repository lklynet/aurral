import { Hono } from "hono";
import * as v from "valibot";
import { UUID_REGEX } from "../../../../lib/uuid.ts";
import { asAppError } from "../../../../lib/errors.ts";
import type { AppEnv } from "../../../middleware/requestUser.ts";
import { validate } from "../../../middleware/validate.ts";
import { getArtistPlaylists } from "../../../services/discovery/browsePlaylists.ts";
import { logger, safeLogDiagnostic } from "../../../services/logger.ts";
import { errorStatus } from "../../shared/errorStatus.ts";
import { resolveDeezerArtistId } from "../shared/deezerArtist.ts";
import { invalidMbid, queryText } from "../utils.ts";

export default new Hono<AppEnv>()
  .basePath("/artists")
  .get("/:mbid/playlists", validate("query", v.object({ artistName: queryText })), async (c) => {
    const mbid = c.req.param("mbid");
    if (!UUID_REGEX.test(mbid)) return c.json(invalidMbid(mbid), 400);
    const deezerArtistId = await resolveDeezerArtistId(mbid, c.req.valid("query").artistName);
    if (!deezerArtistId) return c.json({ playlists: [] }, 200);
    try {
      return c.json({ playlists: await getArtistPlaylists(deezerArtistId) }, 200);
    } catch (error) {
      const failure = asAppError(error);
      logger.info("api", "Deezer playlists for this artist could not be loaded", {
        reason: safeLogDiagnostic(error),
      });
      return c.json(
        { error: "Failed to load playlists", message: failure?.message || "Unknown error" },
        errorStatus(failure),
      );
    }
  });

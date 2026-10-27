import { Hono } from "hono";
import * as v from "valibot";
import {
  deezerGetArtistTopTracks,
  deezerGetArtistTopTracksById,
} from "../../../services/apiClients/index.ts";
import { dbOps } from "../../../db/helpers/index.ts";
import { UUID_REGEX } from "../../../../lib/uuid.ts";
import { cacheFor } from "../../../middleware/cacheHeaders.ts";
import type { AppEnv } from "../../../middleware/requestUser.ts";
import { validate } from "../../../middleware/validate.ts";
import { getArtistByMbid } from "../../../services/providers/brainzmashProvider.ts";
import { getLinkedDeezerArtistId } from "../../../services/providers/brainzmashMappers.ts";
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

      const override = dbOps.getArtistOverride(mbid);
      let deezerArtistId = override?.deezerArtistId || null;
      if (!deezerArtistId) {
        const metadataArtist = await getArtistByMbid(override?.musicbrainzId || mbid).catch(
          () => null,
        );
        deezerArtistId = getLinkedDeezerArtistId(metadataArtist?.links);
      }

      if (deezerArtistId) {
        return c.json({ tracks: await deezerGetArtistTopTracksById(deezerArtistId) }, 200);
      }
      const { artistName } = c.req.valid("query");
      if (!artistName) return c.json({ tracks: [] }, 200);
      const normalized = artistName.replace(/\([^()]*\)$/, "").trim() || artistName;
      return c.json({ tracks: await deezerGetArtistTopTracks(normalized) }, 200);
    },
  );

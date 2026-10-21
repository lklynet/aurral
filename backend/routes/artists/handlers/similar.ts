import type { Request, Router } from "express";
import { musicbrainzGetArtistNameByMbid } from "../../../services/apiClients/index.ts";
import { dbOps } from "../../../db/helpers/index.ts";
import { getSimilarArtistCards } from "../shared/transform.ts";
import { UUID_REGEX } from "../../../../lib/uuid.ts";
import { cacheMiddleware } from "../../../middleware/cache.ts";

type MbidRequest = Request<{ mbid: string }>;

export type SimilarArtistsResponse = {
  artists: Awaited<ReturnType<typeof getSimilarArtistCards>>;
};

export function registerSimilar(router: Router) {
  router.get("/:mbid/similar", cacheMiddleware(300), async (req: MbidRequest, res) => {
    const { mbid } = req.params;

    if (!UUID_REGEX.test(mbid)) {
      return res.status(400).json({
        error: "Invalid MBID format",
        message: `"${mbid}" is not a valid MusicBrainz ID. MBIDs must be UUIDs.`,
      });
    }

    const { limit = 10 } = req.query;
    const limitInt = Math.min(Math.max(parseInt(String(limit), 10) || 7, 1), 20);
    const override = dbOps.getArtistOverride(mbid);
    const resolvedMbid = override?.musicbrainzId || mbid;
    const artists = await getSimilarArtistCards(resolvedMbid, {
      artistName: String(req.query.artistName || "").trim(),
      limit: limitInt,
      resolveArtistName: () => musicbrainzGetArtistNameByMbid(resolvedMbid),
    });
    res.json({ artists });
  });
}

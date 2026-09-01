import {
  getLastfmApiKey,
  lastfmRequest,
  musicbrainzGetArtistNameByMbid,
} from "../../../services/apiClients/index.js";
import { dbOps } from "../../../db/helpers/index.js";
import { buildImageProxyUrl } from "../../../services/imageProxyService.js";
import { extractLastfmImageUrl } from "../shared/transform.js";
import { UUID_REGEX } from "../../../../lib/uuid.js";
import { cacheMiddleware } from "../../../middleware/cache.js";

export function registerSimilar(router) {
  router.get("/:mbid/similar", cacheMiddleware(300), async (req, res) => {
    const { mbid } = req.params;

    if (!UUID_REGEX.test(mbid)) {
      return res.status(400).json({
        error: "Invalid MBID format",
        message: `"${mbid}" is not a valid MusicBrainz ID. MBIDs must be UUIDs.`,
      });
    }

    const { limit = 10 } = req.query;
    const artistNameParam = String(req.query.artistName || "").trim();

    if (!getLastfmApiKey()) {
      return res.json({ artists: [], provider: "none", requiresLastfm: true });
    }

    const limitInt = Math.min(Math.max(parseInt(limit, 10) || 7, 1), 20);
    const override = dbOps.getArtistOverride(mbid);
    const resolvedMbid = override?.musicbrainzId || mbid;
    let data = await lastfmRequest("artist.getSimilar", {
      mbid: resolvedMbid,
      limit: limitInt,
    });

    if (!data?.similarartists?.artist) {
      const fallbackArtistName =
        artistNameParam ||
        (await musicbrainzGetArtistNameByMbid(resolvedMbid).catch(() => null)) ||
        "";

      if (fallbackArtistName) {
        data = await lastfmRequest("artist.getSimilar", {
          artist: fallbackArtistName,
          limit: limitInt,
        });
      }
    }

    if (!data?.similarartists?.artist) {
      return res.json({ artists: [] });
    }

    const artists = Array.isArray(data.similarartists.artist)
      ? data.similarartists.artist
      : [data.similarartists.artist];

    const formattedArtists = artists
      .map((a) => {
        const img = extractLastfmImageUrl(a.image);
        return {
          id: a.mbid,
          name: a.name,
          image: buildImageProxyUrl(img),
          match: Math.round((a.match || 0) * 100),
        };
      })
      .filter((a) => a.id);

    res.json({ artists: formattedArtists });
  });
}

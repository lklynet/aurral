import {
  deezerGetArtistTopTracks,
  deezerGetArtistTopTracksById,
} from "../../../services/apiClients/index.ts";
import { dbOps } from "../../../db/helpers/index.ts";
import { UUID_REGEX } from "../../../../lib/uuid.ts";
import { cacheMiddleware } from "../../../middleware/cache.ts";
import { getArtistByMbid } from "../../../services/providers/brainzmashProvider.ts";
import { getLinkedDeezerArtistId } from "../../../services/providers/brainzmashMappers.ts";

export function registerPreview(router) {
  router.get("/:mbid/preview", cacheMiddleware(60), async (req, res) => {
    const { mbid } = req.params;

    if (!UUID_REGEX.test(mbid)) {
      return res.status(400).json({
        error: "Invalid MBID format",
        message: `"${mbid}" is not a valid MusicBrainz ID. MBIDs must be UUIDs.`,
      });
    }

    const artistNameParam = (req.query.artistName || "").trim();
    const override = dbOps.getArtistOverride(mbid);
    let deezerArtistId = override?.deezerArtistId || null;
    if (!deezerArtistId) {
      const metadataArtist = await getArtistByMbid(override?.musicbrainzId || mbid).catch(
        () => null,
      );
      deezerArtistId = getLinkedDeezerArtistId(metadataArtist?.links);
    }

    if (deezerArtistId) {
      const tracks = await deezerGetArtistTopTracksById(deezerArtistId);
      return res.json({ tracks });
    }
    const artistName = artistNameParam || null;
    if (!artistName) {
      return res.json({ tracks: [] });
    }
    const normalized = artistName.replace(/\s*\([^)]*\)\s*$/, "").trim() || artistName;
    const tracks = await deezerGetArtistTopTracks(normalized);
    res.json({ tracks });
  });
}

import { getDeezerArtist } from "../../../services/apiClients/index.ts";
import { dbOps } from "../../../db/helpers/index.ts";
import { getArtistByMbid } from "../../../services/providers/brainzmashProvider.ts";
import { getLinkedDeezerArtistId } from "../../../services/providers/brainzmashMappers.ts";

export async function resolveDeezerArtistId(mbid: string, artistName: string) {
  const override = dbOps.getArtistOverride(mbid);
  if (override?.deezerArtistId) return String(override.deezerArtistId);
  const metadataArtist = await getArtistByMbid(override?.musicbrainzId || mbid).catch(() => null);
  const linked = getLinkedDeezerArtistId(metadataArtist?.links);
  if (linked) return linked;
  if (!artistName) return null;
  const name = artistName.replace(/\([^()]*\)$/, "").trim() || artistName;
  const artist = await getDeezerArtist(name);
  return artist ? String(artist.id) : null;
}

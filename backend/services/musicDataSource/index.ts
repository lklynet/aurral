import { deezerGetArtistTopTrackList } from "../apiClients/index.ts";
import { getCachedArtistByMbid } from "../providers/brainzmashProvider.ts";
import { getLinkedDeezerArtistId } from "../providers/brainzmashMappers.ts";
import { normalizeMbid, text } from "./common.ts";
import { listenbrainzSource } from "./listenbrainz.ts";

export type MusicArtistRef = { name?: string | null; mbid?: string | number | null };

export const MUSIC_DATA_SOURCE = listenbrainzSource.name;

export const { getSimilarArtists, getArtistTagLists, getTagArtists } = listenbrainzSource;

export const getArtistTopTracks = async (
  artist: MusicArtistRef,
  { limit = 25 }: { limit?: number } = {},
) => {
  const name = text(artist?.name);
  if (!name) return [];
  const mbid = normalizeMbid(artist?.mbid);
  const known = mbid ? await getCachedArtistByMbid(mbid).catch(() => null) : null;
  const deezerArtistId = getLinkedDeezerArtistId(known?.links);
  return deezerGetArtistTopTrackList(name, { limit, deezerArtistId }).catch(() => []);
};

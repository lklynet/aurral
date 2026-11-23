import { deezerGetArtistTopTrackList } from "../apiClients/index.ts";
import { getArtistByMbid } from "../providers/metadataProvider.ts";
import { getLinkedDeezerArtistId } from "../providers/metadataMappers.ts";
import { normalizeMbid, text } from "./common.ts";
import { listenbrainzSource } from "./listenbrainz.ts";

export type MusicArtistRef = { name?: string | null; mbid?: string | number | null };

export const MUSIC_DATA_SOURCE = listenbrainzSource.name;

export const { getSimilarArtists, getArtistTagLists, getTagArtists } = listenbrainzSource;

export const getArtistTopTracks = async (
  artist: MusicArtistRef,
  { limit = 25 }: { limit?: number } = {},
) => {
  const mbid = normalizeMbid(artist?.mbid);
  const known = mbid ? await getArtistByMbid(mbid).catch(() => null) : null;
  if (known?.topTracks.length) {
    const albumsById = new Map(known.albums.map((album) => [album.id, album.title]));
    return known.topTracks.slice(0, limit).map((track) => ({
      name: track.title,
      albumName: (track.albumId && albumsById.get(track.albumId)) || null,
      albumMbid: track.albumId || null,
      mbid: track.recordingId || null,
      durationMs: track.durationMs,
      popularity: track.listeners,
    }));
  }
  const name = text(artist?.name) || text(known?.name);
  if (!name) return [];
  const deezerArtistId = getLinkedDeezerArtistId(known?.links);
  return deezerGetArtistTopTrackList(name, { limit, deezerArtistId }).catch(() => []);
};

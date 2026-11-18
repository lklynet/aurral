import {
  deezerGetArtistTopTrackList,
  getLastfmApiKey,
  isLastfmKeyRejected,
} from "../apiClients/index.ts";
import { getCachedArtistByMbid } from "../providers/brainzmashProvider.ts";
import { getLinkedDeezerArtistId } from "../providers/brainzmashMappers.ts";
import { normalizeMbid, text } from "./common.ts";
import { lastfmSource } from "./lastfm.ts";
import { listenbrainzSource } from "./listenbrainz.ts";

export type MusicArtistRef = { name?: string | null; mbid?: string | number | null };

type LastfmSource = typeof lastfmSource;
type SourceMethod = Exclude<keyof LastfmSource, "name">;
type SourceArg<M extends SourceMethod, I extends number> = LastfmSource[M] extends (
  ...args: infer A extends unknown[]
) => unknown
  ? A[I]
  : never;

const activeSource = () =>
  getLastfmApiKey() && !isLastfmKeyRejected() ? lastfmSource : listenbrainzSource;

export const getMusicDataSourceName = () => activeSource().name;

export const getSimilarArtists = (
  artist: MusicArtistRef,
  options: SourceArg<"getSimilarArtists", 1>,
) => activeSource().getSimilarArtists(artist, options);

export const getArtistTagLists = (
  artists: MusicArtistRef[],
  options?: SourceArg<"getArtistTagLists", 1>,
) => activeSource().getArtistTagLists(artists, options);

export const getTagArtists = (tag: string, options: SourceArg<"getTagArtists", 1>) =>
  activeSource().getTagArtists(tag, options);

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

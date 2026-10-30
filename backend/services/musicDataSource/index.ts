import { getLastfmApiKey } from "../apiClients/index.ts";
import { lastfmSource } from "./lastfm.ts";
import { listenbrainzSource } from "./listenbrainz.ts";

export const MUSIC_DATA_SOURCE_LASTFM = lastfmSource.name;
export const MUSIC_DATA_SOURCE_LISTENBRAINZ = listenbrainzSource.name;

export type MusicArtistRef = { name?: string | null; mbid?: string | number | null };

export type MusicTrendingArtist = {
  id: string | null;
  name: string;
  image: string | null;
  type: string;
  popularityLabel: string;
  listeners: number;
  playcount: number;
  popularityRank: number | null;
};

type LastfmSource = typeof lastfmSource;
type SourceMethod = Exclude<keyof LastfmSource, "name">;
type SourceArg<M extends SourceMethod, I extends number> = LastfmSource[M] extends (
  ...args: infer A extends unknown[]
) => unknown
  ? A[I]
  : never;

const activeSource = () => (getLastfmApiKey() ? lastfmSource : listenbrainzSource);

export const getMusicDataSourceName = () => activeSource().name;

export const getSimilarArtists = (
  artist: MusicArtistRef,
  options: SourceArg<"getSimilarArtists", 1>,
) => activeSource().getSimilarArtists(artist, options);

export const getArtistTagLists = (
  artists: MusicArtistRef[],
  options?: SourceArg<"getArtistTagLists", 1>,
) => activeSource().getArtistTagLists(artists, options);

export const getArtistTopTracks = (
  artist: MusicArtistRef,
  options: SourceArg<"getArtistTopTracks", 1>,
) => activeSource().getArtistTopTracks(artist, options);

export const getTagArtists = (tag: string, options: SourceArg<"getTagArtists", 1>) =>
  activeSource().getTagArtists(tag, options);

export const getTrendingArtists = (options: SourceArg<"getTrendingArtists", 0>) =>
  activeSource().getTrendingArtists(options);

export const getTrendingTracks = (options: SourceArg<"getTrendingTracks", 0>) =>
  activeSource().getTrendingTracks(options);

export const getPopularTags = () => activeSource().getPopularTags();

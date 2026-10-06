import { getLastfmApiKey } from "../apiClients/index.js";
import { lastfmSource } from "./lastfm.js";
import { listenbrainzSource } from "./listenbrainz.js";

export const MUSIC_DATA_SOURCE_LASTFM = lastfmSource.name;
export const MUSIC_DATA_SOURCE_LISTENBRAINZ = listenbrainzSource.name;

const activeSource = () => (getLastfmApiKey() ? lastfmSource : listenbrainzSource);

export const getMusicDataSourceName = () => activeSource().name;

export const getSimilarArtists = (artist, options) =>
  activeSource().getSimilarArtists(artist, options);

export const getArtistTagLists = (artists, options) =>
  activeSource().getArtistTagLists(artists, options);

export const getArtistTopTracks = (artist, options) =>
  activeSource().getArtistTopTracks(artist, options);

export const getTagArtists = (tag, options) => activeSource().getTagArtists(tag, options);

export const getTagTracks = (tag, options) => activeSource().getTagTracks(tag, options);

export const getTrendingArtists = (options) => activeSource().getTrendingArtists(options);

export const getTrendingTracks = (options) => activeSource().getTrendingTracks(options);

export const getPopularTags = () => activeSource().getPopularTags();

import { lastfmCache } from "./lastfm.js";
import { listenbrainzCache } from "./listenbrainz.js";
import { deezerArtistCache } from "./deezer.js";
import {
  musicbrainzArtistIdentityCache,
  musicbrainzArtistNameCache,
  musicbrainzReleaseGroupsCache,
} from "./musicbrainz.js";
import {
  deezerAlbumCache,
  deezerAlbumTrackCache,
  deezerPreviewMatchCache,
  deezerTopTrackCache,
} from "./deezer.js";
import { youtubeVideoCache } from "./crossProvider.js";
import { newsCache } from "./newsapi.js";
import { clearMetadataProviderCaches } from "../providers/brainzmashProvider.js";

export function clearApiCaches() {
  clearMetadataProviderCaches();
  lastfmCache.flushAll();
  listenbrainzCache.flushAll();
  deezerArtistCache.flushAll();
  musicbrainzArtistNameCache.flushAll();
  musicbrainzArtistIdentityCache.flushAll();
  musicbrainzReleaseGroupsCache.flushAll();
  deezerAlbumCache.flushAll();
  deezerAlbumTrackCache.flushAll();
  deezerPreviewMatchCache.flushAll();
  deezerTopTrackCache.flushAll();
  youtubeVideoCache.flushAll();
  newsCache.flushAll();
}

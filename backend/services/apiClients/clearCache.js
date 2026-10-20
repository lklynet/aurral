import { lastfmCache } from "./lastfm.js";
import { listenbrainzCache, listenbrainzLookupCache } from "./listenbrainz.js";
import { deezerArtistCache } from "./deezer.js";
import {
  musicbrainzArtistNameCache,
  musicbrainzReleaseGroupsCache,
  musicbrainzTagArtistsCache,
} from "./musicbrainz.js";
import {
  deezerAlbumCache,
  deezerAlbumTrackCache,
  deezerPreviewMatchCache,
  deezerTopTrackCache,
} from "./deezer.js";
import { youtubeVideoCache } from "./youtube.js";
import { clearMetadataProviderCaches } from "../providers/brainzmashProvider.js";
import { clearReleaseManifests } from "../releaseResolver.js";

export function clearApiCaches() {
  clearMetadataProviderCaches();
  clearReleaseManifests();
  lastfmCache.flushAll();
  listenbrainzCache.flushAll();
  listenbrainzLookupCache.flushAll();
  deezerArtistCache.flushAll();
  musicbrainzArtistNameCache.flushAll();
  musicbrainzReleaseGroupsCache.flushAll();
  musicbrainzTagArtistsCache.flushAll();
  deezerAlbumCache.flushAll();
  deezerAlbumTrackCache.flushAll();
  deezerPreviewMatchCache.flushAll();
  deezerTopTrackCache.flushAll();
  youtubeVideoCache.flushAll();
}

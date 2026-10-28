import { lastfmCache } from "./lastfm.ts";
import { listenbrainzCache, listenbrainzLookupCache } from "./listenbrainz.ts";
import { deezerArtistCache } from "./deezer.ts";
import {
  musicbrainzArtistNameCache,
  musicbrainzReleaseGroupsCache,
  musicbrainzTagArtistsCache,
} from "./musicbrainz.ts";
import {
  deezerAlbumCache,
  deezerAlbumTrackCache,
  deezerPreviewMatchCache,
  deezerTopTrackCache,
} from "./deezer.ts";
import { youtubeVideoCache } from "./youtube.ts";
import { lrclibCache } from "./lrclib.ts";
import { clearMetadataProviderCaches } from "../providers/brainzmashProvider.ts";
import { clearReleaseManifests } from "../releaseResolver.ts";

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
  lrclibCache.flushAll();
}

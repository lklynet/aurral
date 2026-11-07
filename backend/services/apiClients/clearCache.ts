import { lastfmCache } from "./lastfm.ts";
import {
  listenbrainzCache,
  listenbrainzDatesCache,
  listenbrainzListensCache,
} from "./listenbrainz.ts";
import { clearDeezerCaches } from "./deezer.ts";
import {
  musicbrainzArtistNameCache,
  musicbrainzReleaseCreditsCache,
  musicbrainzReleaseGroupsCache,
  musicbrainzTagArtistsCache,
} from "./musicbrainz.ts";
import { youtubeVideoCache } from "./youtube.ts";
import { lrclibCache } from "./lrclib.ts";
import { clearMetadataProviderCaches } from "../providers/brainzmashProvider.ts";
import { clearReleaseManifests } from "../releaseResolver.ts";

export function clearApiCaches() {
  clearMetadataProviderCaches();
  clearReleaseManifests();
  lastfmCache.flushAll();
  listenbrainzCache.flushAll();
  listenbrainzDatesCache.flushAll();
  listenbrainzListensCache.flushAll();
  clearDeezerCaches();
  musicbrainzArtistNameCache.flushAll();
  musicbrainzReleaseCreditsCache.flushAll();
  musicbrainzReleaseGroupsCache.flushAll();
  musicbrainzTagArtistsCache.flushAll();
  youtubeVideoCache.flushAll();
  lrclibCache.flushAll();
}

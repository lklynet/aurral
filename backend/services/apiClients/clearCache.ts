import { lastfmCache } from "./lastfm.ts";
import { clearListenbrainzStats, listenbrainzCache } from "./listenbrainz.ts";
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
import { resumePausedServices } from "./outagePause.ts";

export function clearApiCaches() {
  clearMetadataProviderCaches();
  clearReleaseManifests();
  lastfmCache.flushAll();
  listenbrainzCache.flushAll();
  clearListenbrainzStats();
  clearDeezerCaches();
  musicbrainzArtistNameCache.flushAll();
  musicbrainzReleaseCreditsCache.flushAll();
  musicbrainzReleaseGroupsCache.flushAll();
  musicbrainzTagArtistsCache.flushAll();
  youtubeVideoCache.flushAll();
  lrclibCache.flushAll();
  resumePausedServices();
}

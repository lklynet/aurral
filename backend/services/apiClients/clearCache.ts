import { listenbrainzCache } from "./listenbrainz.ts";
import { clearDeezerCaches } from "./deezer.ts";
import { musicbrainzArtistNameCache, musicbrainzTagArtistsCache } from "./musicbrainz.ts";
import { youtubeVideoCache } from "./youtube.ts";
import { lrclibCache } from "./lrclib.ts";
import { clearMetadataProviderCaches } from "../providers/metadataProvider.ts";
import { clearReleaseManifests } from "../releaseResolver.ts";
import { resumePausedServices } from "./outagePause.ts";

export function clearApiCaches() {
  clearMetadataProviderCaches();
  clearReleaseManifests();
  listenbrainzCache.flushAll();
  clearDeezerCaches();
  musicbrainzArtistNameCache.flushAll();
  musicbrainzTagArtistsCache.flushAll();
  youtubeVideoCache.flushAll();
  lrclibCache.flushAll();
  resumePausedServices();
}

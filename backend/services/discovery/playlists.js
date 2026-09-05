import { dbOps } from "../../db/helpers/index.js";
import { getLastfmApiKey } from "../apiClients/index.js";
import { getCanonicalArtistKeys } from "../libraryQueryService.js";
import { logger } from "../logger.js";
import { buildExistingArtistKeySet } from "./recommendationPipeline.js";
import { websocketService } from "../websocketService.js";
import { withHonkerLock } from "../honkerDb.js";
import {
  getDiscoveryCache,
  getDiscoveryPlaylistBuildToken,
  clearDiscoveryPlaylistBuildToken,
  getDiscoveryPlaylistBuildKey,
  recordDiscoverPlaylistBuildProgress,
  clearDiscoverPlaylistBuildProgress,
  discoveryCache,
} from "./persistence.js";
import { normalizePlaylistBuildStringList } from "./helpers.js";

const buildDiscoveryUpdatePayload = (
  discoveryData,
  {
    phase = "completed",
    progress = 100,
    progressMessage = "Discovery refresh completed",
  } = {},
) => {
  if (phase === "playlists_completed") {
    clearDiscoverPlaylistBuildProgress();
  }
  return {
    recommendations: discoveryData.recommendations || [],
    globalTop: discoveryData.globalTop || [],
    basedOn: discoveryData.basedOn || [],
    topTags: discoveryData.topTags || [],
    topGenres: discoveryData.topGenres || [],
    fallbackGenres: discoveryData.fallbackGenres || [],
    discoverPlaylists: discoveryData.discoverPlaylists || [],
    lastUpdated: discoveryData.lastUpdated,
    isUpdating: false,
    configured: true,
    phase,
    progress,
    progressMessage,
    ...(phase === "playlists_completed"
      ? { playlistsUpdating: false, playlistsUpdateMessage: null }
      : {}),
  };
};

const emitDiscoveryUpdateLocal = (discoveryData, options = {}) => {
  websocketService.emitDiscoveryUpdate(
    buildDiscoveryUpdatePayload(discoveryData, options),
  );
};

export const runQueuedDiscoverPlaylistBuild = async (payload = {}) => {
  const cacheNamespace = String(payload?.cacheNamespace || "").trim() || null;
  const buildKey = getDiscoveryPlaylistBuildKey(cacheNamespace);
  const buildToken = String(payload?.buildToken || "").trim();
  const activeToken = getDiscoveryPlaylistBuildToken(buildKey);
  if (activeToken && buildToken && activeToken !== buildToken) {
    return { skipped: true, reason: "stale_build" };
  }
  if (!getLastfmApiKey()) {
    return { skipped: true, reason: "lastfm_not_configured" };
  }

  return withHonkerLock(
    `discovery-playlist-build:${buildKey}`,
    async () => {
      const lockedToken = getDiscoveryPlaylistBuildToken(buildKey);
      if (lockedToken && buildToken && lockedToken !== buildToken) {
        return { skipped: true, reason: "stale_build" };
      }
      try {
        const baseDiscoveryData = getDiscoveryCache(cacheNamespace);
        if (
          baseDiscoveryData.recommendations.length === 0 &&
          baseDiscoveryData.globalTop.length === 0
        ) {
          return { skipped: true, reason: "empty_discovery_data" };
        }

        if (payload?.publishUpdate !== false) {
          recordDiscoverPlaylistBuildProgress("Building recommended playlists...");
        }

        const allLibraryArtists = getCanonicalArtistKeys();
        const existingArtistKeys = buildExistingArtistKeySet(allLibraryArtists);
        const { generateDiscoverPlaylists } =
          await import("./playlistBuilder.js");
        const discoverPlaylists = await generateDiscoverPlaylists({
          listenHistoryProfile: payload?.listenHistoryProfile || null,
          discoveryCache: baseDiscoveryData,
          basedOn: baseDiscoveryData.basedOn,
          topGenres: baseDiscoveryData.topGenres,
          topTags: baseDiscoveryData.topTags,
          recommendations: baseDiscoveryData.recommendations,
          globalTop: baseDiscoveryData.globalTop,
          libraryArtists: allLibraryArtists,
          libraryArtistKeys: existingArtistKeys,
          historyTopArtists: normalizePlaylistBuildStringList(
            payload?.historyTopArtists,
            3,
          ),
        });

        const currentToken = getDiscoveryPlaylistBuildToken(buildKey);
        if (currentToken && buildToken && currentToken !== buildToken) {
          return { skipped: true, reason: "stale_build" };
        }

        discoveryCache.discoverPlaylists = discoverPlaylists;
        dbOps.updateDiscoveryCache(
          { discoverPlaylists },
          cacheNamespace,
        );

        if (payload?.publishUpdate !== false) {
          emitDiscoveryUpdateLocal(
            {
              ...baseDiscoveryData,
              discoverPlaylists: discoveryCache.discoverPlaylists,
            },
            {
              phase: "playlists_completed",
              progressMessage: "Discover playlists updated",
            },
          );
        }
        logger.info('discovery', `Discover playlists built: ${discoverPlaylists.length} playlists.`);
        return { built: true, playlistCount: discoverPlaylists.length };
      } finally {
        clearDiscoveryPlaylistBuildToken(buildKey, buildToken);
      }
    },
    {
      ttlSeconds: 300,
      waitTimeoutMs: 30 * 60 * 1000,
      retryDelayMs: 500,
    },
  );
};

export const emitDiscoverPlaylistBuildFailure = (payload = {}, error) => {
  if (payload?.publishUpdate === false) return;
  const message = error?.message || String(error || "Unknown error");
  clearDiscoverPlaylistBuildProgress();
  websocketService.emitDiscoveryUpdate({
    isUpdating: false,
    playlistsUpdating: false,
    playlistsUpdateMessage: null,
    configured: true,
    phase: "playlists_error",
    progress: 100,
    progressMessage: "Discover playlists failed to update",
    error: message,
  });
};

import { userOps } from "../../db/helpers/index.js";
import { randomUUID } from "crypto";
import { getLastfmApiKey } from "../apiClients/index.js";
import {
  buildFlowPayloadFromPreset,
  enrichDiscoverPlaylistForAdoption,
  getCachedDiscoverPlaylist,
  serializeTrack,
} from "./playlistBuilder.js";
import { getDiscoveryCache } from "./index.js";
import {
  getListenHistoryCacheNamespace,
  getListenHistoryProfile,
} from "../listeningHistory.js";
import { flowPlaylistConfig } from "../weeklyFlow/weeklyFlowPlaylistConfig.js";
import { weeklyFlowOperationQueue } from "../weeklyFlow/weeklyFlowOperationQueue.js";
import { playlistManager } from "../weeklyFlow/weeklyFlowPlaylistManager.js";
const resolveDiscoverAdoptContext = (user, presetId) => {
  const reqUser = userOps.getUserById(user?.id);
  const listenHistoryProfile = getListenHistoryProfile(reqUser || user || {});
  const userCacheNamespace = getListenHistoryCacheNamespace(listenHistoryProfile);
  const effectiveCacheNamespace = getLastfmApiKey() ? userCacheNamespace : null;
  const discoveryCache = getDiscoveryCache(effectiveCacheNamespace);
  let cachedPlaylist = getCachedDiscoverPlaylist(discoveryCache, presetId);
  if (!cachedPlaylist && effectiveCacheNamespace) {
    cachedPlaylist = getCachedDiscoverPlaylist(getDiscoveryCache(), presetId);
  }
  return { cachedPlaylist };
};

export async function adoptDiscoverPresetAsFlow(user, presetId) {
  const safePresetId = String(presetId || "").trim();
  if (!safePresetId) {
    throw Object.assign(new Error("presetId is required"), { statusCode: 400 });
  }

  const existingFlow = flowPlaylistConfig
    .getFlowsOwnedByUser(user.id)
    .find((flow) => flow.discoverPresetId === safePresetId);
  if (existingFlow) {
    return {
      success: true,
      flowId: existingFlow.id,
      flow: existingFlow,
      alreadyAdopted: true,
    };
  }

  const { cachedPlaylist } = resolveDiscoverAdoptContext(user, safePresetId);
  if (!cachedPlaylist || cachedPlaylist.trackCount <= 0) {
    throw Object.assign(new Error("Run discovery refresh to generate this playlist first"), {
      statusCode: 404,
      error: "Playlist preview not available",
    });
  }

  const enrichedPlaylist = await enrichDiscoverPlaylistForAdoption(cachedPlaylist);
  const flow = flowPlaylistConfig.createFlow({
    ...buildFlowPayloadFromPreset(enrichedPlaylist, safePresetId),
    ownerUserId: user.id,
  });
  await playlistManager.ensureSmartPlaylists();
  flowPlaylistConfig.setEnabled(flow.id, true);
  flowPlaylistConfig.scheduleNextRun(flow.id);

  import("../../services/unifiedSearchService.js").then(({ clearSearchContextCache }) => clearSearchContextCache()).catch(() => {});

  const tracks = (enrichedPlaylist.tracks || []).map(serializeTrack);
  const result = await weeklyFlowOperationQueue.enqueuePayload({
    kind: "adopt-flow-seed",
    label: `adopt:${flow.id}`,
    flowId: flow.id,
    tracks,
  });

  return {
    success: true,
    flowId: flow.id,
    flow,
    tracksQueued: Number(result?.tracksQueued || 0),
    queued: result?.queued === true,
    alreadyAdopted: false,
  };
}

export async function adoptDiscoverPresetAsPlaylist(user, presetId) {
  const safePresetId = String(presetId || "").trim();
  if (!safePresetId) {
    throw Object.assign(new Error("presetId is required"), { statusCode: 400 });
  }

  const existingPlaylist = flowPlaylistConfig
    .getSharedPlaylistsOwnedByUser(user.id)
    .find((playlist) => playlist.discoverPresetId === safePresetId);
  if (existingPlaylist) {
    return {
      success: true,
      playlistId: existingPlaylist.id,
      playlist: existingPlaylist,
      alreadyAdopted: true,
    };
  }

  const { cachedPlaylist } = resolveDiscoverAdoptContext(user, safePresetId);
  if (!cachedPlaylist || cachedPlaylist.trackCount <= 0) {
    throw Object.assign(new Error("Run discovery refresh to generate this playlist first"), {
      statusCode: 404,
      error: "Playlist preview not available",
    });
  }

  const enrichedPlaylist = await enrichDiscoverPlaylistForAdoption(cachedPlaylist);
  const tracks = (enrichedPlaylist.tracks || []).map(serializeTrack);
  const playlistId = randomUUID();
  const result = await weeklyFlowOperationQueue.enqueuePayload({
    kind: "shared-playlist-create",
    label: `adopt-playlist:${safePresetId}`,
    playlistId,
    name: cachedPlaylist.name,
    sourceName: cachedPlaylist.name,
    description: cachedPlaylist.description || null,
    tracks,
    ownerUserId: user.id,
    discoverPresetId: safePresetId,
    type: cachedPlaylist.type === "editorial" ? "editorial" : null,
  });
  const playlist = result?.playlist || null;

  return {
    success: true,
    playlistId: playlist?.id || playlistId,
    playlist,
    tracksQueued: Number(result?.tracksQueued || 0),
    tracksReused: Number(result?.tracksReused || 0),
    queued: result?.queued === true,
    alreadyAdopted: false,
  };
}

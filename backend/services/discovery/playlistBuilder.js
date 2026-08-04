import { getLastfmApiKey } from "../apiClients/index.js";
import { getDiscoveryCache, isDiscoveryPersonalizedEnabled } from "./index.js";
import { playlistSource } from "../weeklyFlow/weeklyFlowPlaylistSource.js";
import { flowPlaylistConfig } from "../weeklyFlow/weeklyFlowPlaylistConfig.js";
import {
  DISCOVER_PLAYLIST_PRESETS,
  RELEASE_RADAR_PRESET,
  FIXED_DISCOVER_PLAYLIST_ARTWORK_COLORS,
} from "../../config/discoverPlaylistPresets.js";
import { generateEditorialPlaylists, enrichTracksWithAlbums } from "./editorialPlaylistBuilder.js";
import { enrichPlaylistTracksForAdoption } from "./playlistAdoptionEnrichment.js";

const PLAYLIST_BUILD_CONCURRENCY = Math.max(
  1,
  Math.min(6, Math.floor(Number(process.env.AURRAL_DISCOVERY_PLAYLIST_BUILD_CONCURRENCY) || 3)),
);

const serializeTrack = (track) => ({
  artistName: track?.artistName || null,
  trackName: track?.trackName || null,
  albumName: track?.albumName || null,
  artistMbid: track?.artistMbid || null,
  albumMbid: track?.albumMbid || null,
  trackMbid: track?.trackMbid || null,
  releaseYear: track?.releaseYear || null,
  reason: track?.reason || null,
});

const uniqueStrings = (values, limit = 10) => {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const text = String(value || "").trim();
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
};

const buildPlaylistPreview = (preset, tracks, plan = null) => {
  const tags = uniqueStrings(preset.tags || []);
  const relatedArtists = uniqueStrings(preset.relatedArtists || []);
  const recipe =
    preset.id === RELEASE_RADAR_PRESET.id
      ? { releaseRadar: tracks.length }
      : plan?.diagnostics?.targets || {
          discover: 0,
          mix: 0,
          trending: 0,
          focus: 0,
        };
  return {
    presetId: preset.id,
    name: preset.name,
    description: preset.description || null,
    type: preset.type || (preset.id === RELEASE_RADAR_PRESET.id ? "release_radar" : "flow"),
    mix: preset.mix || { discover: 0, mix: 0, trending: 0, focus: 0 },
    size: Math.max(1, Math.round(Number(preset.size) || 30)),
    deepDive: preset.deepDive === true,
    tags,
    relatedArtists,
    recipe,
    tracks: tracks.map(serializeTrack),
    trackCount: tracks.length,
    artworkColor: FIXED_DISCOVER_PLAYLIST_ARTWORK_COLORS[preset.id] || null,
  };
};

const buildFlowConfigFromPreset = (preset) => ({
  name: preset.name,
  mix: preset.mix,
  size: preset.size,
  deepDive: preset.deepDive === true,
  tags: preset.tags || [],
  relatedArtists: preset.relatedArtists || [],
});

async function buildPlaylistFromPreset(preset, options = {}) {
  const { listenHistoryProfile = null, plannerOptions = {} } = options;
  const flow = buildFlowConfigFromPreset(preset);
  const plan = await playlistSource.buildFlowRunPlan(flow, {
    ...plannerOptions,
    listenHistoryProfile,
  });
  const tracks = Array.isArray(plan?.primaryTracks) ? plan.primaryTracks : [];
  if (tracks.length === 0) return null;
  return buildPlaylistPreview(preset, tracks, plan);
}

async function buildPlaylistsFromPresets(presets, options, onProgress) {
  const playlists = [];
  const items = Array.isArray(presets) ? presets : [];
  const totalSteps = items.length + 1;
  let completed = 0;
  for (let index = 0; index < items.length; index += PLAYLIST_BUILD_CONCURRENCY) {
    const batch = items.slice(index, index + PLAYLIST_BUILD_CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async (preset) => {
        try {
          return await buildPlaylistFromPreset(preset, options);
        } catch (error) {
          console.warn(`[DiscoverPlaylists] Failed to build ${preset.id}: ${error.message}`);
          return null;
        }
      }),
    );
    playlists.push(...batchResults.filter(Boolean));
    completed = Math.min(items.length, index + batch.length);
    onProgress?.({ completed, total: totalSteps });
  }
  return { playlists, totalSteps, completedBeforeReleaseRadar: completed };
}

async function buildReleaseRadarPlaylist(options = {}) {
  const { listenHistoryProfile = null, basedOn = [], libraryArtists = null } = options;
  try {
    const tracks = await playlistSource.getReleaseRadarTracks(RELEASE_RADAR_PRESET.size, {
      listenHistoryProfile,
      basedOn,
      libraryArtists,
    });
    if (tracks.length > 0) {
      return buildPlaylistPreview(RELEASE_RADAR_PRESET, tracks);
    }
  } catch (error) {
    console.warn(`[DiscoverPlaylists] Release radar failed: ${error.message}`);
  }
  return null;
}

const resolveListeningHistoryPreset = ({ basedOn = [], historyTopArtists = [] }) => {
  const explicit = uniqueStrings(historyTopArtists, 3);
  if (explicit.length >= 3) return explicit;
  const fromBasedOn = uniqueStrings(
    basedOn
      .filter((entry) => {
        const source = String(entry?.source || "").trim().toLowerCase();
        return source.length > 0 && source !== "library";
      })
      .map((entry) => entry?.name || entry?.artistName),
    3,
  );
  return uniqueStrings([...explicit, ...fromBasedOn], 3);
};

export async function enrichDiscoverPlaylistForAdoption(
  playlist,
  { enrichTracks = enrichTracksWithAlbums } = {},
) {
  return enrichPlaylistTracksForAdoption(playlist, enrichTracks);
}

export async function generateDiscoverPlaylists({
  listenHistoryProfile = null,
  basedOn = [],
  topGenres = [],
  topTags = [],
  recommendations = [],
  globalTop = [],
  libraryArtists = null,
  libraryArtistKeys = null,
  discoveryCache = null,
  historyTopArtists = [],
  onProgress,
} = {}) {
  if (!getLastfmApiKey()) return [];

  const historyArtists = resolveListeningHistoryPreset({ basedOn, historyTopArtists });

  const personalizedEnabled = isDiscoveryPersonalizedEnabled();
  let presetPlaylists = [];
  let totalSteps = 0;

  if (personalizedEnabled) {
    const tastePresets = DISCOVER_PLAYLIST_PRESETS.map((preset) => {
      if (preset.id === "focus-listening-history" && historyArtists.length > 0) {
        const label = historyArtists.join(", ");
        return {
          ...preset,
          description: `Tracks related to ${label}`,
          relatedArtists: historyArtists,
        };
      }
      return { ...preset };
    }).filter((preset) => preset.id !== "focus-listening-history" || historyArtists.length > 0);

    const baseDiscoveryCache = discoveryCache || getDiscoveryCache(listenHistoryProfile);
    const plannerOptions = {
      discoveryCache: {
        ...baseDiscoveryCache,
        basedOn,
        topGenres,
        topTags,
        recommendations,
        globalTop:
          Array.isArray(globalTop) && globalTop.length > 0
            ? globalTop
            : baseDiscoveryCache?.globalTop || [],
      },
      libraryArtists,
      libraryArtistKeys,
    };

    const buildResult = await buildPlaylistsFromPresets(
      tastePresets,
      { listenHistoryProfile, plannerOptions },
      onProgress,
    );
    presetPlaylists = buildResult.playlists;
    totalSteps = buildResult.totalSteps;
  }

  const playlists = [...presetPlaylists];

  if (personalizedEnabled) {
    const releaseRadarPlaylist = await buildReleaseRadarPlaylist({
      listenHistoryProfile,
      basedOn,
      libraryArtists,
    });
    if (releaseRadarPlaylist) {
      playlists.push(releaseRadarPlaylist);
    }
  }

  let editorialPlaylists = [];
  try {
    editorialPlaylists = await generateEditorialPlaylists();
  } catch (error) {
    console.warn(`[DiscoverPlaylists] Editorial playlists failed: ${error.message}`);
  }
  playlists.push(...editorialPlaylists);

  onProgress?.({ completed: totalSteps, total: totalSteps });

  const { attachArtworkToDiscoverPlaylists } =
    await import("./playlistArtworkBuilder.js");
  return attachArtworkToDiscoverPlaylists(playlists);
}

export function annotateDiscoverPlaylistsForUser(playlists, user) {
  const flows = flowPlaylistConfig.getFlowsOwnedByUser(user?.id);
  const adoptedFlowByPresetId = new Map();
  for (const flow of flows) {
    const presetId = String(flow?.discoverPresetId || "").trim();
    if (!presetId) continue;
    adoptedFlowByPresetId.set(presetId, flow.id);
  }
  const adoptedPlaylistByPresetId = new Map();
  for (const playlist of flowPlaylistConfig.getSharedPlaylistsOwnedByUser(user?.id)) {
    const presetId = String(playlist?.discoverPresetId || "").trim();
    if (!presetId) continue;
    adoptedPlaylistByPresetId.set(presetId, playlist.id);
  }
  return (Array.isArray(playlists) ? playlists : []).map((playlist) => ({
    ...playlist,
    artworkColor: playlist.artworkColor || FIXED_DISCOVER_PLAYLIST_ARTWORK_COLORS[playlist.presetId] || null,
    adoptedFlowId: adoptedFlowByPresetId.get(playlist.presetId) || null,
    adoptedPlaylistId: adoptedPlaylistByPresetId.get(playlist.presetId) || null,
  }));
}

export function getCachedDiscoverPlaylist(cache, presetId) {
  const playlists = Array.isArray(cache?.discoverPlaylists) ? cache.discoverPlaylists : [];
  return playlists.find((playlist) => playlist.presetId === presetId) || null;
}

export function buildFlowPayloadFromPreset(preset, presetId) {
  const flow = {
    name: preset.name,
    description: preset.description || null,
    discoverPresetId: presetId,
    scheduleDays: [5],
    scheduleTime: "00:00",
  };

  if (preset.type === "editorial") {
    flow.type = "editorial";
    flow.tag = preset.tag || null;
    flow.size = Number.isFinite(preset.size) ? preset.size : 30;
    flow.mix = { discover: 0, mix: 0, trending: 0, focus: 0 };
  } else {
    flow.mix = preset.mix;
    flow.size = preset.size;
    flow.deepDive = preset.deepDive === true;
    flow.tags = preset.tags || [];
    flow.relatedArtists = preset.relatedArtists || [];
  }

  return flow;
}

export {
  resolveListeningHistoryPreset,
  serializeTrack,
};

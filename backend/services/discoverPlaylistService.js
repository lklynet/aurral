import { getLastfmApiKey } from "./apiClients.js";
import { getDiscoveryCache, getMaxFocusPlaylists } from "./discoveryService.js";
import { playlistSource } from "./weeklyFlowPlaylistSource.js";
import { flowPlaylistConfig } from "./weeklyFlowPlaylistConfig.js";
import {
  DISCOVER_PLAYLIST_PRESETS,
  RELEASE_RADAR_PRESET,
  getDiscoverPlaylistPreset,
} from "../config/discoverPlaylistPresets.js";

const FOCUS_PLAYLIST_SIZE = 20;
const PLAYLIST_BUILD_CONCURRENCY = 3;
const FOCUS_MIX = { discover: 0, mix: 0, trending: 0, focus: 100 };
const LISTENING_HISTORY_PLAYLIST_ID = "focus-listening-history";

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

const slugify = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const titleCase = (value) =>
  String(value || "")
    .split(" ")
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");

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
  const mix = preset.mix || { discover: 0, mix: 0, trending: 0, focus: 0 };
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
    type:
      preset.type ||
      (preset.id === RELEASE_RADAR_PRESET.id ? "release_radar" : "flow"),
    mix,
    size: Math.max(1, Math.round(Number(preset.size) || 30)),
    deepDive: preset.deepDive === true,
    tags,
    relatedArtists,
    recipe,
    tracks: tracks.map(serializeTrack),
    trackCount: tracks.length,
  };
};

const areTagsSimilar = (left, right) => {
  const a = slugify(left);
  const b = slugify(right);
  if (!a || !b) return false;
  if (a === b) return true;
  return a.includes(b) || b.includes(a);
};

const diversifyTasteTags = (topGenres = [], topTags = []) => {
  const merged = uniqueStrings([...topGenres, ...topTags], 12);
  const out = [];
  for (const tag of merged) {
    if (out.some((existing) => areTagsSimilar(existing, tag))) continue;
    out.push(tag);
  }
  return out;
};

const isHistorySeedSource = (source) => {
  const normalized = String(source || "")
    .trim()
    .toLowerCase();
  return normalized.length > 0 && normalized !== "library";
};

const resolveFocusSlotBudgets = (maxFocusPlaylists) => {
  const maxFocus = Math.max(0, Math.floor(Number(maxFocusPlaylists) || 0));
  if (maxFocus === 0) {
    return { maxFocus: 0, tag: 0, artist: 0, crossover: 0 };
  }
  const tag = Math.max(1, Math.round(maxFocus * 0.375));
  const artist = Math.max(1, Math.round(maxFocus * 0.375));
  const crossover = Math.max(1, maxFocus - tag - artist);
  return { maxFocus, tag, artist, crossover };
};

const resolveHistoryTopArtists = ({
  historyTopArtists = [],
  basedOn = [],
  limit = 3,
} = {}) => {
  const explicit = uniqueStrings(historyTopArtists, limit);
  if (explicit.length >= limit) return explicit;
  const fromBasedOn = uniqueStrings(
    basedOn
      .filter((entry) => isHistorySeedSource(entry?.source))
      .map((entry) => entry?.name || entry?.artistName),
    limit,
  );
  return uniqueStrings([...explicit, ...fromBasedOn], limit);
};

const buildFocusedPlaylistCandidates = ({
  topGenres = [],
  topTags = [],
  basedOn = [],
  recommendations = [],
  historyTopArtists = [],
  maxFocusPlaylists = getMaxFocusPlaylists(),
} = {}) => {
  const tasteTags = diversifyTasteTags(topGenres, topTags);
  const historyArtists = resolveHistoryTopArtists({
    historyTopArtists,
    basedOn,
    limit: 3,
  });
  const hasListeningHistory = historyArtists.length > 0;
  const autoFocusBudget = Math.max(
    0,
    Math.floor(Number(maxFocusPlaylists) || 0) + (hasListeningHistory ? 0 : 1),
  );
  const {
    maxFocus,
    tag: tagBudget,
    artist: artistBudget,
    crossover: crossoverBudget,
  } = resolveFocusSlotBudgets(autoFocusBudget);
  const candidates = [];
  const seenIds = new Set();
  const usedTagPairs = new Set();
  const usedArtistKeys = new Set();
  let tagSlots = 0;
  let artistSlots = 0;
  let crossoverSlots = 0;

  const autoFocusCount = () =>
    candidates.filter((entry) => entry.id !== LISTENING_HISTORY_PLAYLIST_ID)
      .length;

  const canAddAutoFocus = () => autoFocusCount() < maxFocus;

  const pushCandidate = (preset) => {
    const id = String(preset?.id || "").trim();
    if (!id || seenIds.has(id)) return false;
    const tags = uniqueStrings(preset.tags || []);
    const relatedArtists = uniqueStrings(preset.relatedArtists || []);
    if (tags.length === 0 && relatedArtists.length === 0) return false;
    seenIds.add(id);
    candidates.push({
      ...preset,
      id,
      tags,
      relatedArtists,
      size: preset.size || FOCUS_PLAYLIST_SIZE,
      type: "focus",
    });
    return true;
  };

  const addAutoFocusCandidate = (preset) => {
    if (!canAddAutoFocus()) return false;
    return pushCandidate(preset);
  };

  const historyArtistKeys = new Set(
    historyArtists.map((artist) => slugify(artist)),
  );
  const librarySeedArtists = uniqueStrings(
    basedOn
      .filter(
        (entry) => String(entry?.source || "").toLowerCase() === "library",
      )
      .map((entry) => entry?.name || entry?.artistName),
    8,
  );
  const relatedSeedArtists = uniqueStrings(
    [
      ...librarySeedArtists,
      ...basedOn
        .map((entry) => entry?.name || entry?.artistName)
        .filter((artist) => !historyArtistKeys.has(slugify(artist))),
    ],
    8,
  );

  if (historyArtists.length > 0) {
    const label = historyArtists.join(", ");
    pushCandidate({
      id: LISTENING_HISTORY_PLAYLIST_ID,
      name: "Listening History",
      description: `Tracks related to ${label}`,
      mix: { ...FOCUS_MIX },
      tags: [],
      relatedArtists: historyArtists,
      deepDive: false,
    });
  }

  if (maxFocus === 0) {
    return candidates;
  }

  if (tasteTags[0] && tagSlots < tagBudget) {
    if (
      addAutoFocusCandidate({
        id: `focus-spotlight:${slugify(tasteTags[0])}`,
        name: `${titleCase(tasteTags[0])} Spotlight`,
        description: `A deep dive into ${tasteTags[0]}`,
        mix: { ...FOCUS_MIX },
        tags: [tasteTags[0]],
        relatedArtists: [],
        deepDive: true,
      })
    ) {
      tagSlots += 1;
    }
  }

  for (let index = 0; index < tasteTags.length - 1; index += 1) {
    if (tagSlots >= tagBudget || !canAddAutoFocus()) break;
    const left = tasteTags[index];
    const right = tasteTags.find(
      (tag, tagIndex) => tagIndex > index && !areTagsSimilar(left, tag),
    );
    if (!right) continue;
    const pairKey = [slugify(left), slugify(right)].sort().join("::");
    if (usedTagPairs.has(pairKey)) continue;
    usedTagPairs.add(pairKey);
    if (
      addAutoFocusCandidate({
        id: `focus-tags:${slugify(left)}-${slugify(right)}`,
        name: `${titleCase(left)} × ${titleCase(right)}`,
        description: `Where ${left} meets ${right}`,
        mix: { ...FOCUS_MIX },
        tags: [left, right],
        relatedArtists: [],
        deepDive: true,
      })
    ) {
      tagSlots += 1;
    }
  }

  for (const artistName of relatedSeedArtists) {
    if (artistSlots >= artistBudget || !canAddAutoFocus()) break;
    const artistKey = slugify(artistName);
    if (!artistKey || usedArtistKeys.has(artistKey)) continue;
    usedArtistKeys.add(artistKey);
    if (
      addAutoFocusCandidate({
        id: `focus-artist:${artistKey}`,
        name: `Near ${artistName}`,
        description: `Artists related to ${artistName}`,
        mix: { ...FOCUS_MIX },
        tags: [],
        relatedArtists: [artistName],
        deepDive: true,
      })
    ) {
      artistSlots += 1;
    }
  }

  if (
    relatedSeedArtists.length >= 2 &&
    artistSlots < artistBudget &&
    canAddAutoFocus()
  ) {
    const left = relatedSeedArtists[0];
    const right =
      relatedSeedArtists.find((artist) => slugify(artist) !== slugify(left)) ||
      relatedSeedArtists[1];
    const pairKey = [slugify(left), slugify(right)].sort().join("::");
    if (!usedArtistKeys.has(pairKey)) {
      if (
        addAutoFocusCandidate({
          id: `focus-artists:${slugify(left)}-${slugify(right)}`,
          name: `${left} · ${right}`,
          description: `Between ${left} and ${right}`,
          mix: { ...FOCUS_MIX },
          tags: [],
          relatedArtists: [left, right],
          deepDive: false,
        })
      ) {
        artistSlots += 1;
      }
    }
  }

  for (let index = 0; index < relatedSeedArtists.length; index += 1) {
    if (crossoverSlots >= crossoverBudget || !canAddAutoFocus()) break;
    const artistName = relatedSeedArtists[index];
    const artistKey = slugify(artistName);
    if (!artistKey || usedArtistKeys.has(`cross:${artistKey}`)) continue;
    const tag =
      tasteTags[(index + 1) % Math.max(tasteTags.length, 1)] || tasteTags[0];
    if (!tag) continue;
    usedArtistKeys.add(`cross:${artistKey}`);
    if (
      addAutoFocusCandidate({
        id: `focus-cross:${slugify(tag)}-${artistKey}`,
        name: `${titleCase(tag)} · Near ${artistName}`,
        description: `${tag} through ${artistName}'s orbit`,
        mix: { ...FOCUS_MIX },
        tags: [tag],
        relatedArtists: [artistName],
        deepDive: false,
      })
    ) {
      crossoverSlots += 1;
    }
  }

  const recPool = (Array.isArray(recommendations) ? recommendations : [])
    .filter((entry) => {
      const tags = [
        ...(Array.isArray(entry?.matchedTags) ? entry.matchedTags : []),
        ...(Array.isArray(entry?.tags) ? entry.tags : []),
      ];
      return tags.length > 0;
    })
    .slice(0, 6);

  for (let index = 0; index < recPool.length; index += 1) {
    if (!canAddAutoFocus()) break;
    const recommendation = recPool[index];
    const targetArtist = String(
      recommendation?.name || recommendation?.artistName || "",
    ).trim();
    if (!targetArtist) continue;
    const recTags = uniqueStrings(
      [
        ...(Array.isArray(recommendation.matchedTags)
          ? recommendation.matchedTags
          : []),
        ...(Array.isArray(recommendation.tags)
          ? recommendation.tags.slice(0, 2)
          : []),
      ],
      2,
    );
    const diversifiedRecTags = [];
    for (const tag of recTags) {
      if (
        diversifiedRecTags.some((existing) => areTagsSimilar(existing, tag))
      ) {
        continue;
      }
      diversifiedRecTags.push(tag);
    }
    if (diversifiedRecTags.length === 0) continue;

    const anchorArtist = relatedSeedArtists.find(
      (artist) => slugify(artist) !== slugify(targetArtist),
    );
    const tagLabel = diversifiedRecTags
      .map((tag) => titleCase(tag))
      .join(" + ");
    addAutoFocusCandidate({
      id: `focus-path:${slugify(targetArtist)}:${slugify(diversifiedRecTags.join("-"))}`,
      name:
        diversifiedRecTags.length > 1
          ? `${tagLabel} → ${targetArtist}`
          : `${titleCase(diversifiedRecTags[0])} → ${targetArtist}`,
      description: anchorArtist
        ? `${tagLabel} on the way to ${targetArtist}, via ${anchorArtist}`
        : `${tagLabel} on the way to ${targetArtist}`,
      mix: { ...FOCUS_MIX },
      tags: diversifiedRecTags,
      relatedArtists: anchorArtist ? [anchorArtist] : [],
      deepDive: false,
    });
  }

  return candidates;
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
  for (
    let index = 0;
    index < items.length;
    index += PLAYLIST_BUILD_CONCURRENCY
  ) {
    const batch = items.slice(index, index + PLAYLIST_BUILD_CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async (preset) => {
        try {
          return await buildPlaylistFromPreset(preset, options);
        } catch (error) {
          console.warn(
            `[DiscoverPlaylists] Failed to build ${preset.id}: ${error.message}`,
          );
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
  const {
    listenHistoryProfile = null,
    basedOn = [],
    libraryArtists = null,
  } = options;
  try {
    const tracks = await playlistSource.getReleaseRadarTracks(
      RELEASE_RADAR_PRESET.size,
      { listenHistoryProfile, basedOn, libraryArtists },
    );
    if (tracks.length > 0) {
      return buildPlaylistPreview(RELEASE_RADAR_PRESET, tracks);
    }
  } catch (error) {
    console.warn(`[DiscoverPlaylists] Release radar failed: ${error.message}`);
  }
  return null;
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

  const focusCandidates = buildFocusedPlaylistCandidates({
    topGenres,
    topTags,
    basedOn,
    recommendations,
    historyTopArtists,
  });
  const baseDiscoveryCache =
    discoveryCache || getDiscoveryCache(listenHistoryProfile);
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
  const playlistPresets = [...DISCOVER_PLAYLIST_PRESETS, ...focusCandidates];
  const releaseRadarPromise = buildReleaseRadarPlaylist({
    listenHistoryProfile,
    basedOn,
    libraryArtists,
  });
  const { playlists: presetPlaylists, totalSteps } =
    await buildPlaylistsFromPresets(
      playlistPresets,
      { listenHistoryProfile, plannerOptions },
      onProgress,
    );

  const playlists = [...presetPlaylists];

  const releaseRadarPlaylist = await releaseRadarPromise;
  if (releaseRadarPlaylist) {
    playlists.push(releaseRadarPlaylist);
  }

  onProgress?.({ completed: totalSteps, total: totalSteps });

  const { attachArtworkToDiscoverPlaylists } =
    await import("./discoverPlaylistArtworkService.js");
  return attachArtworkToDiscoverPlaylists(playlists);
}

export function annotateDiscoverPlaylistsForUser(playlists, user) {
  const flows = flowPlaylistConfig.getFlowsForUser(user);
  const adoptedFlowByPresetId = new Map();
  for (const flow of flows) {
    const presetId = String(flow?.discoverPresetId || "").trim();
    if (!presetId) continue;
    adoptedFlowByPresetId.set(presetId, flow.id);
  }
  const adoptedPlaylistByPresetId = new Map();
  for (const playlist of flowPlaylistConfig.getSharedPlaylistsForUser(user)) {
    const presetId = String(playlist?.discoverPresetId || "").trim();
    if (!presetId) continue;
    adoptedPlaylistByPresetId.set(presetId, playlist.id);
  }
  return (Array.isArray(playlists) ? playlists : []).map((playlist) => ({
    ...playlist,
    adoptedFlowId: adoptedFlowByPresetId.get(playlist.presetId) || null,
    adoptedPlaylistId:
      adoptedPlaylistByPresetId.get(playlist.presetId) || null,
  }));
}

export function getCachedDiscoverPlaylist(cache, presetId) {
  const playlists = Array.isArray(cache?.discoverPlaylists)
    ? cache.discoverPlaylists
    : [];
  return playlists.find((playlist) => playlist.presetId === presetId) || null;
}

export function buildFlowPayloadFromPreset(preset, presetId) {
  return {
    name: preset.name,
    mix: preset.mix,
    size: preset.size,
    deepDive: preset.deepDive === true,
    tags: preset.tags || [],
    relatedArtists: preset.relatedArtists || [],
    discoverPresetId: presetId,
    scheduleDays: [5],
    scheduleTime: "00:00",
  };
}

export {
  buildFocusedPlaylistCandidates,
  getDiscoverPlaylistPreset,
  resolveFocusSlotBudgets,
  serializeTrack,
};

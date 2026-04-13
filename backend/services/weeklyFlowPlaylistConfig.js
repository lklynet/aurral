import { randomUUID } from "crypto";
import { dbOps } from "../config/db-helpers.js";
import { downloadTracker } from "./weeklyFlowDownloadTracker.js";

const LEGACY_TYPES = ["discover", "mix", "trending"];
const DEFAULT_MIX = { discover: 34, mix: 33, trending: 33 };
const DEFAULT_SIZE = 30;
const DEFAULT_SCHEDULE_TIME = "00:00";
const DAY_MS = 24 * 60 * 60 * 1000;
let cachedFlows = null;
let cachedSharedPlaylists = null;

const titleCase = (value) =>
  String(value || "")
    .split(" ")
    .filter(Boolean)
    .map((w) => w[0]?.toUpperCase() + w.slice(1))
    .join(" ");

const clampSize = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_SIZE;
  return Math.max(Math.round(n), 1);
};

const normalizeWeightMap = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out = {};
  for (const [key, rawValue] of Object.entries(value)) {
    const name = String(key || "").trim();
    if (!name) continue;
    const parsed = Number(rawValue);
    if (!Number.isFinite(parsed)) continue;
    const rounded = Math.round(parsed);
    if (rounded <= 0) continue;
    out[name] = rounded;
  }
  return out;
};

const sumWeightMap = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
  return Object.values(value).reduce((acc, entry) => {
    const parsed = Number(entry);
    return acc + (Number.isFinite(parsed) ? parsed : 0);
  }, 0);
};

const normalizeRecipeCounts = (value, fallback) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fallback ?? { discover: 0, mix: 0, trending: 0 };
  }
  const parseField = (entry) => {
    const parsed = Number(entry);
    if (!Number.isFinite(parsed)) return 0;
    return Math.max(Math.round(parsed), 0);
  };
  return {
    discover: parseField(value?.discover ?? 0),
    mix: parseField(value?.mix ?? 0),
    trending: parseField(value?.trending ?? 0),
  };
};

const clampCount = (value, min = 1, max = 100) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(Math.max(Math.round(n), min), max);
};

const normalizeStringList = (value) => {
  if (value == null) return [];
  if (Array.isArray(value)) {
    return value.map((item) => String(item || "").trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  return [];
};

const normalizeScheduleDays = (value) => {
  if (!Array.isArray(value)) return [];
  const out = new Set();
  for (const entry of value) {
    const day = Number(entry);
    if (!Number.isFinite(day)) continue;
    const rounded = Math.round(day);
    if (rounded < 0 || rounded > 6) continue;
    out.add(rounded);
  }
  return [...out].sort((a, b) => a - b);
};

const getDefaultScheduleDay = (timeMs = Date.now()) =>
  new Date(timeMs).getDay();

const normalizeScheduleTime = (value) => {
  const text = String(value ?? "").trim();
  const match = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (!match) return DEFAULT_SCHEDULE_TIME;
  const hours = Number(match[1]);
  if (
    !Number.isInteger(hours) ||
    hours < 0 ||
    hours > 23
  ) {
    return DEFAULT_SCHEDULE_TIME;
  }
  return `${String(hours).padStart(2, "0")}:00`;
};

const buildScheduledTime = (baseTimeMs, scheduleTime) => {
  const [hoursText, minutesText] = normalizeScheduleTime(scheduleTime).split(":");
  const candidate = new Date(baseTimeMs);
  candidate.setHours(Number(hoursText), Number(minutesText), 0, 0);
  return candidate.getTime();
};

const computeNextRunAt = (
  scheduleDays,
  scheduleTime = DEFAULT_SCHEDULE_TIME,
  fromTimeMs = Date.now(),
) => {
  const normalized = normalizeScheduleDays(scheduleDays);
  if (normalized.length === 0) {
    return buildScheduledTime(fromTimeMs + 7 * DAY_MS, scheduleTime);
  }
  for (let offset = 0; offset <= 7; offset += 1) {
    const candidateBase = fromTimeMs + offset * DAY_MS;
    const candidateTime = buildScheduledTime(candidateBase, scheduleTime);
    const candidateDay = new Date(candidateTime).getDay();
    if (normalized.includes(candidateDay) && candidateTime > fromTimeMs) {
      return candidateTime;
    }
  }
  return buildScheduledTime(fromTimeMs + 7 * DAY_MS, scheduleTime);
};

const distributeCount = (total, values) => {
  const items = values.filter(Boolean);
  if (!items.length || total <= 0) return {};
  const per = Math.floor(total / items.length);
  let remaining = total - per * items.length;
  const result = {};
  for (const item of items) {
    const extra = remaining > 0 ? 1 : 0;
    if (remaining > 0) remaining -= 1;
    result[item] = (result[item] || 0) + per + extra;
  }
  return result;
};

const extractFromBlocks = (value) => {
  if (!Array.isArray(value)) return null;
  const recipe = { discover: 0, mix: 0, trending: 0 };
  const tags = {};
  const relatedArtists = {};
  let deepDive = false;
  let total = 0;
  for (const block of value) {
    if (!block || typeof block !== "object" || Array.isArray(block)) continue;
    const count = clampCount(block.count);
    if (count <= 0) continue;
    total += count;
    if (block.deepDive === true) deepDive = true;
    const include = block.include ?? {};
    const includeTags = normalizeStringList(include.tags ?? include.tag);
    const includeRelated = normalizeStringList(
      include.relatedArtists ?? include.relatedArtist,
    );
    if (includeTags.length > 0) {
      const distributed = distributeCount(count, includeTags);
      for (const [tag, qty] of Object.entries(distributed)) {
        tags[tag] = (tags[tag] || 0) + qty;
      }
      continue;
    }
    if (includeRelated.length > 0) {
      const distributed = distributeCount(count, includeRelated);
      for (const [artist, qty] of Object.entries(distributed)) {
        relatedArtists[artist] = (relatedArtists[artist] || 0) + qty;
      }
      continue;
    }
    const source = String(block.source || "")
      .trim()
      .toLowerCase();
    const key =
      source === "mix"
        ? "mix"
        : source === "trending"
          ? "trending"
          : "discover";
    recipe[key] += count;
  }
  if (total <= 0) return null;
  return { recipe, tags, relatedArtists, deepDive, size: total };
};

const buildCountsFromMix = (size, mix) => {
  const weights = [
    { key: "discover", value: Number(mix?.discover ?? 0) },
    { key: "mix", value: Number(mix?.mix ?? 0) },
    { key: "trending", value: Number(mix?.trending ?? 0) },
  ];
  const sum = weights.reduce(
    (acc, w) => acc + (Number.isFinite(w.value) ? w.value : 0),
    0,
  );
  if (sum <= 0 || !Number.isFinite(sum) || size <= 0) {
    return { discover: 0, mix: 0, trending: 0 };
  }
  const scaled = weights.map((w) => ({
    ...w,
    raw: (w.value / sum) * size,
  }));
  const floored = scaled.map((w) => ({
    ...w,
    count: Math.floor(w.raw),
    remainder: w.raw - Math.floor(w.raw),
  }));
  let remaining = size - floored.reduce((acc, w) => acc + w.count, 0);
  const ordered = [...floored].sort((a, b) => b.remainder - a.remainder);
  for (let i = 0; i < ordered.length && remaining > 0; i++) {
    ordered[i].count += 1;
    remaining -= 1;
  }
  const out = {};
  for (const item of ordered) {
    out[item.key] = item.count;
  }
  return out;
};

const normalizeMix = (mix) => {
  const raw = {
    discover: Number(mix?.discover ?? 0),
    mix: Number(mix?.mix ?? 0),
    trending: Number(mix?.trending ?? 0),
  };
  const sum = raw.discover + raw.mix + raw.trending;
  if (!Number.isFinite(sum) || sum <= 0) {
    return { ...DEFAULT_MIX };
  }
  const weights = [
    { key: "discover", value: raw.discover },
    { key: "mix", value: raw.mix },
    { key: "trending", value: raw.trending },
  ];
  const scaled = weights.map((w) => ({
    ...w,
    raw: (w.value / sum) * 100,
  }));
  const floored = scaled.map((w) => ({
    ...w,
    count: Math.floor(w.raw),
    remainder: w.raw - Math.floor(w.raw),
  }));
  let remaining = 100 - floored.reduce((acc, w) => acc + w.count, 0);
  const ordered = [...floored].sort((a, b) => b.remainder - a.remainder);
  for (let i = 0; i < ordered.length && remaining > 0; i++) {
    ordered[i].count += 1;
    remaining -= 1;
  }
  const out = {};
  for (const item of ordered) {
    out[item.key] = item.count;
  }
  return out;
};

const normalizeFlow = (flow) => {
  const name = String(flow?.name || "").trim();
  const blocksData = extractFromBlocks(flow?.blocks);
  const size = clampSize(flow?.size);
  const mix = normalizeMix(flow?.mix ?? blocksData?.recipe);
  const tags =
    Object.keys(normalizeWeightMap(flow?.tags)).length > 0
      ? normalizeWeightMap(flow?.tags)
      : normalizeWeightMap(blocksData?.tags);
  const relatedArtists =
    Object.keys(normalizeWeightMap(flow?.relatedArtists)).length > 0
      ? normalizeWeightMap(flow?.relatedArtists)
      : normalizeWeightMap(blocksData?.relatedArtists);
  const tagsTotal = sumWeightMap(tags);
  const relatedTotal = sumWeightMap(relatedArtists);
  const baseSize = blocksData?.size > 0 ? blocksData.size : size;
  const recipeSize = baseSize;
  const recipeFallback = buildCountsFromMix(recipeSize, mix);
  const recipe = normalizeRecipeCounts(
    flow?.recipe,
    blocksData?.recipe ?? recipeFallback,
  );
  const recipeTotal = sumWeightMap(recipe);
  const computedSize = recipeTotal > 0 ? recipeTotal : baseSize;
  return {
    id: flow?.id || randomUUID(),
    name: name || "Flow",
    enabled: flow?.enabled === true,
    scheduleDays: normalizeScheduleDays(flow?.scheduleDays),
    scheduleTime: normalizeScheduleTime(flow?.scheduleTime),
    deepDive: flow?.deepDive === true || blocksData?.deepDive === true,
    nextRunAt:
      flow?.nextRunAt != null && Number.isFinite(Number(flow.nextRunAt))
        ? Number(flow.nextRunAt)
        : null,
    size: computedSize > 0 ? computedSize : baseSize,
    mix,
    recipe,
    tags,
    relatedArtists,
    createdAt:
      flow?.createdAt != null && Number.isFinite(Number(flow.createdAt))
        ? Number(flow.createdAt)
        : Date.now(),
  };
};

const normalizeSharedTrack = (track) => {
  if (!track || typeof track !== "object" || Array.isArray(track)) return null;
  const artistName = String(
    track.artistName ??
      track.artist ??
      track.artist_name ??
      track["Artist Name(s)"] ??
      "",
  ).trim();
  const trackName = String(
    track.trackName ??
      track.title ??
      track.name ??
      track.track ??
      track["Track Name"] ??
      "",
  ).trim();
  if (!artistName || !trackName) return null;
  const albumName = String(
    track.albumName ?? track.album ?? track["Album Name"] ?? "",
  ).trim();
  const artistMbid = String(
    track.artistMbid ?? track.artistId ?? track.mbid ?? "",
  ).trim();
  const reason = String(track.reason ?? "").trim();
  return {
    artistName,
    trackName,
    albumName: albumName || null,
    artistMbid: artistMbid || null,
    reason: reason || null,
  };
};

const normalizeSharedPlaylist = (playlist) => {
  const name = String(playlist?.name || "").trim();
  const tracks = Array.isArray(playlist?.tracks)
    ? playlist.tracks.map(normalizeSharedTrack).filter(Boolean)
    : [];
  return {
    id: playlist?.id || randomUUID(),
    name: name || "Shared Playlist",
    sourceName: String(playlist?.sourceName || "").trim() || null,
    sourceFlowId: String(playlist?.sourceFlowId || "").trim() || null,
    importedAt:
      playlist?.importedAt != null &&
      Number.isFinite(Number(playlist.importedAt))
        ? Number(playlist.importedAt)
        : Date.now(),
    createdAt:
      playlist?.createdAt != null && Number.isFinite(Number(playlist.createdAt))
        ? Number(playlist.createdAt)
        : Date.now(),
    tracks,
    trackCount: tracks.length,
  };
};

const buildLegacyFlows = (settings) => {
  const playlists = settings.weeklyFlowPlaylists || {};
  return LEGACY_TYPES.map((type) => {
    const legacy = playlists[type] || {};
    const mix =
      type === "mix"
        ? { discover: 0, mix: 100, trending: 0 }
        : type === "trending"
          ? { discover: 0, mix: 0, trending: 100 }
          : { discover: 100, mix: 0, trending: 0 };
    return normalizeFlow({
      id: randomUUID(),
      name: titleCase(type),
      enabled: legacy.enabled === true,
      nextRunAt: legacy.nextRunAt ?? null,
      size: DEFAULT_SIZE,
      mix,
      deepDive: false,
      tags: {},
      relatedArtists: {},
    });
  });
};

const getStoredFlows = () => {
  if (cachedFlows) {
    return cachedFlows;
  }
  const settings = dbOps.getSettings();
  const stored = settings.weeklyFlows;
  if (Array.isArray(stored) && stored.length > 0) {
    const idMap = new Map();
    let needsSave = false;
    const nextFlows = stored.map((flow) => {
      const currentId = flow?.id;
      if (LEGACY_TYPES.includes(currentId)) {
        const mapped = idMap.get(currentId) || randomUUID();
        idMap.set(currentId, mapped);
        needsSave = true;
        return normalizeFlow({ ...flow, id: mapped });
      }
      if (flow?.blocks) needsSave = true;
      if (!Array.isArray(flow?.scheduleDays)) needsSave = true;
      if (normalizeScheduleTime(flow?.scheduleTime) !== flow?.scheduleTime) {
        needsSave = true;
      }
      return normalizeFlow(flow);
    });
    if (idMap.size > 0 || needsSave) {
      dbOps.updateSettings({
        ...settings,
        weeklyFlows: nextFlows,
      });
      downloadTracker.migratePlaylistTypes(idMap);
    }
    cachedFlows = nextFlows;
    return cachedFlows;
  }
  if (Array.isArray(stored)) {
    cachedFlows = [];
    return cachedFlows;
  }
  dbOps.updateSettings({
    ...settings,
    weeklyFlows: [],
  });
  cachedFlows = [];
  return cachedFlows;
};

const setFlows = (flows) => {
  cachedFlows = flows;
  const current = dbOps.getSettings();
  dbOps.updateSettings({
    ...current,
    weeklyFlows: flows,
  });
};

const getStoredSharedPlaylists = () => {
  if (cachedSharedPlaylists) {
    return cachedSharedPlaylists;
  }
  const settings = dbOps.getSettings();
  const stored = settings.sharedFlowPlaylists;
  if (Array.isArray(stored)) {
    const next = stored.map(normalizeSharedPlaylist);
    const needsSave =
      next.length !== stored.length ||
      next.some(
        (playlist, index) =>
          JSON.stringify(playlist) !== JSON.stringify(stored[index]),
      );
    if (needsSave) {
      dbOps.updateSettings({
        ...settings,
        sharedFlowPlaylists: next,
      });
    }
    cachedSharedPlaylists = next;
    return cachedSharedPlaylists;
  }
  dbOps.updateSettings({
    ...settings,
    sharedFlowPlaylists: [],
  });
  cachedSharedPlaylists = [];
  return cachedSharedPlaylists;
};

const setSharedPlaylists = (playlists) => {
  cachedSharedPlaylists = playlists;
  const current = dbOps.getSettings();
  dbOps.updateSettings({
    ...current,
    sharedFlowPlaylists: playlists,
  });
};

const normalizeNameKey = (value) =>
  String(value || "")
    .trim()
    .toLowerCase();

const createNameConflictError = (name) => {
  const error = new Error(`Flow name "${name}" already exists`);
  error.code = "FLOW_NAME_CONFLICT";
  return error;
};

const createSharedPlaylistNameConflictError = (name) => {
  const error = new Error(`Shared playlist "${name}" already exists`);
  error.code = "SHARED_PLAYLIST_NAME_CONFLICT";
  return error;
};

const assertUniqueFlowName = (flows, nextName, exceptFlowId = null) => {
  const key = normalizeNameKey(nextName);
  if (!key) return;
  const hasConflict = flows.some((flow) => {
    if (!flow) return false;
    if (exceptFlowId && flow.id === exceptFlowId) return false;
    return normalizeNameKey(flow.name) === key;
  });
  if (hasConflict) {
    throw createNameConflictError(String(nextName || "").trim());
  }
};

const assertUniqueSharedPlaylistName = (
  playlists,
  nextName,
  exceptPlaylistId = null,
) => {
  const key = normalizeNameKey(nextName);
  if (!key) return;
  const hasConflict = playlists.some((playlist) => {
    if (!playlist) return false;
    if (exceptPlaylistId && playlist.id === exceptPlaylistId) return false;
    return normalizeNameKey(playlist.name) === key;
  });
  if (hasConflict) {
    throw createSharedPlaylistNameConflictError(String(nextName || "").trim());
  }
};

export const flowPlaylistConfig = {
  getFlows() {
    return getStoredFlows();
  },

  getFlow(flowId) {
    return getStoredFlows().find((flow) => flow.id === flowId) || null;
  },

  isEnabled(flowId) {
    const flow = this.getFlow(flowId);
    return flow?.enabled === true;
  },

  createFlow({
    name,
    mix,
    size,
    deepDive,
    recipe,
    tags,
    relatedArtists,
    scheduleDays,
    scheduleTime,
  }) {
    const flows = getStoredFlows();
    assertUniqueFlowName(flows, name);
    const flow = normalizeFlow({
      id: randomUUID(),
      name,
      mix,
      size,
      deepDive,
      recipe,
      tags,
      relatedArtists,
      scheduleDays,
      scheduleTime,
      enabled: false,
      nextRunAt: null,
    });
    flows.push(flow);
    setFlows(flows);
    return flow;
  },

  updateFlow(flowId, updates) {
    const flows = getStoredFlows();
    const index = flows.findIndex((flow) => flow.id === flowId);
    if (index === -1) return null;
    const current = flows[index];
    const nextName = updates?.name ?? current.name;
    assertUniqueFlowName(flows, nextName, flowId);
    const currentSchedule = normalizeScheduleDays(current.scheduleDays);
    const currentScheduleTime = normalizeScheduleTime(current.scheduleTime);
    const next = normalizeFlow({
      ...current,
      name: nextName,
      size: updates?.size ?? current.size,
      mix: updates?.mix ?? current.mix,
      recipe: updates?.recipe ?? current.recipe,
      tags: updates?.tags ?? current.tags,
      relatedArtists: updates?.relatedArtists ?? current.relatedArtists,
      scheduleDays: updates?.scheduleDays ?? current.scheduleDays,
      scheduleTime: updates?.scheduleTime ?? current.scheduleTime,
      deepDive:
        typeof updates?.deepDive === "boolean"
          ? updates.deepDive
          : current.deepDive,
      enabled: current.enabled,
      nextRunAt: current.nextRunAt,
      createdAt: current.createdAt,
    });
    const nextSchedule = normalizeScheduleDays(next.scheduleDays);
    const nextScheduleTime = normalizeScheduleTime(next.scheduleTime);
    const scheduleChanged =
      currentSchedule.length !== nextSchedule.length ||
      currentSchedule.some((day, idx) => day !== nextSchedule[idx]) ||
      currentScheduleTime !== nextScheduleTime;
    if (current.enabled && (scheduleChanged || next.nextRunAt == null)) {
      const now = Date.now();
      const effectiveSchedule =
        nextSchedule.length > 0 ? nextSchedule : [getDefaultScheduleDay(now)];
      next.scheduleDays = effectiveSchedule;
      next.nextRunAt = computeNextRunAt(
        effectiveSchedule,
        nextScheduleTime,
        now,
      );
    }
    flows[index] = next;
    setFlows(flows);
    return next;
  },

  deleteFlow(flowId) {
    const flows = getStoredFlows();
    const next = flows.filter((flow) => flow.id !== flowId);
    if (next.length === flows.length) return false;
    setFlows(next);
    return true;
  },

  setEnabled(flowId, enabled) {
    const flows = getStoredFlows();
    const index = flows.findIndex((flow) => flow.id === flowId);
    if (index === -1) return null;
    const flow = { ...flows[index], enabled: enabled === true };
    if (!flow.enabled) {
      flow.nextRunAt = null;
    }
    flows[index] = flow;
    setFlows(flows);
    return flow;
  },

  setNextRunAt(flowId, nextRunAt) {
    const flows = getStoredFlows();
    const index = flows.findIndex((flow) => flow.id === flowId);
    if (index === -1) return null;
    const flow = { ...flows[index] };
    flow.nextRunAt =
      nextRunAt != null && Number.isFinite(Number(nextRunAt))
        ? Number(nextRunAt)
        : null;
    flows[index] = flow;
    setFlows(flows);
    return flow;
  },

  scheduleNextRun(flowId) {
    const flows = getStoredFlows();
    const index = flows.findIndex((flow) => flow.id === flowId);
    if (index === -1) return null;
    const now = Date.now();
    const flow = { ...flows[index] };
    const normalizedSchedule = normalizeScheduleDays(flow.scheduleDays);
    flow.scheduleDays =
      normalizedSchedule.length > 0
        ? normalizedSchedule
        : [getDefaultScheduleDay(now)];
    flow.scheduleTime = normalizeScheduleTime(flow.scheduleTime);
    flow.nextRunAt = computeNextRunAt(flow.scheduleDays, flow.scheduleTime, now);
    flows[index] = flow;
    setFlows(flows);
    return flow;
  },

  getDueForRefresh() {
    const now = Date.now();
    return getStoredFlows().filter(
      (flow) =>
        flow.enabled === true &&
        flow.nextRunAt != null &&
        flow.nextRunAt <= now,
    );
  },

  getSharedPlaylists() {
    return getStoredSharedPlaylists();
  },

  getSharedPlaylistSummaries() {
    return getStoredSharedPlaylists().map((playlist) => ({
      id: playlist.id,
      name: playlist.name,
      sourceName: playlist.sourceName,
      sourceFlowId: playlist.sourceFlowId,
      importedAt: playlist.importedAt,
      createdAt: playlist.createdAt,
      trackCount: playlist.trackCount,
    }));
  },

  getSharedPlaylist(playlistId) {
    return (
      getStoredSharedPlaylists().find(
        (playlist) => playlist.id === playlistId,
      ) || null
    );
  },

  createSharedPlaylist({ name, sourceName, sourceFlowId, tracks }) {
    const playlists = getStoredSharedPlaylists();
    assertUniqueSharedPlaylistName(playlists, name);
    const playlist = normalizeSharedPlaylist({
      id: randomUUID(),
      name,
      sourceName,
      sourceFlowId,
      tracks,
      importedAt: Date.now(),
      createdAt: Date.now(),
    });
    playlists.push(playlist);
    setSharedPlaylists(playlists);
    return playlist;
  },

  updateSharedPlaylist(playlistId, updates) {
    const playlists = getStoredSharedPlaylists();
    const index = playlists.findIndex((playlist) => playlist.id === playlistId);
    if (index === -1) return null;
    const current = playlists[index];
    const nextName = updates?.name ?? current.name;
    assertUniqueSharedPlaylistName(playlists, nextName, playlistId);
    const next = normalizeSharedPlaylist({
      ...current,
      name: nextName,
      sourceName: updates?.sourceName ?? current.sourceName,
      sourceFlowId: updates?.sourceFlowId ?? current.sourceFlowId,
      tracks: Array.isArray(updates?.tracks) ? updates.tracks : current.tracks,
      importedAt: current.importedAt,
      createdAt: current.createdAt,
    });
    playlists[index] = next;
    setSharedPlaylists(playlists);
    return next;
  },

  deleteSharedPlaylist(playlistId) {
    const playlists = getStoredSharedPlaylists();
    const next = playlists.filter((playlist) => playlist.id !== playlistId);
    if (next.length === playlists.length) return false;
    setSharedPlaylists(next);
    return true;
  },
};

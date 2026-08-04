import { randomBytes, randomUUID } from "crypto";
import { dbOps } from "../../db/helpers/index.js";
import { downloadTracker } from "./weeklyFlowDownloadTracker.js";
import { getDiscoverPlaylistPreset } from "../../config/discoverPlaylistPresets.js";
import { EDITORIAL_PLAYLIST_POOL } from "../../config/editorialPlaylistPresets.js";

const LEGACY_TYPES = ["discover", "mix", "trending"];
const DEFAULT_MIX = { discover: 34, mix: 33, trending: 33, focus: 0 };
export const DEFAULT_SIZE = 30;
const DEFAULT_SCHEDULE_TIME = "00:00";
const DAY_MS = 24 * 60 * 60 * 1000;
let cachedFlows = null;
let cachedSharedPlaylists = null;

const clampSize = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_SIZE;
  return Math.max(Math.round(n), 1);
};

export const normalizeYearBound = (value) => {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const year = Math.trunc(parsed);
  if (year < 1000 || year > 9999) return null;
  return year;
};

export const normalizeYearRange = (yearFrom, yearTo) => {
  let from = normalizeYearBound(yearFrom);
  let to = normalizeYearBound(yearTo);
  if (from != null && to != null && from > to) {
    const swap = from;
    from = to;
    to = swap;
  }
  return { yearFrom: from, yearTo: to };
};

export const resolveYearRangeUpdate = (current, updates = {}) => {
  const hasYearFromUpdate = Object.prototype.hasOwnProperty.call(updates, "yearFrom");
  const hasYearToUpdate = Object.prototype.hasOwnProperty.call(updates, "yearTo");
  if (!hasYearFromUpdate && !hasYearToUpdate) {
    return {
      yearFrom: normalizeYearBound(current?.yearFrom),
      yearTo: normalizeYearBound(current?.yearTo),
    };
  }
  if (hasYearFromUpdate && hasYearToUpdate) {
    return normalizeYearRange(updates.yearFrom, updates.yearTo);
  }
  let yearFrom = hasYearFromUpdate
    ? normalizeYearBound(updates.yearFrom)
    : normalizeYearBound(current?.yearFrom);
  let yearTo = hasYearToUpdate
    ? normalizeYearBound(updates.yearTo)
    : normalizeYearBound(current?.yearTo);
  if (yearFrom != null && yearTo != null && yearFrom > yearTo) {
    if (hasYearFromUpdate) yearTo = null;
    else yearFrom = null;
  }
  return { yearFrom, yearTo };
};

export const normalizeWeightMap = (value) => {
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

const getFlowEntryName = (value) => {
  if (typeof value === "string" || typeof value === "number") {
    const text = String(value).trim();
    return text || null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const candidates = [
    value.name,
    value.artistName,
    value.artist,
    value.tag,
    value.label,
    value.value,
  ];
  for (const candidate of candidates) {
    const text = String(candidate || "").trim();
    if (text) return text;
  }
  return null;
};

const normalizeStringArray = (value) => {
  const raw = Array.isArray(value) ? value : value == null ? [] : [value];
  const seen = new Set();
  const out = [];
  for (const entry of raw) {
    const text = getFlowEntryName(entry);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
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

const getDefaultScheduleDay = (timeMs = Date.now()) => new Date(timeMs).getDay();

const normalizeScheduleTime = (value) => {
  const text = String(value ?? "").trim();
  const match = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (!match) return DEFAULT_SCHEDULE_TIME;
  const hours = Number(match[1]);
  if (!Number.isInteger(hours) || hours < 0 || hours > 23) {
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

const normalizeMix = (mix) => {
  const raw = {
    discover: Number(mix?.discover ?? 0),
    mix: Number(mix?.mix ?? 0),
    trending: Number(mix?.trending ?? 0),
    focus: Number(mix?.focus ?? 0),
  };
  const sum = raw.discover + raw.mix + raw.trending + raw.focus;
  if (!Number.isFinite(sum) || sum <= 0) {
    return { ...DEFAULT_MIX };
  }
  const weights = [
    { key: "discover", value: raw.discover },
    { key: "mix", value: raw.mix },
    { key: "trending", value: raw.trending },
    { key: "focus", value: raw.focus },
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

const resolvePresetDescription = (discoverPresetId) => {
  const id = String(discoverPresetId || "").trim();
  if (!id) return null;
  const preset =
    getDiscoverPlaylistPreset(id) || EDITORIAL_PLAYLIST_POOL.find((entry) => entry.id === id);
  return preset?.description || null;
};

const normalizeFlow = (flow) => {
  const name = String(flow?.name || "").trim();
  const size = clampSize(flow?.size);
  const mix = normalizeMix(flow?.mix);
  const normalizedTagsArray = normalizeStringArray(flow?.tags);
  const normalizedRelatedArray = normalizeStringArray(flow?.relatedArtists);
  const legacyTags = normalizeWeightMap(flow?.tags);
  const legacyRelatedArtists = normalizeWeightMap(flow?.relatedArtists);
  const tags =
    normalizedTagsArray.length > 0
      ? normalizedTagsArray
      : Object.keys(legacyTags);
  const relatedArtists =
    normalizedRelatedArray.length > 0
      ? normalizedRelatedArray
      : Object.keys(legacyRelatedArtists);
  const { yearFrom, yearTo } = normalizeYearRange(flow?.yearFrom, flow?.yearTo);
  return {
    id: flow?.id || randomUUID(),
    name: name || "Flow",
    ownerUserId:
      flow?.ownerUserId != null && Number.isFinite(Number(flow.ownerUserId))
        ? Math.trunc(Number(flow.ownerUserId))
        : null,
    enabled: flow?.enabled === true,
    scheduleDays: normalizeScheduleDays(flow?.scheduleDays),
    scheduleTime: normalizeScheduleTime(flow?.scheduleTime),
    deepDive: flow?.deepDive === true,
    yearFrom,
    yearTo,
    nextRunAt:
      flow?.nextRunAt != null && Number.isFinite(Number(flow.nextRunAt))
        ? Number(flow.nextRunAt)
        : null,
    lastRunAt:
      flow?.lastRunAt != null && Number.isFinite(Number(flow.lastRunAt))
        ? Number(flow.lastRunAt)
        : null,
    size,
    mix,
    tags,
    relatedArtists,
    discoverPresetId: String(flow?.discoverPresetId || "").trim() || null,
    type: flow?.type || null,
    tag: flow?.tag || null,
    description:
      String(flow?.description || "").trim() || resolvePresetDescription(flow?.discoverPresetId),
    lidarrFeedToken: String(flow?.lidarrFeedToken || "").trim() || null,
    createdAt:
      flow?.createdAt != null && Number.isFinite(Number(flow.createdAt))
        ? Number(flow.createdAt)
        : Date.now(),
  };
};

export const normalizeSharedTrack = (track) => {
  if (!track || typeof track !== "object" || Array.isArray(track)) return null;
  const artistName = String(
    track.artistName ?? track.artist ?? track.artist_name ?? track["Artist Name(s)"] ?? "",
  ).trim();
  const trackName = String(
    track.trackName ?? track.title ?? track.name ?? track.track ?? track["Track Name"] ?? "",
  ).trim();
  if (!artistName || !trackName) return null;
  const albumName = String(track.albumName ?? track.album ?? track["Album Name"] ?? "").trim();
  const artistMbid = String(track.artistMbid ?? track.artistId ?? "").trim();
  const albumMbid = String(track.albumMbid ?? track.releaseGroupMbid ?? track.albumId ?? "").trim();
  const trackMbid = String(
    track.trackMbid ?? track.recordingMbid ?? track.recordingId ?? track.mbid ?? "",
  ).trim();
  const releaseYear = String(track.releaseYear ?? track.year ?? "").trim();
  const durationMs =
    track.durationMs != null && Number.isFinite(Number(track.durationMs))
      ? Math.max(0, Math.round(Number(track.durationMs)))
      : null;
  const artistAliases = Array.isArray(track.artistAliases)
    ? track.artistAliases.map((entry) => String(entry || "").trim()).filter(Boolean)
    : [];
  const reason = String(track.reason ?? "").trim();
  return {
    artistName,
    trackName,
    albumName: albumName || null,
    artistMbid: artistMbid || null,
    albumMbid: albumMbid || null,
    trackMbid: trackMbid || null,
    releaseYear: releaseYear || null,
    durationMs,
    artistAliases,
    reason: reason || null,
  };
};

export const buildSharedTrackIdentity = (track) =>
  [
    String(track?.artistName || "").trim().toLowerCase(),
    String(track?.trackName || "").trim().toLowerCase(),
    String(track?.albumName || "").trim().toLowerCase(),
    String(track?.artistMbid || "").trim(),
    String(track?.albumMbid || "").trim(),
    String(track?.trackMbid || "").trim(),
    String(track?.releaseYear || "").trim(),
  ].join("\u0001");

export const buildCoreTrackIdentity = (track) => {
  const artistName = String(track?.artistName || "").trim().toLowerCase();
  const trackName = String(track?.trackName || "").trim().toLowerCase();
  if (!artistName || !trackName) return "";
  return `${artistName}\u0001${trackName}`;
};

export const tracksShareMembership = (left, right) => {
  if (buildSharedTrackIdentity(left) === buildSharedTrackIdentity(right)) {
    return true;
  }
  const leftCore = buildCoreTrackIdentity(left);
  const rightCore = buildCoreTrackIdentity(right);
  return Boolean(leftCore) && leftCore === rightCore;
};

export const sortJobsByCreatedAt = (jobs) =>
  [...(Array.isArray(jobs) ? jobs : [])].sort((left, right) => {
    const leftCreated = Number(left?.createdAt || 0);
    const rightCreated = Number(right?.createdAt || 0);
    if (leftCreated !== rightCreated) return leftCreated - rightCreated;
    return String(left?.id || "").localeCompare(String(right?.id || ""));
  });

export const orderJobsBySharedPlaylistTracks = (jobs, tracks) => {
  const list = Array.isArray(jobs) ? [...jobs] : [];
  const configTracks = Array.isArray(tracks) ? tracks : [];
  if (!configTracks.length) {
    return sortJobsByCreatedAt(list);
  }
  const unmatchedJobs = sortJobsByCreatedAt(list);
  const orderedJobs = [];
  for (const track of configTracks) {
    const identity = buildSharedTrackIdentity(track);
    let index = unmatchedJobs.findIndex(
      (job) => buildSharedTrackIdentity(job) === identity,
    );
    if (index < 0) {
      index = unmatchedJobs.findIndex((job) => tracksShareMembership(job, track));
    }
    if (index >= 0) orderedJobs.push(unmatchedJobs.splice(index, 1)[0]);
  }
  orderedJobs.push(...unmatchedJobs);
  return orderedJobs;
};

export const dedupeSharedTracks = (tracks) => {
  const seen = new Set();
  const uniqueTracks = [];
  for (const track of Array.isArray(tracks) ? tracks : []) {
    const normalizedTrack = normalizeSharedTrack(track);
    if (!normalizedTrack) continue;
    const identity = buildSharedTrackIdentity(normalizedTrack);
    if (seen.has(identity)) continue;
    seen.add(identity);
    uniqueTracks.push(normalizedTrack);
  }
  return uniqueTracks;
};

export const rebuildSharedPlaylistTracksFromJobs = (configTracks, jobs) => {
  const jobList = Array.isArray(jobs) ? jobs : [];
  const unmatchedJobIds = new Set(jobList.map((job) => job.id));
  const remainingTracks = [];
  for (const track of dedupeSharedTracks(configTracks)) {
    const match = jobList.find(
      (job) => unmatchedJobIds.has(job.id) && tracksShareMembership(job, track),
    );
    if (!match) continue;
    unmatchedJobIds.delete(match.id);
    remainingTracks.push(track);
  }
  for (const job of sortJobsByCreatedAt(jobList)) {
    if (!unmatchedJobIds.has(job.id)) continue;
    unmatchedJobIds.delete(job.id);
    const track = normalizeSharedTrack({
      artistName: job?.artistName,
      trackName: job?.trackName,
      albumName: job?.albumName || null,
      artistMbid: job?.artistMbid || null,
      albumMbid: job?.albumMbid || null,
      trackMbid: job?.trackMbid || null,
      releaseYear: job?.releaseYear || null,
      durationMs: job?.durationMs || null,
      artistAliases: job?.artistAliases || [],
      reason: job?.reason || null,
    });
    if (track) remainingTracks.push(track);
  }
  return remainingTracks;
};

export const filterMissingSharedTracks = (existingTracks, incomingTracks) => {
  const seen = new Set(
    dedupeSharedTracks(existingTracks).map((track) => buildSharedTrackIdentity(track)),
  );
  const missingTracks = [];
  for (const track of Array.isArray(incomingTracks) ? incomingTracks : []) {
    const normalizedTrack = normalizeSharedTrack(track);
    if (!normalizedTrack) continue;
    const identity = buildSharedTrackIdentity(normalizedTrack);
    if (seen.has(identity)) continue;
    seen.add(identity);
    missingTracks.push(normalizedTrack);
  }
  return missingTracks;
};

export function normalizeImportSource(value) {
  if (!value || typeof value !== "object") return null;
  const provider = String(value.provider || "").trim();
  if (!provider) return null;
  const syncIntervalHours = Number(value.syncIntervalHours);
  const lastSyncAt = Number(value.lastSyncAt);
  const hasSync =
    value.syncEnabled !== false &&
    Number.isFinite(syncIntervalHours) &&
    syncIntervalHours > 0;
  return {
    provider,
    externalId: String(value.externalId || "").trim() || null,
    externalName: String(value.externalName || "").trim() || null,
    syncEnabled: hasSync,
    syncIntervalHours: hasSync
      ? Math.min(Math.max(Math.round(syncIntervalHours), 1), 168)
      : 0,
    lastSyncAt: Number.isFinite(lastSyncAt) && lastSyncAt > 0 ? lastSyncAt : null,
    lastSyncError: String(value.lastSyncError || "").trim() || null,
    lastSyncTrackCount:
      value.lastSyncTrackCount != null && Number.isFinite(Number(value.lastSyncTrackCount))
        ? Number(value.lastSyncTrackCount)
        : null,
  };
}

const normalizeSharedPlaylist = (playlist) => {
  const name = String(playlist?.name || "").trim();
  const tracks = dedupeSharedTracks(playlist?.tracks);
  const importSource = normalizeImportSource(playlist?.importSource);
  return {
    id: playlist?.id || randomUUID(),
    name: name || "Shared Playlist",
    ownerUserId:
      playlist?.ownerUserId != null && Number.isFinite(Number(playlist.ownerUserId))
        ? Math.trunc(Number(playlist.ownerUserId))
        : null,
    sourceName: String(playlist?.sourceName || "").trim() || null,
    sourceFlowId: String(playlist?.sourceFlowId || "").trim() || null,
    discoverPresetId: String(playlist?.discoverPresetId || "").trim() || null,
    type: playlist?.type || null,
    description:
      String(playlist?.description || "").trim() ||
      resolvePresetDescription(playlist?.discoverPresetId),
    importSource,
    importedAt:
      playlist?.importedAt != null && Number.isFinite(Number(playlist.importedAt))
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

const getStoredFlows = () => {
  if (cachedFlows) {
    return cachedFlows;
  }
  const settings = dbOps.getSettings();
  const stored = settings.flows;
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
      if (!Array.isArray(flow?.scheduleDays)) needsSave = true;
      if (normalizeScheduleTime(flow?.scheduleTime) !== flow?.scheduleTime) {
        needsSave = true;
      }
      return normalizeFlow(flow);
    });
    if (idMap.size > 0 || needsSave) {
      dbOps.updateSettings({
        ...settings,
        flows: nextFlows,
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
    flows: [],
  });
  cachedFlows = [];
  return cachedFlows;
};

const setFlows = (flows) => {
  cachedFlows = flows;
  const current = dbOps.getSettings();
  dbOps.updateSettings({
    ...current,
    flows,
  });
};

const getStoredSharedPlaylists = () => {
  if (cachedSharedPlaylists) {
    return cachedSharedPlaylists;
  }
  const settings = dbOps.getSettings();
  const stored = settings.sharedPlaylists;
  if (Array.isArray(stored)) {
    const next = stored.map(normalizeSharedPlaylist);
    const needsSave =
      next.length !== stored.length ||
      next.some((playlist, index) => JSON.stringify(playlist) !== JSON.stringify(stored[index]));
    if (needsSave) {
      dbOps.updateSettings({
        ...settings,
        sharedPlaylists: next,
      });
    }
    cachedSharedPlaylists = next;
    return cachedSharedPlaylists;
  }
  dbOps.updateSettings({
    ...settings,
    sharedPlaylists: [],
  });
  cachedSharedPlaylists = [];
  return cachedSharedPlaylists;
};

const setSharedPlaylists = (playlists) => {
  cachedSharedPlaylists = playlists;
  const current = dbOps.getSettings();
  dbOps.updateSettings({
    ...current,
    sharedPlaylists: playlists,
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

const canUserAccessOwnerScopedEntity = (user, ownerUserId) => {
  if (user?.role === "admin") return true;
  if (!user || ownerUserId == null) return false;
  return Number(user.id) === Number(ownerUserId);
};

const isOwnedByUser = (entity, userId) => Number(entity?.ownerUserId) === Number(userId);

const entitiesRelevantForNameCheck = (entities, { ownerUserId }) =>
  entities.filter((e) => isOwnedByUser(e, ownerUserId));

const assertUniqueFlowName = (flows, sameOwnerPlaylists, nextName, exceptFlowId = null) => {
  const key = normalizeNameKey(nextName);
  if (!key) return;
  const flowConflict = flows.some((flow) => {
    if (!flow) return false;
    if (exceptFlowId && flow.id === exceptFlowId) return false;
    return normalizeNameKey(flow.name) === key;
  });
  const playlistConflict = sameOwnerPlaylists.some(
    (playlist) => playlist && normalizeNameKey(playlist.name) === key,
  );
  if (flowConflict || playlistConflict) {
    throw createNameConflictError(String(nextName || "").trim());
  }
};

const assertUniqueSharedPlaylistName = (playlists, sameOwnerFlows, nextName, exceptPlaylistId = null) => {
  const key = normalizeNameKey(nextName);
  if (!key) return;
  const playlistConflict = playlists.some((playlist) => {
    if (!playlist) return false;
    if (exceptPlaylistId && playlist.id === exceptPlaylistId) return false;
    return normalizeNameKey(playlist.name) === key;
  });
  const flowConflict = sameOwnerFlows.some((flow) => flow && normalizeNameKey(flow.name) === key);
  if (playlistConflict || flowConflict) {
    throw createSharedPlaylistNameConflictError(String(nextName || "").trim());
  }
};

export const flowPlaylistConfig = {
  canUserAccessFlow(user, flow) {
    return canUserAccessOwnerScopedEntity(user, flow?.ownerUserId ?? null);
  },

  canUserAccessSharedPlaylist(user, playlist) {
    return canUserAccessOwnerScopedEntity(user, playlist?.ownerUserId ?? null);
  },

  getFlows() {
    return getStoredFlows();
  },

  getFlowsForUser(user) {
    return getStoredFlows().filter((flow) => this.canUserAccessFlow(user, flow));
  },

  getFlowsOwnedByUser(userId) {
    return getStoredFlows().filter((flow) => isOwnedByUser(flow, userId));
  },

  getFlow(flowId) {
    return getStoredFlows().find((flow) => flow.id === flowId) || null;
  },

  getFlowForUser(user, flowId) {
    const flow = this.getFlow(flowId);
    return this.canUserAccessFlow(user, flow) ? flow : null;
  },

  ensureLidarrFeedToken(flowId) {
    const flows = getStoredFlows();
    const index = flows.findIndex((flow) => flow.id === flowId);
    if (index === -1) return null;
    const current = flows[index];
    if (current.lidarrFeedToken) return current;
    const next = normalizeFlow({
      ...current,
      lidarrFeedToken: randomBytes(24).toString("hex"),
    });
    flows[index] = next;
    setFlows(flows);
    return next;
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
    yearFrom,
    yearTo,
    tags,
    relatedArtists,
    scheduleDays,
    scheduleTime,
    ownerUserId = null,
    discoverPresetId = null,
    type = null,
    tag = null,
    description = null,
  }) {
    const flows = getStoredFlows();
    assertUniqueFlowName(
      entitiesRelevantForNameCheck(flows, { ownerUserId }),
      entitiesRelevantForNameCheck(getStoredSharedPlaylists(), { ownerUserId }),
      name,
    );
    const flow = normalizeFlow({
      id: randomUUID(),
      name,
      mix,
      size,
      deepDive,
      yearFrom,
      yearTo,
      tags,
      relatedArtists,
      discoverPresetId,
      type,
      tag,
      description,
      scheduleDays,
      scheduleTime,
      ownerUserId,
      enabled: false,
      nextRunAt: null,
      lastRunAt: null,
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
    assertUniqueFlowName(
      entitiesRelevantForNameCheck(flows, { ownerUserId: current.ownerUserId }),
      entitiesRelevantForNameCheck(getStoredSharedPlaylists(), {
        ownerUserId: current.ownerUserId,
      }),
      nextName,
      flowId,
    );
    const currentSchedule = normalizeScheduleDays(current.scheduleDays);
    const currentScheduleTime = normalizeScheduleTime(current.scheduleTime);
    const { yearFrom, yearTo } = resolveYearRangeUpdate(current, updates || {});
    const next = normalizeFlow({
      ...current,
      name: nextName,
      size: updates?.size ?? current.size,
      mix: updates?.mix ?? current.mix,
      tags: updates?.tags ?? current.tags,
      relatedArtists: updates?.relatedArtists ?? current.relatedArtists,
      scheduleDays: updates?.scheduleDays ?? current.scheduleDays,
      scheduleTime: updates?.scheduleTime ?? current.scheduleTime,
      deepDive: typeof updates?.deepDive === "boolean" ? updates.deepDive : current.deepDive,
      yearFrom,
      yearTo,
      enabled: current.enabled,
      nextRunAt: current.nextRunAt,
      lastRunAt: current.lastRunAt,
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
      next.nextRunAt = computeNextRunAt(effectiveSchedule, nextScheduleTime, now);
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

  markLastRunAt(flowId, lastRunAt = Date.now()) {
    const flows = getStoredFlows();
    const index = flows.findIndex((flow) => flow.id === flowId);
    if (index === -1) return null;
    const flow = { ...flows[index] };
    flow.lastRunAt =
      lastRunAt != null && Number.isFinite(Number(lastRunAt)) ? Number(lastRunAt) : Date.now();
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
      normalizedSchedule.length > 0 ? normalizedSchedule : [getDefaultScheduleDay(now)];
    flow.scheduleTime = normalizeScheduleTime(flow.scheduleTime);
    flow.nextRunAt = computeNextRunAt(flow.scheduleDays, flow.scheduleTime, now);
    flows[index] = flow;
    setFlows(flows);
    return flow;
  },

  getDueForRefresh() {
    const now = Date.now();
    return getStoredFlows().filter(
      (flow) => flow.enabled === true && flow.nextRunAt != null && flow.nextRunAt <= now,
    );
  },

  getSharedPlaylists() {
    return getStoredSharedPlaylists();
  },

  getSharedPlaylistsForUser(user) {
    return getStoredSharedPlaylists().filter((playlist) =>
      this.canUserAccessSharedPlaylist(user, playlist),
    );
  },

  getSharedPlaylistsOwnedByUser(userId) {
    return getStoredSharedPlaylists().filter((playlist) => isOwnedByUser(playlist, userId));
  },

  getSharedPlaylist(playlistId) {
    return getStoredSharedPlaylists().find((playlist) => playlist.id === playlistId) || null;
  },

  getSharedPlaylistForUser(user, playlistId) {
    const playlist = this.getSharedPlaylist(playlistId);
    return this.canUserAccessSharedPlaylist(user, playlist) ? playlist : null;
  },

  createSharedPlaylist({
    id = null,
    name,
    sourceName,
    sourceFlowId,
    discoverPresetId = null,
    type = null,
    tracks = [],
    ownerUserId = null,
    importSource = null,
    description = null,
  }) {
    const playlists = getStoredSharedPlaylists();
    assertUniqueSharedPlaylistName(
      entitiesRelevantForNameCheck(playlists, { ownerUserId }),
      entitiesRelevantForNameCheck(getStoredFlows(), { ownerUserId }),
      name,
    );
    const playlist = normalizeSharedPlaylist({
      id: String(id || "").trim() || randomUUID(),
      name,
      ownerUserId,
      sourceName,
      sourceFlowId,
      discoverPresetId,
      type,
      importSource,
      description,
      tracks,
      importedAt: Date.now(),
      createdAt: Date.now(),
    });
    playlists.push(playlist);
    setSharedPlaylists(playlists);
    return playlist;
  },

  appendSharedPlaylistTracks(playlistId, tracks) {
    const playlists = getStoredSharedPlaylists();
    const index = playlists.findIndex((playlist) => playlist.id === playlistId);
    if (index === -1) return null;
    const current = playlists[index];
    const appendedTracks = filterMissingSharedTracks(current.tracks, tracks);
    const next = normalizeSharedPlaylist({
      ...current,
      tracks: [...current.tracks, ...appendedTracks],
      importedAt: current.importedAt,
      createdAt: current.createdAt,
    });
    playlists[index] = next;
    setSharedPlaylists(playlists);
    return next;
  },

  updateSharedPlaylist(playlistId, updates) {
    const playlists = getStoredSharedPlaylists();
    const index = playlists.findIndex((playlist) => playlist.id === playlistId);
    if (index === -1) return null;
    const current = playlists[index];
    const nextName = updates?.name ?? current.name;
    assertUniqueSharedPlaylistName(
      entitiesRelevantForNameCheck(playlists, { ownerUserId: current.ownerUserId }),
      entitiesRelevantForNameCheck(getStoredFlows(), { ownerUserId: current.ownerUserId }),
      nextName,
      playlistId,
    );
    const next = normalizeSharedPlaylist({
      ...current,
      name: nextName,
      sourceName: updates?.sourceName ?? current.sourceName,
      sourceFlowId: updates?.sourceFlowId ?? current.sourceFlowId,
      discoverPresetId: updates?.discoverPresetId ?? current.discoverPresetId,
      importSource:
        updates?.importSource !== undefined
          ? normalizeImportSource(updates.importSource)
          : current.importSource,
      tracks: Array.isArray(updates?.tracks) ? updates.tracks : current.tracks,
      importedAt: current.importedAt,
      createdAt: current.createdAt,
    });
    playlists[index] = next;
    setSharedPlaylists(playlists);
    import("../../services/unifiedSearchService.js").then(({ clearSearchContextCache }) => clearSearchContextCache()).catch(() => {});
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

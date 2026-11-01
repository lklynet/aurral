import { randomBytes, randomUUID } from "crypto";
import * as v from "valibot";
import { dbOps } from "../../db/helpers/index.ts";
import { getDiscoverPlaylistPreset } from "../../config/discoverPlaylistPresets.ts";
import { deletePlaylistArtworkState } from "../playlistArtworkState.ts";
import {
  DEFAULT_FLOW_SIZE,
  DEFAULT_SCHEDULE_TIME,
  normalizeFlowMix,
  normalizeScheduleDays,
  normalizeScheduleTime,
  normalizeTextList,
  normalizeYearBound,
  normalizeYearRange,
  type FlowSource,
} from "../../../lib/flows.ts";
import {
  dedupePlaylistTracks,
  filterMissingPlaylistTracks,
  tracksShareMembership,
  type PlaylistTrackInput,
} from "./playlistTracks.ts";
import type { RequestUser } from "../../middleware/requestUser.ts";

type AccessUser = (Pick<RequestUser, "id"> & Partial<Pick<RequestUser, "role">>) | null | undefined;
type OwnedEntity = { ownerUserId?: number | null };

type FlowMixInput = Partial<Record<FlowSource, unknown>>;

interface StoredFlow {
  id?: string;
  name?: unknown;
  ownerUserId?: unknown;
  enabled?: unknown;
  autoDownload?: unknown;
  recordHistory?: unknown;
  showInLibrary?: unknown;
  scheduleDays?: unknown;
  scheduleTime?: unknown;
  deepDive?: unknown;
  recentListening?: unknown;
  yearFrom?: unknown;
  yearTo?: unknown;
  nextRunAt?: unknown;
  lastRunAt?: unknown;
  size?: unknown;
  mix?: FlowMixInput | null;
  tags?: unknown;
  excludeTags?: unknown;
  relatedArtists?: unknown;
  discoverPresetId?: unknown;
  description?: unknown;
  lidarrFeedToken?: unknown;
  createdAt?: unknown;
}

type CreateFlowInput = StoredFlow & { name: string };

interface FlowUpdates {
  name?: string;
  size?: unknown;
  mix?: unknown;
  tags?: unknown;
  excludeTags?: unknown;
  relatedArtists?: unknown;
  scheduleDays?: unknown;
  scheduleTime?: unknown;
  deepDive?: unknown;
  recentListening?: unknown;
  recordHistory?: unknown;
  showInLibrary?: unknown;
  autoDownload?: unknown;
  yearFrom?: unknown;
  yearTo?: unknown;
}

interface StoredImportSource {
  artworkUrl?: unknown;
  provider?: unknown;
  externalId?: unknown;
  externalUsername?: unknown;
  externalName?: unknown;
  syncEnabled?: unknown;
  syncIntervalHours?: unknown;
  keepRemovedTracks?: unknown;
  lastSyncAt?: unknown;
  lastSyncError?: unknown;
  lastSyncTrackCount?: unknown;
}

interface StoredStaticPlaylist {
  id?: string;
  name?: unknown;
  ownerUserId?: unknown;
  sourceName?: unknown;
  sourceFlowId?: unknown;
  discoverPresetId?: unknown;
  description?: unknown;
  importSource?: StoredImportSource | null;
  recordHistory?: unknown;
  showTrackAvailability?: unknown;
  importedAt?: unknown;
  createdAt?: unknown;
  tracks?: PlaylistTrackInput[];
}

export interface StaticPlaylistUpdates {
  name?: string;
  sourceName?: string | null;
  sourceFlowId?: string | null;
  discoverPresetId?: string | null;
  description?: string | null;
  recordHistory?: unknown;
  showTrackAvailability?: unknown;
  importSource?: StoredImportSource | null;
  tracks?: PlaylistTrackInput[];
}

const IMPORT_SOURCE_PROVIDERS = new Set([
  "spotify-playlist",
  "listenbrainz-playlist",
  "listenbrainz-createdfor",
  "lastfm-station",
  "youtube-music-playlist",
  "deezer-playlist",
  "aurral-share",
]);
const DAY_MS = 24 * 60 * 60 * 1000;
let cachedFlows: FlowConfig[] | null = null;
let cachedStaticPlaylists: StaticPlaylist[] | null = null;
let flowsCachedAt = 0;
let staticPlaylistsCachedAt = 0;
const childCacheExpired = (cachedAt: number) =>
  !!process.env.AURRAL_BACKGROUND_WORKER_GROUP && Date.now() - cachedAt >= 2000;

export function invalidateFlowPlaylistConfigCache() {
  cachedFlows = null;
  cachedStaticPlaylists = null;
  flowsCachedAt = 0;
  staticPlaylistsCachedAt = 0;
}

const clampSize = (value: unknown) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_FLOW_SIZE;
  return Math.max(Math.round(n), 1);
};

const normalizeOwnerUserId = (value: unknown) => {
  if (value == null) return null;
  const userId = Number(value);
  return Number.isSafeInteger(userId) && userId > 0 ? userId : null;
};

const resolveYearRangeUpdate = (
  current: { yearFrom?: unknown; yearTo?: unknown } | null | undefined,
  updates: { yearFrom?: unknown; yearTo?: unknown } = {},
) => {
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

const getDefaultScheduleDay = (timeMs = Date.now()) => new Date(timeMs).getDay();

const buildScheduledTime = (baseTimeMs: number, scheduleTime: unknown) => {
  const [hoursText, minutesText] = normalizeScheduleTime(scheduleTime).split(":");
  const candidate = new Date(baseTimeMs);
  candidate.setHours(Number(hoursText), Number(minutesText), 0, 0);
  return candidate.getTime();
};

const computeNextRunAt = (
  scheduleDays: unknown,
  scheduleTime: unknown = DEFAULT_SCHEDULE_TIME,
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

const resolvePresetDescription = (discoverPresetId: unknown) => {
  const id = String(discoverPresetId || "").trim();
  if (!id) return null;
  return getDiscoverPlaylistPreset(id)?.description || null;
};

const normalizeFlow = (flow: StoredFlow) => {
  const name = String(flow?.name || "").trim();
  const size = clampSize(flow?.size);
  const mix = normalizeFlowMix(flow?.mix);
  const { yearFrom, yearTo } = normalizeYearRange(flow?.yearFrom, flow?.yearTo);
  return {
    id: flow?.id || randomUUID(),
    name: name || "Flow",
    ownerUserId: normalizeOwnerUserId(flow?.ownerUserId),
    enabled: flow?.enabled === true,
    autoDownload: flow?.autoDownload !== false,
    recordHistory: flow?.recordHistory !== false,
    showInLibrary: flow?.showInLibrary === true,
    scheduleDays: normalizeScheduleDays(flow?.scheduleDays),
    scheduleTime: normalizeScheduleTime(flow?.scheduleTime),
    deepDive: flow?.deepDive === true,
    recentListening: flow?.recentListening === true,
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
    tags: normalizeTextList(flow?.tags),
    excludeTags: normalizeTextList(flow?.excludeTags),
    relatedArtists: normalizeTextList(flow?.relatedArtists),
    discoverPresetId: String(flow?.discoverPresetId || "").trim() || null,
    description:
      String(flow?.description || "").trim() || resolvePresetDescription(flow?.discoverPresetId),
    lidarrFeedToken: String(flow?.lidarrFeedToken || "").trim() || null,
    createdAt:
      flow?.createdAt != null && Number.isFinite(Number(flow.createdAt))
        ? Number(flow.createdAt)
        : Date.now(),
  };
};

export function normalizeImportSource(value: StoredImportSource | null | undefined) {
  if (!value || typeof value !== "object") return null;
  const provider = String(value.provider || "").trim();
  if (!IMPORT_SOURCE_PROVIDERS.has(provider)) return null;
  const syncIntervalHours = Number(value.syncIntervalHours);
  const lastSyncAt = Number(value.lastSyncAt);
  const hasSync =
    value.syncEnabled !== false && Number.isFinite(syncIntervalHours) && syncIntervalHours > 0;
  return {
    provider,
    externalId: String(value.externalId || "").trim() || null,
    ...(provider === "lastfm-station"
      ? { externalUsername: String(value.externalUsername || "").trim() || null }
      : {}),
    externalName: String(value.externalName || "").trim() || null,
    artworkUrl:
      typeof value.artworkUrl === "string" && /^https?:\/\//i.test(value.artworkUrl)
        ? value.artworkUrl
        : null,
    syncEnabled: hasSync,
    syncIntervalHours: hasSync ? Math.min(Math.max(Math.round(syncIntervalHours), 1), 168) : 0,
    keepRemovedTracks: value.keepRemovedTracks !== false,
    lastSyncAt: Number.isFinite(lastSyncAt) && lastSyncAt > 0 ? lastSyncAt : null,
    lastSyncError: String(value.lastSyncError || "").trim() || null,
    lastSyncTrackCount:
      value.lastSyncTrackCount != null && Number.isFinite(Number(value.lastSyncTrackCount))
        ? Number(value.lastSyncTrackCount)
        : null,
  };
}

const normalizeStaticPlaylist = (playlist: StoredStaticPlaylist | null | undefined) => {
  const name = String(playlist?.name || "").trim();
  const membershipIds = new Set();
  const tracks = dedupePlaylistTracks(playlist?.tracks).map((track) => {
    const membershipId =
      track.membershipId && !membershipIds.has(track.membershipId)
        ? track.membershipId
        : randomUUID();
    membershipIds.add(membershipId);
    return { ...track, membershipId };
  });
  const importSource = normalizeImportSource(playlist?.importSource);
  return {
    id: playlist?.id || randomUUID(),
    name: name || "Playlist",
    ownerUserId: normalizeOwnerUserId(playlist?.ownerUserId),
    sourceName: String(playlist?.sourceName || "").trim() || null,
    sourceFlowId: String(playlist?.sourceFlowId || "").trim() || null,
    discoverPresetId: String(playlist?.discoverPresetId || "").trim() || null,
    description:
      String(playlist?.description || "").trim() ||
      resolvePresetDescription(playlist?.discoverPresetId),
    importSource,
    recordHistory: playlist?.recordHistory !== false,
    showTrackAvailability: playlist?.showTrackAvailability === true,
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

export type FlowConfig = ReturnType<typeof normalizeFlow>;
export type StaticPlaylist = ReturnType<typeof normalizeStaticPlaylist>;

const getStoredFlows = () => {
  if (cachedFlows && !childCacheExpired(flowsCachedAt)) {
    return cachedFlows;
  }
  flowsCachedAt = Date.now();
  const stored = dbOps.getJSONSetting("flows", v.unknown());
  if (!Array.isArray(stored)) dbOps.updateSettings({ flows: [] });
  cachedFlows = Array.isArray(stored) ? stored.map(normalizeFlow) : [];
  return cachedFlows;
};

const setFlows = (flows: FlowConfig[]) => {
  cachedFlows = flows;
  flowsCachedAt = Date.now();
  dbOps.updateSettings({ flows });
};

const getStoredStaticPlaylists = () => {
  if (cachedStaticPlaylists && !childCacheExpired(staticPlaylistsCachedAt)) {
    return cachedStaticPlaylists;
  }
  staticPlaylistsCachedAt = Date.now();
  const stored = dbOps.getJSONSetting("sharedPlaylists", v.unknown());
  if (!Array.isArray(stored)) dbOps.updateSettings({ sharedPlaylists: [] });
  cachedStaticPlaylists = Array.isArray(stored) ? stored.map(normalizeStaticPlaylist) : [];
  return cachedStaticPlaylists;
};

const setStaticPlaylists = (playlists: StaticPlaylist[]) => {
  cachedStaticPlaylists = playlists;
  staticPlaylistsCachedAt = Date.now();
  try {
    dbOps.updateSettings({ sharedPlaylists: playlists });
  } catch (error) {
    dbOps.invalidateSettingsCache();
    invalidateFlowPlaylistConfigCache();
    throw error;
  }
};

const normalizeNameKey = (value: unknown) =>
  String(value || "")
    .trim()
    .toLowerCase();

const createNameConflictError = (name: string) => {
  const error: Error & { code?: string } = new Error(`Flow name "${name}" already exists`);
  error.code = "FLOW_NAME_CONFLICT";
  return error;
};

const createStaticPlaylistNameConflictError = (name: string) => {
  const error: Error & { code?: string } = new Error(`Playlist "${name}" already exists`);
  error.code = "STATIC_PLAYLIST_NAME_CONFLICT";
  return error;
};

const canUserAccessOwnerScopedEntity = (user: AccessUser, ownerUserId: number | null) => {
  if (user?.role === "admin") return true;
  if (!user || ownerUserId == null) return false;
  return Number(user.id) === Number(ownerUserId);
};

const isOwnedByUser = (entity: OwnedEntity | null | undefined, userId: number | null) =>
  Number(entity?.ownerUserId) === Number(userId);

const entitiesRelevantForNameCheck = <T extends OwnedEntity>(
  entities: T[],
  { ownerUserId }: { ownerUserId: number | null },
) => entities.filter((e) => isOwnedByUser(e, ownerUserId));

const assertUniqueFlowName = (
  flows: FlowConfig[],
  sameOwnerPlaylists: StaticPlaylist[],
  nextName: string,
  exceptFlowId: string | null = null,
) => {
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

const assertUniqueStaticPlaylistName = (
  playlists: StaticPlaylist[],
  sameOwnerFlows: FlowConfig[],
  nextName: unknown,
  exceptPlaylistId: string | null = null,
) => {
  const key = normalizeNameKey(nextName);
  if (!key) return;
  const playlistConflict = playlists.some((playlist) => {
    if (!playlist) return false;
    if (exceptPlaylistId && playlist.id === exceptPlaylistId) return false;
    return normalizeNameKey(playlist.name) === key;
  });
  const flowConflict = sameOwnerFlows.some((flow) => flow && normalizeNameKey(flow.name) === key);
  if (playlistConflict || flowConflict) {
    throw createStaticPlaylistNameConflictError(String(nextName || "").trim());
  }
};

export const flowPlaylistConfig = {
  canUserAccessFlow<T extends OwnedEntity>(user: AccessUser, flow: T | null | undefined) {
    return canUserAccessOwnerScopedEntity(user, flow?.ownerUserId ?? null);
  },

  canUserAccessStaticPlaylist<T extends OwnedEntity>(
    user: AccessUser,
    playlist: T | null | undefined,
  ) {
    return canUserAccessOwnerScopedEntity(user, playlist?.ownerUserId ?? null);
  },

  getFlows() {
    return getStoredFlows();
  },

  saveNormalized() {
    setFlows(getStoredFlows());
    setStaticPlaylists(getStoredStaticPlaylists());
  },

  getFlowsForUser(user: AccessUser) {
    return getStoredFlows().filter((flow) => this.canUserAccessFlow(user, flow));
  },

  getFlowsOwnedByUser(userId: number | null) {
    return getStoredFlows().filter((flow) => isOwnedByUser(flow, userId));
  },

  getFlow(flowId: string | null | undefined) {
    return getStoredFlows().find((flow) => flow.id === flowId) || null;
  },

  getFlowForUser(user: AccessUser, flowId: string) {
    const flow = this.getFlow(flowId);
    return this.canUserAccessFlow(user, flow) ? flow : null;
  },

  ensureLidarrFeedToken(flowId: string) {
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

  isEnabled(flowId: string) {
    const flow = this.getFlow(flowId);
    return flow?.enabled === true;
  },

  createFlow({
    name,
    mix,
    size,
    deepDive,
    recentListening,
    recordHistory,
    autoDownload,
    yearFrom,
    yearTo,
    tags,
    excludeTags,
    relatedArtists,
    scheduleDays,
    scheduleTime,
    ownerUserId = null,
    discoverPresetId = null,
    description = null,
  }: CreateFlowInput) {
    const flows = getStoredFlows();
    const normalizedOwnerUserId = normalizeOwnerUserId(ownerUserId);
    assertUniqueFlowName(
      entitiesRelevantForNameCheck(flows, { ownerUserId: normalizedOwnerUserId }),
      entitiesRelevantForNameCheck(getStoredStaticPlaylists(), {
        ownerUserId: normalizedOwnerUserId,
      }),
      name,
    );
    const flow = normalizeFlow({
      id: randomUUID(),
      name,
      mix,
      size,
      deepDive,
      recentListening,
      yearFrom,
      yearTo,
      tags,
      excludeTags,
      relatedArtists,
      discoverPresetId,
      description,
      recordHistory,
      autoDownload,
      scheduleDays,
      scheduleTime,
      ownerUserId: normalizedOwnerUserId,
      enabled: false,
      nextRunAt: null,
      lastRunAt: null,
    });
    flows.push(flow);
    setFlows(flows);
    return flow;
  },

  updateFlow(flowId: string, updates?: FlowUpdates | null) {
    const flows = getStoredFlows();
    const index = flows.findIndex((flow) => flow.id === flowId);
    if (index === -1) return null;
    const current = flows[index];
    const nextName = updates?.name ?? current.name;
    assertUniqueFlowName(
      entitiesRelevantForNameCheck(flows, { ownerUserId: current.ownerUserId }),
      entitiesRelevantForNameCheck(getStoredStaticPlaylists(), {
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
      excludeTags: updates?.excludeTags ?? current.excludeTags,
      relatedArtists: updates?.relatedArtists ?? current.relatedArtists,
      scheduleDays: updates?.scheduleDays ?? current.scheduleDays,
      scheduleTime: updates?.scheduleTime ?? current.scheduleTime,
      deepDive: typeof updates?.deepDive === "boolean" ? updates.deepDive : current.deepDive,
      recentListening:
        typeof updates?.recentListening === "boolean"
          ? updates.recentListening
          : current.recentListening,
      recordHistory:
        typeof updates?.recordHistory === "boolean" ? updates.recordHistory : current.recordHistory,
      showInLibrary:
        typeof updates?.showInLibrary === "boolean" ? updates.showInLibrary : current.showInLibrary,
      autoDownload:
        typeof updates?.autoDownload === "boolean" ? updates.autoDownload : current.autoDownload,
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

  deleteFlow(flowId: string) {
    const flows = getStoredFlows();
    const next = flows.filter((flow) => flow.id !== flowId);
    if (next.length === flows.length) return false;
    setFlows(next);
    deletePlaylistArtworkState(flowId);
    return true;
  },

  setEnabled(flowId: string, enabled: boolean) {
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

  markLastRunAt(flowId: string, lastRunAt = Date.now()) {
    const flows = getStoredFlows();
    const index = flows.findIndex((flow) => flow.id === flowId);
    if (index === -1) return null;
    const flow = { ...flows[index] };
    flow.lastRunAt = Math.max(
      lastRunAt != null && Number.isFinite(Number(lastRunAt)) ? Number(lastRunAt) : Date.now(),
      (flow.lastRunAt ?? 0) + 1,
    );
    flows[index] = flow;
    setFlows(flows);
    return flow;
  },

  scheduleNextRun(flowId: string) {
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

  getStaticPlaylists() {
    return getStoredStaticPlaylists();
  },

  getStaticPlaylistsForUser(user: AccessUser) {
    return getStoredStaticPlaylists().filter((playlist) =>
      this.canUserAccessStaticPlaylist(user, playlist),
    );
  },

  getStaticPlaylistsOwnedByUser(userId: number | null) {
    return getStoredStaticPlaylists().filter((playlist) => isOwnedByUser(playlist, userId));
  },

  getStaticPlaylist(playlistId: string) {
    return getStoredStaticPlaylists().find((playlist) => playlist.id === playlistId) || null;
  },

  getStaticPlaylistForUser(user: AccessUser, playlistId: string) {
    const playlist = this.getStaticPlaylist(playlistId);
    return this.canUserAccessStaticPlaylist(user, playlist) ? playlist : null;
  },

  createStaticPlaylist({
    id = null,
    name,
    sourceName,
    sourceFlowId,
    discoverPresetId = null,
    tracks = [],
    ownerUserId = null,
    importSource = null,
    description = null,
    recordHistory = true,
    replacesFlowId = null,
  }: {
    id?: string | null;
    name: unknown;
    sourceName?: unknown;
    sourceFlowId?: unknown;
    discoverPresetId?: unknown;
    tracks?: PlaylistTrackInput[];
    ownerUserId?: unknown;
    importSource?: StoredImportSource | null;
    description?: unknown;
    recordHistory?: boolean;
    replacesFlowId?: string | null;
  }) {
    const playlists = getStoredStaticPlaylists();
    const normalizedOwnerUserId = normalizeOwnerUserId(ownerUserId);
    assertUniqueStaticPlaylistName(
      entitiesRelevantForNameCheck(playlists, { ownerUserId: normalizedOwnerUserId }),
      entitiesRelevantForNameCheck(getStoredFlows(), {
        ownerUserId: normalizedOwnerUserId,
      }).filter((flow) => flow.id !== replacesFlowId),
      name,
    );
    const playlist = normalizeStaticPlaylist({
      id: String(id || "").trim() || randomUUID(),
      name,
      ownerUserId: normalizedOwnerUserId,
      sourceName,
      sourceFlowId,
      discoverPresetId,
      importSource,
      description,
      recordHistory,
      tracks,
      importedAt: Date.now(),
      createdAt: Date.now(),
    });
    playlists.push(playlist);
    setStaticPlaylists(playlists);
    return playlist;
  },

  appendStaticPlaylistTracks(playlistId: string, tracks: PlaylistTrackInput[]) {
    const playlists = getStoredStaticPlaylists();
    const index = playlists.findIndex((playlist) => playlist.id === playlistId);
    if (index === -1) return null;
    const current = playlists[index];
    const appendedTracks = filterMissingPlaylistTracks(current.tracks, tracks).map((track) => ({
      ...track,
      membershipId: randomUUID(),
    }));
    const next = normalizeStaticPlaylist({
      ...current,
      tracks: [...current.tracks, ...appendedTracks],
      importedAt: current.importedAt,
      createdAt: current.createdAt,
    });
    playlists[index] = next;
    setStaticPlaylists(playlists);
    return next;
  },

  updateStaticPlaylist(playlistId: string, updates?: StaticPlaylistUpdates) {
    const playlists = getStoredStaticPlaylists();
    const index = playlists.findIndex((playlist) => playlist.id === playlistId);
    if (index === -1) return null;
    const current = playlists[index];
    const nextName = updates?.name ?? current.name;
    assertUniqueStaticPlaylistName(
      entitiesRelevantForNameCheck(playlists, { ownerUserId: current.ownerUserId }),
      entitiesRelevantForNameCheck(getStoredFlows(), { ownerUserId: current.ownerUserId }),
      nextName,
      playlistId,
    );
    const next = normalizeStaticPlaylist({
      ...current,
      name: nextName,
      sourceName: updates?.sourceName ?? current.sourceName,
      description: updates?.description !== undefined ? updates.description : current.description,
      recordHistory:
        typeof updates?.recordHistory === "boolean" ? updates.recordHistory : current.recordHistory,
      showTrackAvailability: updates?.showTrackAvailability ?? current.showTrackAvailability,
      sourceFlowId: updates?.sourceFlowId ?? current.sourceFlowId,
      discoverPresetId: updates?.discoverPresetId ?? current.discoverPresetId,
      importSource:
        updates?.importSource !== undefined
          ? normalizeImportSource(updates.importSource)
          : current.importSource,
      tracks: Array.isArray(updates?.tracks)
        ? dedupePlaylistTracks(updates.tracks).map((track) => {
            const previous = current.tracks.find(
              (entry) =>
                entry.canonicalJobId === track.canonicalJobId &&
                tracksShareMembership(entry, track),
            );
            return { ...track, membershipId: previous?.membershipId || randomUUID() };
          })
        : current.tracks,
      importedAt: current.importedAt,
      createdAt: current.createdAt,
    });
    playlists[index] = next;
    setStaticPlaylists(playlists);
    import("../unifiedSearchService.ts")
      .then(({ clearSearchContextCache }) => clearSearchContextCache())
      .catch(() => {});
    return next;
  },

  deleteStaticPlaylist(playlistId: string) {
    const playlists = getStoredStaticPlaylists();
    const next = playlists.filter((playlist) => playlist.id !== playlistId);
    if (next.length === playlists.length) return false;
    setStaticPlaylists(next);
    deletePlaylistArtworkState(playlistId);
    return true;
  },
};

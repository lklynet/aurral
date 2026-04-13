import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { ExternalLink, Loader2, Settings, Upload } from "lucide-react";
import { useNavigate } from "react-router-dom";
import {
  getFlowStatus,
  getFlowJobs,
  createFlow,
  updateFlow,
  deleteFlow,
  convertFlowToStaticPlaylist,
  deleteSharedPlaylist,
  importSharedPlaylist,
  updateSharedPlaylist,
  setFlowEnabled,
  getFlowTrackStreamUrl,
  getFlowArtworkUrl,
  updateFlowWorkerSettings,
  setPlaylistRetryCyclePaused,
} from "../utils/api";
import { useToast } from "../contexts/ToastContext";
import { useWebSocketChannel } from "../hooks/useWebSocket";
import {
  FlowCard,
  FlowEmptyState,
  ConfirmDeleteModal,
  ConfirmDisableModal,
  FlowWorkerSettingsModal,
  FlowImportReviewModal,
  SharedPlaylistCard,
} from "./FlowPageComponents";

function formatNextRun(nextRunAt, now = Date.now()) {
  if (!nextRunAt) return null;
  const ts =
    typeof nextRunAt === "number" ? nextRunAt : parseInt(nextRunAt, 10);
  if (!Number.isFinite(ts)) return null;
  const diff = ts - now;
  if (diff <= 0) return "soon";
  const minuteMs = 60 * 1000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;
  if (diff < hourMs) {
    const minutes = Math.ceil(diff / minuteMs);
    return minutes === 1 ? "1 minute" : `${minutes} minutes`;
  }
  if (diff < dayMs) {
    const hours = Math.ceil(diff / hourMs);
    return hours === 1 ? "1 hour" : `${hours} hours`;
  }
  const days = Math.ceil(diff / dayMs);
  return days === 1 ? "1 day" : `${days} days`;
}

const DEFAULT_MIX = { discover: 50, mix: 30, trending: 20 };
const DEFAULT_SIZE = 30;

const MIX_PRESETS = [
  {
    id: "balanced",
    label: "Balanced",
    mix: DEFAULT_MIX,
  },
  {
    id: "discover",
    label: "Discover Focus",
    mix: { discover: 70, mix: 20, trending: 10 },
  },
  {
    id: "library",
    label: "Library Mix",
    mix: { discover: 25, mix: 65, trending: 10 },
  },
  {
    id: "trending",
    label: "Trending Lift",
    mix: { discover: 35, mix: 20, trending: 45 },
  },
  {
    id: "custom",
    label: "Custom",
    mix: null,
  },
];

const FOCUS_STRENGTHS = {
  light: 20,
  medium: 35,
  heavy: 50,
};

const FOCUS_OPTIONS = [
  { id: "light", label: "Light" },
  { id: "medium", label: "Medium" },
  { id: "heavy", label: "Heavy" },
];

const NEW_FLOW_TEMPLATE = {
  name: "Discover",
  size: DEFAULT_SIZE,
  mix: DEFAULT_MIX,
  deepDive: false,
  tags: {},
  relatedArtists: {},
  scheduleTime: "00:00",
};
const FLOW_SHARE_FILE_VERSION = 1;
const FLOW_SHARE_FILE_TYPE = "aurral-static-tracklist";

const getNextFlowName = (flows, baseName = "Discover") => {
  const normalizedBase = String(baseName || "").trim() || "Discover";
  const existingNames = new Set(
    (Array.isArray(flows) ? flows : [])
      .map((flow) => String(flow?.name || "").trim().toLowerCase())
      .filter(Boolean),
  );
  if (!existingNames.has(normalizedBase.toLowerCase())) {
    return normalizedBase;
  }
  let index = 2;
  while (index < 10000) {
    const candidate = `${normalizedBase} ${index}`;
    if (!existingNames.has(candidate.toLowerCase())) {
      return candidate;
    }
    index += 1;
  }
  return `${normalizedBase} ${Date.now()}`;
};

const slugifyFilePart = (value, fallback = "flow") => {
  const slug = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || fallback;
};

const normalizeNameKey = (value) => String(value || "").trim().toLowerCase();

const reserveUniqueFlowName = (reservedNames, baseName) => {
  const normalizedBase = String(baseName || "").trim() || "Flow";
  const baseKey = normalizeNameKey(normalizedBase);
  if (!reservedNames.has(baseKey)) {
    reservedNames.add(baseKey);
    return normalizedBase;
  }
  let index = 2;
  while (index < 10000) {
    const candidate = `${normalizedBase} ${index}`;
    const key = normalizeNameKey(candidate);
    if (!reservedNames.has(key)) {
      reservedNames.add(key);
      return candidate;
    }
    index += 1;
  }
  const fallback = `${normalizedBase} ${Date.now()}`;
  reservedNames.add(normalizeNameKey(fallback));
  return fallback;
};

const parseListInput = (value) =>
  String(value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

const normalizeScheduleDays = (value) => {
  if (!Array.isArray(value)) return [];
  const unique = new Set();
  for (const entry of value) {
    const day = Number(entry);
    if (!Number.isFinite(day)) continue;
    const normalized = Math.round(day);
    if (normalized < 0 || normalized > 6) continue;
    unique.add(normalized);
  }
  return [...unique].sort((a, b) => a - b);
};

const normalizeScheduleTime = (value) => {
  const text = String(value ?? "").trim();
  const match = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (!match) return "00:00";
  const hours = Number(match[1]);
  if (
    !Number.isInteger(hours) ||
    hours < 0 ||
    hours > 23
  ) {
    return "00:00";
  }
  return `${String(hours).padStart(2, "0")}:00`;
};

const normalizeMixPercent = (mix) => {
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

const getPresetForMix = (mix) => {
  const normalized = normalizeMixPercent(mix);
  const preset = MIX_PRESETS.find(
    (entry) =>
      entry.mix &&
      entry.mix.discover === normalized.discover &&
      entry.mix.mix === normalized.mix &&
      entry.mix.trending === normalized.trending
  );
  return preset?.id ?? "custom";
};

const buildCountsFromMixPercent = (size, mix) => {
  const weights = normalizeMixPercent(mix);
  const entries = [
    { key: "discover", value: weights.discover },
    { key: "mix", value: weights.mix },
    { key: "trending", value: weights.trending },
  ];
  const scaled = entries.map((entry) => ({
    ...entry,
    raw: (entry.value / 100) * size,
  }));
  const floored = scaled.map((entry) => ({
    ...entry,
    count: Math.floor(entry.raw),
    remainder: entry.raw - Math.floor(entry.raw),
  }));
  let remaining = size - floored.reduce((acc, entry) => acc + entry.count, 0);
  const ordered = [...floored].sort((a, b) => b.remainder - a.remainder);
  for (let i = 0; i < ordered.length && remaining > 0; i++) {
    ordered[i].count += 1;
    remaining -= 1;
  }
  const out = {};
  for (const entry of ordered) {
    out[entry.key] = entry.count;
  }
  return out;
};

const getFocusPercentFromStrength = (strength) =>
  FOCUS_STRENGTHS[strength] ?? FOCUS_STRENGTHS.medium;

const getFocusStrengthFromPercent = (percent) => {
  const numeric = Number(percent || 0);
  if (!Number.isFinite(numeric) || numeric <= 0) return "medium";
  const entries = Object.entries(FOCUS_STRENGTHS);
  const closest = entries.reduce((best, [key, value]) => {
    if (!best) return { key, distance: Math.abs(value - numeric) };
    const distance = Math.abs(value - numeric);
    return distance < best.distance ? { key, distance } : best;
  }, null);
  return closest?.key ?? "medium";
};

const buildCountsFromFocusPercent = (size, tagPercent, relatedPercent) => {
  const safeSize = Number.isFinite(size) && size > 0 ? size : 0;
  const tag = Math.max(0, Number(tagPercent || 0));
  const related = Math.max(0, Number(relatedPercent || 0));
  const totalPercent = tag + related;
  if (safeSize <= 0 || totalPercent <= 0) {
    return { tag: 0, related: 0, remaining: safeSize };
  }
  const targetTotal = Math.round((totalPercent / 100) * safeSize);
  const entries = [
    { key: "tag", raw: (tag / 100) * safeSize },
    { key: "related", raw: (related / 100) * safeSize },
  ];
  const floored = entries.map((entry) => ({
    ...entry,
    count: Math.floor(entry.raw),
    remainder: entry.raw - Math.floor(entry.raw),
  }));
  let remaining = targetTotal - floored.reduce((acc, entry) => acc + entry.count, 0);
  const ordered = [...floored].sort((a, b) => b.remainder - a.remainder);
  for (let i = 0; i < ordered.length && remaining > 0; i++) {
    ordered[i].count += 1;
    remaining -= 1;
  }
  const out = {};
  for (const entry of ordered) {
    out[entry.key] = entry.count;
  }
  return {
    tag: out.tag ?? 0,
    related: out.related ?? 0,
    remaining: Math.max(0, safeSize - (out.tag ?? 0) - (out.related ?? 0)),
  };
};

const buildFocusStrengthFromCounts = (size, tagCount, relatedCount) => {
  const safeSize = Number.isFinite(size) && size > 0 ? size : 0;
  if (safeSize <= 0) {
    return { tagStrength: "medium", relatedStrength: "medium" };
  }
  const tag = Math.max(0, Number(tagCount || 0));
  const related = Math.max(0, Number(relatedCount || 0));
  const totalPercent = Math.round(((tag + related) / safeSize) * 100);
  if (totalPercent <= 0) {
    return { tagStrength: "medium", relatedStrength: "medium" };
  }
  const entries = [
    { key: "tag", raw: (tag / safeSize) * 100 },
    { key: "related", raw: (related / safeSize) * 100 },
  ];
  const floored = entries.map((entry) => ({
    ...entry,
    count: Math.floor(entry.raw),
    remainder: entry.raw - Math.floor(entry.raw),
  }));
  let remaining = totalPercent - floored.reduce((acc, entry) => acc + entry.count, 0);
  const ordered = [...floored].sort((a, b) => b.remainder - a.remainder);
  for (let i = 0; i < ordered.length && remaining > 0; i++) {
    ordered[i].count += 1;
    remaining -= 1;
  }
  const out = {};
  for (const entry of ordered) {
    out[entry.key] = entry.count;
  }
  return {
    tagStrength: getFocusStrengthFromPercent(out.tag ?? 0),
    relatedStrength: getFocusStrengthFromPercent(out.related ?? 0),
  };
};

const distributeCount = (total, values) => {
  const items = values.filter(Boolean);
  if (!items.length || total <= 0) return new Map();
  const per = Math.floor(total / items.length);
  let remaining = total - per * items.length;
  const result = new Map();
  for (const item of items) {
    const extra = remaining > 0 ? 1 : 0;
    if (remaining > 0) remaining -= 1;
    result.set(item, per + extra);
  }
  return result;
};

const sumWeightMap = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
  return Object.values(value).reduce((acc, entry) => {
    const parsed = Number(entry);
    return acc + (Number.isFinite(parsed) ? parsed : 0);
  }, 0);
};

const flowToForm = (flow) => {
  const tagsMap =
    flow?.tags && typeof flow.tags === "object" && !Array.isArray(flow.tags)
      ? flow.tags
      : {};
  const relatedMap =
    flow?.relatedArtists &&
    typeof flow.relatedArtists === "object" &&
    !Array.isArray(flow.relatedArtists)
      ? flow.relatedArtists
      : {};
  const tagCount = sumWeightMap(tagsMap);
  const relatedCount = sumWeightMap(relatedMap);
  const recipeCounts =
    flow?.recipe && typeof flow.recipe === "object" && !Array.isArray(flow.recipe)
      ? flow.recipe
      : null;
  const recipeTotal = sumWeightMap(recipeCounts);
  const rawSize = Number(flow?.size || 0);
  const size =
    Number.isFinite(rawSize) && rawSize > 0
      ? rawSize
      : recipeTotal > 0
        ? recipeTotal
        : DEFAULT_SIZE;
  const mix = normalizeMixPercent(flow?.mix || DEFAULT_MIX);
  const preset = getPresetForMix(mix);
  const focusStrengths = buildFocusStrengthFromCounts(
    Number.isFinite(size) ? size : 0,
    tagCount,
    relatedCount
  );
  return {
    name: flow?.name || "",
    size: Number.isFinite(size) && size > 0 ? Math.round(size) : DEFAULT_SIZE,
    mix,
    mixPreset: preset,
    deepDive: flow?.deepDive === true,
    includeTags: Object.keys(tagsMap).join(", "),
    includeRelatedArtists: Object.keys(relatedMap).join(", "),
    tagStrength: focusStrengths.tagStrength,
    relatedStrength: focusStrengths.relatedStrength,
    scheduleDays:
      normalizeScheduleDays(flow?.scheduleDays).length > 0
        ? normalizeScheduleDays(flow?.scheduleDays)
        : [new Date().getDay()],
    scheduleTime: normalizeScheduleTime(flow?.scheduleTime),
  };
};

const buildFlowFromForm = (draft) => {
  const name = String(draft?.name ?? "").trim();
  if (!name) {
    throw new Error("Flow name is required");
  }
  const sizeValue = Number(draft?.size);
  if (!Number.isFinite(sizeValue) || sizeValue <= 0) {
    throw new Error("Total tracks must be a positive number");
  }
  const size = Math.round(sizeValue);
  const includeTags = parseListInput(draft?.includeTags);
  const includeRelatedArtists = parseListInput(draft?.includeRelatedArtists);
  const tagFocusPercent =
    includeTags.length > 0
      ? getFocusPercentFromStrength(draft?.tagStrength)
      : 0;
  const relatedFocusPercent =
    includeRelatedArtists.length > 0
      ? getFocusPercentFromStrength(draft?.relatedStrength)
      : 0;
  if (tagFocusPercent + relatedFocusPercent > 100) {
    throw new Error("Tag and related focus exceeds 100%");
  }
  const scheduleDays = normalizeScheduleDays(draft?.scheduleDays);
  if (scheduleDays.length === 0) {
    throw new Error("Select at least one day for this flow schedule");
  }
  const scheduleTime = normalizeScheduleTime(draft?.scheduleTime);
  const focusCounts = buildCountsFromFocusPercent(
    size,
    tagFocusPercent,
    relatedFocusPercent
  );
  const tagFocus = focusCounts.tag;
  const relatedFocus = focusCounts.related;
  const mix = normalizeMixPercent(draft?.mix);
  const recipe = buildCountsFromMixPercent(size, mix);
  const tags = {};
  if (tagFocus > 0 && includeTags.length > 0) {
    const tagCounts = distributeCount(tagFocus, includeTags);
    for (const [tag, count] of tagCounts.entries()) {
      if (count <= 0) continue;
      tags[tag] = count;
    }
  }
  const relatedArtists = {};
  if (relatedFocus > 0 && includeRelatedArtists.length > 0) {
    const relatedCounts = distributeCount(relatedFocus, includeRelatedArtists);
    for (const [artist, count] of relatedCounts.entries()) {
      if (count <= 0) continue;
      relatedArtists[artist] = count;
    }
  }
  return {
    name,
    size,
    mix,
    recipe,
    tags,
    relatedArtists,
    deepDive: draft?.deepDive === true,
    scheduleDays,
    scheduleTime,
  };
};

const normalizeDraftForCompare = (draft) => {
  const normalizeList = (value) =>
    parseListInput(value)
      .map((entry) => entry.toLowerCase())
      .sort((a, b) => a.localeCompare(b))
      .join(", ");
  return {
    name: String(draft?.name ?? "").trim(),
    size: Number(draft?.size ?? 0),
    mix: normalizeMixPercent(draft?.mix),
    includeTags: normalizeList(draft?.includeTags),
    includeRelatedArtists: normalizeList(draft?.includeRelatedArtists),
    tagStrength: draft?.tagStrength ?? "medium",
    relatedStrength: draft?.relatedStrength ?? "medium",
    deepDive: draft?.deepDive === true,
    scheduleDays: normalizeScheduleDays(draft?.scheduleDays),
    scheduleTime: normalizeScheduleTime(draft?.scheduleTime),
  };
};

const isFlowDirty = (flow, draft) => {
  const base = normalizeDraftForCompare(flowToForm(flow));
  const next = normalizeDraftForCompare(draft);
  return JSON.stringify(base) !== JSON.stringify(next);
};

const normalizeSharedTrackEntry = (track) => {
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
  const artistMbid = String(track.artistMbid ?? track.artistId ?? track.mbid ?? "").trim();
  return {
    artistName,
    trackName,
    albumName: albumName || null,
    artistMbid: artistMbid || null,
  };
};

const buildSharedTracklistPayload = ({ name, sourceName, sourceFlowId, tracks }) => ({
  type: FLOW_SHARE_FILE_TYPE,
  version: FLOW_SHARE_FILE_VERSION,
  exportedAt: new Date().toISOString(),
  name: String(name || "").trim() || "Shared Playlist",
  sourceName: String(sourceName || "").trim() || null,
  sourceFlowId: String(sourceFlowId || "").trim() || null,
  trackCount: Array.isArray(tracks) ? tracks.length : 0,
  tracks: (Array.isArray(tracks) ? tracks : []).map((track) => ({
    artistName: String(track.artistName || "").trim(),
    trackName: String(track.trackName || "").trim(),
    albumName: track.albumName ? String(track.albumName).trim() : null,
    artistMbid: track.artistMbid ? String(track.artistMbid).trim() : null,
  })),
});

const downloadFlowShareBundle = (fileName, payload) => {
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json",
  });
  const objectUrl = window.URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => {
    window.URL.revokeObjectURL(objectUrl);
  }, 0);
};

const parseFlowImportFile = (content) => {
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("Import file is not valid JSON");
  }

  const toPlaylistPayload = (entry, index) => {
    if (Array.isArray(entry)) {
      const tracks = entry.map(normalizeSharedTrackEntry).filter(Boolean);
      if (tracks.length === 0) {
        throw new Error(`Tracklist ${index + 1}: no valid tracks found`);
      }
      return {
        name: `Imported Playlist ${index + 1}`,
        sourceName: null,
        sourceFlowId: null,
        trackCount: tracks.length,
        tracks,
      };
    }
    if (!entry || typeof entry !== "object") {
      throw new Error(`Tracklist ${index + 1}: invalid playlist payload`);
    }
    const rawTracks = Array.isArray(entry.tracks)
      ? entry.tracks
      : Array.isArray(entry.playlist?.tracks)
        ? entry.playlist.tracks
        : null;
    if (!rawTracks?.length) {
      throw new Error(`Tracklist ${index + 1}: no tracks found`);
    }
    const tracks = rawTracks.map(normalizeSharedTrackEntry).filter(Boolean);
    if (tracks.length === 0) {
      throw new Error(`Tracklist ${index + 1}: no valid tracks found`);
    }
    return {
      name:
        String(entry.name ?? entry.playlist?.name ?? entry.sourceName ?? "").trim() ||
        `Imported Playlist ${index + 1}`,
      sourceName:
        String(entry.sourceName ?? entry.source?.name ?? "").trim() || null,
      sourceFlowId:
        String(entry.sourceFlowId ?? entry.source?.id ?? "").trim() || null,
      trackCount: tracks.length,
      tracks,
    };
  };

  let entries = [];
  if (Array.isArray(parsed)) {
    const looksLikeTrackArray = parsed.every(
      (entry) => entry && typeof entry === "object" && !Array.isArray(entry),
    );
    entries = looksLikeTrackArray ? [parsed] : parsed;
  } else if (
    parsed &&
    typeof parsed === "object" &&
    Array.isArray(parsed.playlists)
  ) {
    entries = parsed.playlists;
  } else if (
    parsed &&
    typeof parsed === "object" &&
    Array.isArray(parsed.tracks)
  ) {
    entries = [parsed];
  } else if (
    parsed &&
    typeof parsed === "object" &&
    parsed.playlist &&
    typeof parsed.playlist === "object"
  ) {
    entries = [parsed.playlist];
  } else if (parsed && typeof parsed === "object") {
    entries = [parsed];
  }

  if (!entries.length) {
    throw new Error("Import file does not contain any tracklists");
  }

  const playlists = entries
    .map((entry, index) => {
      try {
        return toPlaylistPayload(entry, index);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  if (!playlists.length) {
    throw new Error("Import file does not contain any valid tracks");
  }

  return playlists;
};

const EMPTY_FLOW_STATS = {
  total: 0,
  done: 0,
  pending: 0,
  downloading: 0,
  failed: 0,
};

const DEFAULT_WORKER_SETTINGS = {
  concurrency: 3,
  preferredFormat: "flac",
  preferredFormatStrict: false,
  retryCycleMinutes: 15,
};
const FLOW_WORKER_RETRY_CYCLE_OPTIONS = [15, 30, 60, 360, 720, 1440];

const normalizeRetryCycleMinutes = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_WORKER_SETTINGS.retryCycleMinutes;
  const normalized = Math.floor(parsed);
  if (FLOW_WORKER_RETRY_CYCLE_OPTIONS.includes(normalized)) {
    return normalized;
  }
  return DEFAULT_WORKER_SETTINGS.retryCycleMinutes;
};

const buildFlowStatsFromJobs = (jobs) => {
  const stats = { ...EMPTY_FLOW_STATS };
  if (!Array.isArray(jobs)) return stats;
  for (const job of jobs) {
    if (!job?.status) continue;
    stats[job.status] = (stats[job.status] || 0) + 1;
  }
  stats.total = stats.pending + stats.downloading + stats.done;
  return stats;
};

const sanitizeFlowStats = (stats) => {
  const pending = Number(stats?.pending || 0);
  const downloading = Number(stats?.downloading || 0);
  const done = Number(stats?.done || 0);
  const failed = Number(stats?.failed || 0);
  return {
    total: pending + downloading + done,
    pending,
    downloading,
    done,
    failed,
  };
};

function FlowPage() {
  const navigate = useNavigate();
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [confirmDisable, setConfirmDisable] = useState(null);
  const [isWorkerSettingsOpen, setIsWorkerSettingsOpen] = useState(false);
  const [workerSettingsDraft, setWorkerSettingsDraft] = useState(
    DEFAULT_WORKER_SETTINGS,
  );
  const [workerSettingsBaseline, setWorkerSettingsBaseline] = useState(
    DEFAULT_WORKER_SETTINGS,
  );
  const [savingWorkerSettings, setSavingWorkerSettings] = useState(false);
  const [optimisticEnabled, setOptimisticEnabled] = useState({});
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState(null);
  const [convertingId, setConvertingId] = useState(null);
  const [togglingId, setTogglingId] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [flowNameEditingId, setFlowNameEditingId] = useState(null);
  const [flowManageEditingId, setFlowManageEditingId] = useState(null);
  const [simpleDrafts, setSimpleDrafts] = useState({});
  const [simpleErrors, setSimpleErrors] = useState({});
  const [sharedPlaylistDrafts, setSharedPlaylistDrafts] = useState({});
  const [sharedPlaylistErrors, setSharedPlaylistErrors] = useState({});
  const [applyingFlowId, setApplyingFlowId] = useState(null);
  const [applyingFlowNameId, setApplyingFlowNameId] = useState(null);
  const [applyingSharedPlaylistId, setApplyingSharedPlaylistId] = useState(null);
  const [applyingSharedPlaylistNameId, setApplyingSharedPlaylistNameId] = useState(null);
  const [retryActionPlaylistId, setRetryActionPlaylistId] = useState(null);
  const [trackEditingId, setTrackEditingId] = useState(null);
  const [flowStatsById, setFlowStatsById] = useState({});
  const [tracksExpandedId, setTracksExpandedId] = useState(null);
  const [tracksLoadingByFlowId, setTracksLoadingByFlowId] = useState({});
  const [tracksErrorByFlowId, setTracksErrorByFlowId] = useState({});
  const [tracksByFlowId, setTracksByFlowId] = useState({});
  const [countdownNow, setCountdownNow] = useState(() => Date.now());
  const [importReview, setImportReview] = useState(null);
  const [importing, setImporting] = useState(false);
  const lastFlowWsMessageAtRef = useRef(0);
  const importInputRef = useRef(null);
  const { showSuccess, showError } = useToast();

  const fetchStatus = useCallback(async () => {
    try {
      const data = await getFlowStatus();
      setStatus(data);
    } catch {
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleFlowStatusMessage = useCallback((msg) => {
    if (msg?.type !== "weekly_flow_status") return;
    if (!msg?.status || typeof msg.status !== "object") return;
    lastFlowWsMessageAtRef.current = Date.now();
    setStatus(msg.status);
    setLoading(false);
  }, []);

  const { isConnected: isFlowSocketConnected } = useWebSocketChannel(
    "weekly-flow",
    handleFlowStatusMessage,
  );

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  useEffect(() => {
    if (isFlowSocketConnected) {
      fetchStatus();
    }
  }, [isFlowSocketConnected, fetchStatus]);

  useEffect(() => {
    const workerRunning = status?.worker?.running === true;
    const hintPhase = status?.hint?.phase;
    const inTransition = hintPhase === "preparing" || hintPhase === "downloading";
    if (!workerRunning && !inTransition) return;
    const hasRecentWsUpdate =
      Date.now() - lastFlowWsMessageAtRef.current < 20000;
    if (isFlowSocketConnected && hasRecentWsUpdate) return;
    const interval = setInterval(fetchStatus, 5000);
    return () => clearInterval(interval);
  }, [status?.worker?.running, status?.hint?.phase, isFlowSocketConnected, fetchStatus]);

  useEffect(() => {
    const interval = setInterval(() => {
      setCountdownNow(Date.now());
    }, 30000);
    return () => clearInterval(interval);
  }, []);

  const activeFlowIdsKey = useMemo(() => {
    if (!status?.worker?.running) return "";
    const activeItems = [
      ...(Array.isArray(status?.flows) ? status.flows : []),
      ...(Array.isArray(status?.sharedPlaylists) ? status.sharedPlaylists : []),
    ];
    if (!activeItems.length) return "";
    const activeIds = activeItems
      .filter((flow) => {
        const stats =
          status.flowStats?.[flow.id] || status.sharedPlaylistStats?.[flow.id];
        return (stats?.pending || 0) > 0 || (stats?.downloading || 0) > 0;
      })
      .map((flow) => flow.id)
      .sort();
    return activeIds.join("|");
  }, [
    status?.worker?.running,
    status?.flows,
    status?.sharedPlaylists,
    status?.flowStats,
    status?.sharedPlaylistStats,
  ]);

  useEffect(() => {
    if (!activeFlowIdsKey) return;
    const activeFlowIds = activeFlowIdsKey.split("|").filter(Boolean);
    if (!activeFlowIds.length) return;

    let cancelled = false;
    const fetchIncrementalJobs = async () => {
      try {
        const results = await Promise.all(
          activeFlowIds.map((flowId) =>
            getFlowJobs(flowId).then((jobs) => ({
              flowId,
              stats: buildFlowStatsFromJobs(jobs),
            })),
          ),
        );
        if (cancelled) return;
        setFlowStatsById((prev) => {
          const next = { ...prev };
          for (const result of results) {
            next[result.flowId] = result.stats;
          }
          return next;
        });
      } catch {}
    };

    fetchIncrementalJobs();
    const interval = setInterval(fetchIncrementalJobs, 15000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [activeFlowIdsKey]);

  useEffect(() => {
    const playlistIds = new Set([
      ...(Array.isArray(status?.flows) ? status.flows.map((flow) => flow.id) : []),
      ...(Array.isArray(status?.sharedPlaylists)
        ? status.sharedPlaylists.map((playlist) => playlist.id)
        : []),
    ]);
    if (playlistIds.size === 0) {
      setFlowStatsById({});
      return;
    }
    setFlowStatsById((prev) => {
      const next = {};
      for (const [flowId, stats] of Object.entries(prev)) {
        if (playlistIds.has(flowId)) {
          next[flowId] = stats;
        }
      }
      return next;
    });
  }, [status?.flows, status?.sharedPlaylists]);

  useEffect(() => {
    if (!status?.flows?.length) return;
    setSimpleDrafts((prev) => {
      const next = { ...prev };
      for (const flow of status.flows) {
        const normalized = flowToForm(flow);
        if (!next[flow.id]) {
          next[flow.id] = normalized;
          continue;
        }
        const current = next[flow.id];
        next[flow.id] = {
          ...normalized,
          ...current,
          tagStrength: current.tagStrength ?? normalized.tagStrength,
          relatedStrength: current.relatedStrength ?? normalized.relatedStrength,
        };
      }
      return next;
    });
  }, [status?.flows]);

  useEffect(() => {
    if (!status?.sharedPlaylists?.length) return;
    setSharedPlaylistDrafts((prev) => {
      const next = { ...prev };
      for (const playlist of status.sharedPlaylists) {
        if (typeof next[playlist.id] !== "string") {
          next[playlist.id] = playlist.name || "";
        }
      }
      return next;
    });
  }, [status?.sharedPlaylists]);

  const getPlaylistStats = (flowId) => {
    return sanitizeFlowStats(
      status?.flowStats?.[flowId] ||
      status?.sharedPlaylistStats?.[flowId] ||
      flowStatsById[flowId] ||
      EMPTY_FLOW_STATS,
    );
  };

  const getPlaylistState = (flowId) => {
    const stats = getPlaylistStats(flowId);
    if (stats.total === 0) return "idle";
    if (stats.downloading > 0 || stats.pending > 0) return "running";
    if (stats.done > 0) return "completed";
    return "idle";
  };

  const handleCancelSimple = (flow) => {
    setSimpleDrafts((prev) => ({
      ...prev,
      [flow.id]: flowToForm(flow),
    }));
    setSimpleErrors((prev) => {
      const next = { ...prev };
      delete next[flow.id];
      return next;
    });
    setFlowNameEditingId((prev) => (prev === flow.id ? null : prev));
    setFlowManageEditingId((prev) => (prev === flow.id ? null : prev));
  };

  const handleCancelFlowNameEdit = (flow) => {
    if (!flow?.id) return;
    setSimpleDrafts((prev) => {
      const base = prev[flow.id] ?? flowToForm(flow);
      return {
        ...prev,
        [flow.id]: {
          ...base,
          name: flow.name || "",
        },
      };
    });
    setSimpleErrors((prev) => {
      const next = { ...prev };
      delete next[flow.id];
      return next;
    });
    setFlowNameEditingId((prev) => (prev === flow.id ? null : prev));
  };

  const handleApplySimple = async (flow) => {
    setApplyingFlowId(flow.id);
    setSimpleErrors((prev) => {
      const next = { ...prev };
      delete next[flow.id];
      return next;
    });
    try {
      const draft = simpleDrafts[flow.id] || flowToForm(flow);
      const payload = buildFlowFromForm(draft);
      const response = await updateFlow(flow.id, payload);
      const updatedFlow = response?.flow || {
        ...flow,
        ...payload,
      };
      setSimpleDrafts((prev) => ({
        ...prev,
        [flow.id]: flowToForm(updatedFlow),
      }));
      setFlowNameEditingId((prev) => (prev === flow.id ? null : prev));
      setFlowManageEditingId((prev) => (prev === flow.id ? null : prev));
      showSuccess("Flow updated");
      await fetchStatus();
    } catch (err) {
      const message =
        err.response?.data?.message || err.message || "Failed to update flow";
      setSimpleErrors((prev) => ({ ...prev, [flow.id]: message }));
      showError(message);
    } finally {
      setApplyingFlowId(null);
    }
  };

  const handleApplyFlowNameEdit = async (flow) => {
    if (!flow?.id) return;
    setApplyingFlowNameId(flow.id);
    setSimpleErrors((prev) => {
      const next = { ...prev };
      delete next[flow.id];
      return next;
    });
    try {
      const currentDraft = simpleDrafts[flow.id] ?? flowToForm(flow);
      const nextName = String(currentDraft?.name ?? flow.name ?? "").trim();
      const payload = buildFlowFromForm({
        ...flowToForm(flow),
        name: nextName,
      });
      const response = await updateFlow(flow.id, payload);
      const updatedFlow = response?.flow || {
        ...flow,
        ...payload,
      };
      setSimpleDrafts((prev) => ({
        ...prev,
        [flow.id]: {
          ...(prev[flow.id] ?? flowToForm(updatedFlow)),
          name: updatedFlow.name || "",
        },
      }));
      setFlowNameEditingId((prev) => (prev === flow.id ? null : prev));
      showSuccess("Flow updated");
      await fetchStatus();
    } catch (err) {
      const message =
        err.response?.data?.message || err.message || "Failed to update flow";
      setSimpleErrors((prev) => ({ ...prev, [flow.id]: message }));
      showError(message);
    } finally {
      setApplyingFlowNameId(null);
    }
  };

  const handleCreateInline = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const uniqueName = getNextFlowName(status?.flows, NEW_FLOW_TEMPLATE.name);
      const draft = flowToForm({
        ...NEW_FLOW_TEMPLATE,
        name: uniqueName,
      });
      const payload = buildFlowFromForm(draft);
      const response = await createFlow(payload);
      const createdFlow = response?.flow;
      if (createdFlow?.id) {
        setSimpleDrafts((prev) => ({
          ...prev,
          [createdFlow.id]: flowToForm(createdFlow),
        }));
        setFlowManageEditingId(createdFlow.id);
      }
      showSuccess("Flow created");
      await fetchStatus();
    } catch (err) {
      const message =
        err.response?.data?.message || err.message || "Failed to create flow";
      showError(message);
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (flow) => {
    setConfirmDelete({
      flowId: flow.id,
      title: flow.name,
      kind: "flow",
    });
  };

  const handleConfirmDelete = async () => {
    if (!confirmDelete) return;
    setDeletingId(confirmDelete.flowId);
    try {
      if (confirmDelete.kind === "shared") {
        await deleteSharedPlaylist(confirmDelete.flowId);
        showSuccess("Shared playlist deleted");
      } else {
        await deleteFlow(confirmDelete.flowId);
        showSuccess("Flow deleted");
      }
      await fetchStatus();
    } catch (err) {
      showError(
        err.response?.data?.message ||
          err.message ||
          (confirmDelete.kind === "shared"
            ? "Failed to delete shared playlist"
            : "Failed to delete flow")
      );
    } finally {
      setDeletingId(null);
    }
    setConfirmDelete(null);
  };

  const handleToggleEnabled = async (flow, nextEnabled) => {
    setTogglingId(flow.id);
    try {
      await setFlowEnabled(flow.id, nextEnabled);
      showSuccess(nextEnabled ? "Flow enabled" : "Flow disabled");
      await fetchStatus();
    } catch (err) {
      showError(
        err.response?.data?.message || err.message || "Failed to update flow"
      );
    } finally {
      setOptimisticEnabled((prev) => {
        const next = { ...prev };
        delete next[flow.id];
        return next;
      });
      setTogglingId(null);
    }
  };

  const handleToggleRequest = (flow, nextEnabled) => {
    if (!nextEnabled) {
      setConfirmDisable({ flowId: flow.id, title: flow.name });
      return;
    }
    setOptimisticEnabled((prev) => ({ ...prev, [flow.id]: true }));
    handleToggleEnabled(flow, true);
  };

  const flowList = status?.flows || [];
  const sharedPlaylists = status?.sharedPlaylists || [];
  const effectiveFlowList = flowList.map((flow) => {
    const optimisticValue = optimisticEnabled[flow.id];
    if (typeof optimisticValue !== "boolean") return flow;
    return {
      ...flow,
      enabled: optimisticValue,
    };
  });
  const handleConfirmDisable = async () => {
    if (!confirmDisable) return;
    const flow = flowList.find((entry) => entry.id === confirmDisable.flowId);
    if (flow) {
      setOptimisticEnabled((prev) => ({ ...prev, [flow.id]: false }));
      await handleToggleEnabled(flow, false);
    }
    setConfirmDisable(null);
  };

  const getCurrentWorkerSettings = () => {
    const raw = status?.worker?.settings || {};
    const parsedConcurrency = Number(raw.concurrency);
    const concurrency =
      Number.isFinite(parsedConcurrency) && parsedConcurrency >= 1
        ? Math.min(3, Math.floor(parsedConcurrency))
        : DEFAULT_WORKER_SETTINGS.concurrency;
    const preferredFormat =
      String(raw.preferredFormat || "").toLowerCase() === "mp3"
        ? "mp3"
        : "flac";
    const preferredFormatStrict = raw.preferredFormatStrict === true;
    const retryCycleMinutes = normalizeRetryCycleMinutes(raw.retryCycleMinutes);
    return {
      concurrency,
      preferredFormat,
      preferredFormatStrict,
      retryCycleMinutes,
    };
  };

  const handleOpenWorkerSettings = () => {
    const current = getCurrentWorkerSettings();
    setWorkerSettingsBaseline(current);
    setWorkerSettingsDraft(current);
    setIsWorkerSettingsOpen(true);
  };

  const exportTracklist = async ({
    playlistId,
    playlistName,
    sourceName = null,
    sourceFlowId = null,
  }) => {
    if (!playlistId) return;
    const jobs = await getFlowJobs(playlistId, 500);
    const tracks = (Array.isArray(jobs) ? jobs : [])
      .filter((job) => job?.status !== "failed")
      .map((job) => ({
        artistName: job.artistName,
        trackName: job.trackName,
        albumName: job.albumName || null,
        artistMbid: job.artistMbid || null,
      }))
      .filter((track) => track.artistName && track.trackName);
    if (tracks.length === 0) {
      throw new Error("No generated tracks available to export yet");
    }
    downloadFlowShareBundle(
      `aurral-tracklist-${slugifyFilePart(playlistName)}.json`,
      buildSharedTracklistPayload({
        name: playlistName,
        sourceName: sourceName || playlistName,
        sourceFlowId,
        tracks,
      }),
    );
  };

  const handleExportFlow = async (flow) => {
    if (!flow) return;
    try {
      await exportTracklist({
        playlistId: flow.id,
        playlistName: flow.name,
        sourceName: flow.name,
        sourceFlowId: flow.id,
      });
      showSuccess(`Exported ${flow.name} tracklist`);
    } catch (error) {
      showError(error?.message || "Failed to export tracklist");
    }
  };

  const handleOpenImportPicker = () => {
    if (importInputRef.current) {
      importInputRef.current.value = "";
      importInputRef.current.click();
    }
  };

  const handleImportFileChange = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const content = await file.text();
      const flows = parseFlowImportFile(content).map((flow) => ({
        ...flow,
        importName: flow?.name || "",
      }));
      setImportReview({
        fileName: file.name,
        flows,
      });
    } catch (error) {
      showError(error?.message || "Failed to read tracklist file");
    } finally {
      event.target.value = "";
    }
  };

  const handleConfirmImport = async () => {
    if (!importReview || importing) return;
    setImporting(true);
    const reservedNames = new Set(
      (status?.sharedPlaylists || [])
        .map((playlist) => normalizeNameKey(playlist?.name))
        .filter(Boolean),
    );
    let importedCount = 0;
    let renamedCount = 0;
    const failed = [];

    for (const payload of importReview.flows) {
      const desiredName = String(payload?.importName ?? payload?.name ?? "").trim();
      const baseName = desiredName || String(payload?.name || "").trim();
      const finalName = reserveUniqueFlowName(reservedNames, baseName);
      if (finalName !== baseName) {
        renamedCount += 1;
      }
      try {
        await importSharedPlaylist({
          name: finalName,
          sourceName: payload?.sourceName || null,
          sourceFlowId: payload?.sourceFlowId || null,
          tracks: payload?.tracks || [],
        });
        importedCount += 1;
      } catch (error) {
        failed.push({
          name: finalName,
          message:
            error?.response?.data?.message ||
            error?.response?.data?.error ||
            error?.message ||
            "Failed to import tracklist",
        });
      }
    }

    try {
      await fetchStatus();
    } finally {
      setImporting(false);
    }

    if (importedCount > 0) {
      showSuccess(
        `${importedCount} ${importedCount === 1 ? "tracklist" : "tracklists"} imported${renamedCount > 0 ? ` • ${renamedCount} renamed` : ""}`,
      );
      setImportReview(null);
    }
    if (failed.length > 0) {
      const first = failed[0];
      showError(
        failed.length === 1
          ? `${first.name}: ${first.message}`
          : `${failed.length} imports failed. First issue: ${first.name} - ${first.message}`,
      );
    }
  };

  const handleDeleteSharedPlaylist = (playlist) => {
    if (!playlist) return;
    setConfirmDelete({
      flowId: playlist.id,
      title: playlist.name,
      kind: "shared",
    });
  };

  const handleCancelSharedPlaylistEdit = (playlist) => {
    setSharedPlaylistDrafts((prev) => ({
      ...prev,
      [playlist.id]: playlist.name || "",
    }));
    setSharedPlaylistErrors((prev) => {
      const next = { ...prev };
      delete next[playlist.id];
      return next;
    });
    setEditingId((prev) => (prev === playlist.id ? null : prev));
  };

  const handleApplySharedPlaylist = async (playlist) => {
    if (!playlist) return;
    setApplyingSharedPlaylistNameId(playlist.id);
    setSharedPlaylistErrors((prev) => {
      const next = { ...prev };
      delete next[playlist.id];
      return next;
    });
    try {
      const name = String(sharedPlaylistDrafts[playlist.id] ?? playlist.name ?? "").trim();
      const response = await updateSharedPlaylist(playlist.id, { name });
      const updatedPlaylist = response?.playlist || { ...playlist, name };
      setSharedPlaylistDrafts((prev) => ({
        ...prev,
        [playlist.id]: updatedPlaylist.name || "",
      }));
      setEditingId((prev) => (prev === playlist.id ? null : prev));
      showSuccess("Static playlist updated");
      await fetchStatus();
    } catch (err) {
      const message =
        err.response?.data?.message ||
        err.message ||
        "Failed to update static playlist";
      setSharedPlaylistErrors((prev) => ({
        ...prev,
        [playlist.id]: message,
      }));
      showError(message);
    } finally {
      setApplyingSharedPlaylistNameId(null);
    }
  };

  const handleSetRetryCyclePaused = async (playlistId, paused) => {
    if (!playlistId || retryActionPlaylistId) return;
    setRetryActionPlaylistId(playlistId);
    try {
      await setPlaylistRetryCyclePaused(playlistId, paused);
      showSuccess(paused ? "Retry cycle paused" : "Retry cycle resumed");
      await fetchStatus();
    } catch (err) {
      showError(
        err.response?.data?.message ||
          err.message ||
          "Failed to update retry cycle state",
      );
    } finally {
      setRetryActionPlaylistId(null);
    }
  };

  const handleConvertFlowToStatic = async (flow) => {
    if (!flow || convertingId) return;
    setConvertingId(flow.id);
    try {
      const reservedNames = new Set(
        (status?.sharedPlaylists || [])
          .map((playlist) => normalizeNameKey(playlist?.name))
          .filter(Boolean),
      );
      const playlistName = reserveUniqueFlowName(
        reservedNames,
        `${flow.name} Static`,
      );
      const response = await convertFlowToStaticPlaylist(flow.id, {
        name: playlistName,
      });
      showSuccess(
        `Saved ${flow.name} as static playlist${response?.playlist?.name ? `: ${response.playlist.name}` : ""}`,
      );
      await fetchStatus();
    } catch (err) {
      showError(
        err.response?.data?.message ||
          err.response?.data?.error ||
          err.message ||
          "Failed to create static playlist",
      );
    } finally {
      setConvertingId(null);
    }
  };

  const handleSaveWorkerSettings = async () => {
    const safeConcurrency = Math.min(
      5,
      Math.max(1, Math.floor(Number(workerSettingsDraft.concurrency) || 3)),
    );
    const safePreferredFormat =
      workerSettingsDraft.preferredFormat === "mp3" ? "mp3" : "flac";
    const safePreferredFormatStrict =
      workerSettingsDraft.preferredFormatStrict === true;
    const safeRetryCycleMinutes = normalizeRetryCycleMinutes(
      workerSettingsDraft.retryCycleMinutes,
    );
    const current = workerSettingsBaseline;
    const hasChanges =
      safeConcurrency !== current.concurrency ||
      safePreferredFormat !== current.preferredFormat ||
      safePreferredFormatStrict !== current.preferredFormatStrict ||
      safeRetryCycleMinutes !== current.retryCycleMinutes;
    if (!hasChanges || savingWorkerSettings) return;
    setSavingWorkerSettings(true);
    try {
      await updateFlowWorkerSettings({
        concurrency: safeConcurrency,
        preferredFormat: safePreferredFormat,
        preferredFormatStrict: safePreferredFormatStrict,
        retryCycleMinutes: safeRetryCycleMinutes,
      });
      setWorkerSettingsBaseline({
        concurrency: safeConcurrency,
        preferredFormat: safePreferredFormat,
        preferredFormatStrict: safePreferredFormatStrict,
        retryCycleMinutes: safeRetryCycleMinutes,
      });
      showSuccess("Flow worker settings updated");
      setIsWorkerSettingsOpen(false);
      await fetchStatus();
    } catch (err) {
      showError(
        err.response?.data?.message ||
          err.response?.data?.error ||
          err.message ||
          "Failed to update flow worker settings",
      );
    } finally {
      setSavingWorkerSettings(false);
    }
  };

  const retryCyclePausedByPlaylist = status?.retryCyclePausedByPlaylist || {};
  const retryCycleScheduledByPlaylist = status?.retryCycleScheduledByPlaylist || {};

  const fetchFlowTracks = async (
    flowId,
    { showSpinner = true, includeFailed = false } = {},
  ) => {
    if (!flowId) return;
    if (showSpinner) {
      setTracksLoadingByFlowId((prev) => ({ ...prev, [flowId]: true }));
    }
    setTracksErrorByFlowId((prev) => ({ ...prev, [flowId]: "" }));
    try {
      const jobs = await getFlowJobs(flowId, 500);
      const normalized = (Array.isArray(jobs) ? jobs : [])
        .filter((job) => includeFailed || job?.status !== "failed")
        .map((job) => ({
          ...job,
          albumName: job?.albumName || null,
          reason: job?.reason || null,
          streamUrl:
            job?.status === "done" && job?.id ? getFlowTrackStreamUrl(job.id) : null,
        }));
      setTracksByFlowId((prev) => ({
        ...prev,
        [flowId]: normalized,
      }));
    } catch (err) {
      const message =
        err.response?.data?.message || err.message || "Failed to load tracks";
      setTracksErrorByFlowId((prev) => ({ ...prev, [flowId]: message }));
      showError(message);
    } finally {
      if (showSpinner) {
        setTracksLoadingByFlowId((prev) => ({ ...prev, [flowId]: false }));
      }
    }
  };

  const handleToggleTracks = async (flowId, options = {}) => {
    if (!flowId) return;
    if (tracksExpandedId === flowId) {
      setTracksExpandedId(null);
      setTrackEditingId((prev) => (prev === flowId ? null : prev));
      return;
    }
    setFlowManageEditingId(null);
    setTrackEditingId(null);
    setTracksExpandedId(flowId);
    await fetchFlowTracks(flowId, options);
  };

  const handleToggleFlowNameEditing = (flow) => {
    if (!flow?.id) return;
    setSimpleDrafts((prev) => ({
      ...prev,
      [flow.id]: prev[flow.id] ?? flowToForm(flow),
    }));
    setSimpleErrors((prevErrors) => {
      const nextErrors = { ...prevErrors };
      delete nextErrors[flow.id];
      return nextErrors;
    });
    setFlowNameEditingId((prev) => (prev === flow.id ? null : flow.id));
  };

  const handleToggleEditing = (flowId) => {
    setFlowManageEditingId((prev) => {
      const next = prev === flowId ? null : flowId;
      if (next) {
        setSimpleErrors((prevErrors) => {
          const nextErrors = { ...prevErrors };
          delete nextErrors[flowId];
          return nextErrors;
        });
        setTracksExpandedId(null);
        setTrackEditingId(null);
      }
      return next;
    });
  };

  const handleToggleSharedPlaylistEditing = async (playlistId) => {
    if (!playlistId) return;
    const isClosing = editingId === playlistId;
    setEditingId(isClosing ? null : playlistId);
    if (isClosing) return;
    setSharedPlaylistErrors((prev) => {
      const next = { ...prev };
      delete next[playlistId];
      return next;
    });
  };

  const handleToggleSharedPlaylistTrackEditing = async (playlistId) => {
    if (!playlistId) return;
    if (trackEditingId === playlistId) {
      setTrackEditingId(null);
      return;
    }
    if (tracksExpandedId !== playlistId) {
      setTracksExpandedId(playlistId);
      await fetchFlowTracks(playlistId, { includeFailed: true });
    }
    setTrackEditingId(playlistId);
  };

  const handleSaveSharedPlaylistTracks = async (playlist, tracks) => {
    if (!playlist?.id) return;
    setApplyingSharedPlaylistId(playlist.id);
    try {
      await updateSharedPlaylist(playlist.id, { tracks });
      setTrackEditingId(null);
      showSuccess("Static playlist tracklist updated");
      await fetchStatus();
      await fetchFlowTracks(playlist.id, {
        showSpinner: false,
        includeFailed: true,
      });
    } catch (err) {
      const message =
        err.response?.data?.message ||
        err.response?.data?.error ||
        err.message ||
        "Failed to update static playlist tracklist";
      showError(message);
      throw new Error(message);
    } finally {
      setApplyingSharedPlaylistId(null);
    }
  };

  const handleNavigateArtist = (track) => {
    if (!track?.artistMbid) return;
    navigate(`/artist/${track.artistMbid}`, {
      state: { artistName: track.artistName },
    });
  };
  if (loading && !status) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <Loader2 className="w-8 h-8 animate-spin text-[#707e61]" />
      </div>
    );
  }
  const currentWorkerSettings = workerSettingsBaseline;
  const hasWorkerSettingsChanges =
    Number(workerSettingsDraft.concurrency) !== currentWorkerSettings.concurrency ||
    (workerSettingsDraft.preferredFormat === "mp3" ? "mp3" : "flac") !==
      currentWorkerSettings.preferredFormat ||
    (workerSettingsDraft.preferredFormatStrict === true) !==
      currentWorkerSettings.preferredFormatStrict ||
    normalizeRetryCycleMinutes(workerSettingsDraft.retryCycleMinutes) !==
      currentWorkerSettings.retryCycleMinutes;

  return (
    <div className="flow-page max-w-6xl mx-auto px-4 pb-10">
      <input
        ref={importInputRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={handleImportFileChange}
      />
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-end gap-2">
          <h2 className="text-base font-semibold text-white">Playlists / Flows</h2>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleOpenWorkerSettings}
            className="btn btn-secondary btn-sm p-2 opacity-80 hover:opacity-100"
            aria-label="Open flow worker settings"
          >
            <Settings className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={handleOpenImportPicker}
            className="btn btn-secondary btn-sm gap-2"
          >
            <Upload className="w-4 h-4" />
            Import
          </button>
          <a
            href="https://aurral.org/aurral-convert"
            target="_blank"
            rel="noreferrer"
            className="btn btn-secondary btn-sm gap-2"
          >
            <ExternalLink className="w-4 h-4" />
            Spotify Import
          </a>
          <button
            type="button"
            onClick={handleCreateInline}
            className="btn btn-primary btn-sm"
            disabled={creating}
          >
            {creating ? "Creating..." : "New Flow"}
          </button>
        </div>
      </div>

      <div className="space-y-4">
        {sharedPlaylists.length > 0 && (
          <div className="space-y-3">
            {sharedPlaylists.map((playlist) => (
              <SharedPlaylistCard
                key={playlist.id}
                playlist={playlist}
                stats={getPlaylistStats(playlist.id)}
                currentJob={status?.worker?.currentJob}
                isEditing={editingId === playlist.id}
                isTrackEditing={trackEditingId === playlist.id}
                isTracksOpen={tracksExpandedId === playlist.id}
                tracks={tracksByFlowId[playlist.id] || []}
                tracksLoading={tracksLoadingByFlowId[playlist.id] === true}
                tracksError={tracksErrorByFlowId[playlist.id] || ""}
                nameDraft={sharedPlaylistDrafts[playlist.id] ?? playlist.name ?? ""}
                nameError={sharedPlaylistErrors[playlist.id] || ""}
                isApplyingName={applyingSharedPlaylistNameId === playlist.id}
                isApplyingTracks={applyingSharedPlaylistId === playlist.id}
                artworkUrl={getFlowArtworkUrl(playlist.id)}
                deletingId={deletingId}
                onToggleEditing={() => handleToggleSharedPlaylistEditing(playlist.id)}
                onNameChange={(name) =>
                  setSharedPlaylistDrafts((prev) => ({
                    ...prev,
                    [playlist.id]: name,
                  }))
                }
                onCancelEdit={() => handleCancelSharedPlaylistEdit(playlist)}
                onApplyEdit={() => handleApplySharedPlaylist(playlist)}
                onToggleTrackEditing={() =>
                  handleToggleSharedPlaylistTrackEditing(playlist.id)
                }
                onSaveTracks={(tracks) =>
                  handleSaveSharedPlaylistTracks(playlist, tracks)
                }
                onDelete={() => handleDeleteSharedPlaylist(playlist)}
                onExport={() => handleExportFlow(playlist)}
                onViewTracks={() =>
                  handleToggleTracks(playlist.id, { includeFailed: true })
                }
                onNavigateArtist={handleNavigateArtist}
                retryCyclePaused={retryCyclePausedByPlaylist[playlist.id] === true}
                retryCycleScheduled={
                  retryCycleScheduledByPlaylist[playlist.id] === true
                }
                retryActionInFlight={retryActionPlaylistId === playlist.id}
                onSetRetryCyclePaused={(paused) =>
                  handleSetRetryCyclePaused(playlist.id, paused)
                }
              />
            ))}
          </div>
        )}

        {effectiveFlowList.length === 0 && (
          <FlowEmptyState onCreate={handleCreateInline} creating={creating} />
        )}
        {effectiveFlowList.map((flow) => {
          const stats = getPlaylistStats(flow.id);
          const state = getPlaylistState(flow.id);
          const flowSize = Number(flow?.size || 0);
          const targetTotal =
            Number.isFinite(flowSize) && flowSize > 0
              ? Math.floor(flowSize)
              : stats.total;
          const displayStats = {
            ...stats,
            total: targetTotal,
          };
          const enabled = flow.enabled === true;
          const nextRun = formatNextRun(flow.nextRunAt, countdownNow);
          const isEditing = flowManageEditingId === flow.id;
          const isNameEditing = flowNameEditingId === flow.id;
          const simpleDraft = simpleDrafts[flow.id] ?? flowToForm(flow);
          const simpleError = simpleErrors[flow.id];
          const isNameDirty =
            String(simpleDraft?.name ?? "").trim() !== String(flow?.name ?? "").trim();
          const simpleSize = Number(simpleDraft?.size ?? 0);
          const simpleMixSize = Number.isFinite(simpleSize) ? simpleSize : 0;
          const isApplying = applyingFlowId === flow.id;
          const isNameApplying = applyingFlowNameId === flow.id;
          const hasChanges = isFlowDirty(flow, simpleDraft);
          const canExport = Number(stats?.total || 0) > 0;
          const canConvertToStatic = Number(stats?.done || 0) > 0;
          return (
            <FlowCard
              key={flow.id}
              flow={flow}
              enabled={enabled}
              state={state}
              stats={displayStats}
              currentJob={status?.worker?.currentJob}
              statusHint={status?.hint}
              operationQueue={status?.operationQueue}
              nextRun={nextRun}
              isEditing={isEditing}
              isNameEditing={isNameEditing}
              isNameDirty={isNameDirty}
              isNameApplying={isNameApplying}
              isTracksOpen={tracksExpandedId === flow.id}
              tracks={tracksByFlowId[flow.id] || []}
              tracksLoading={tracksLoadingByFlowId[flow.id] === true}
              tracksError={tracksErrorByFlowId[flow.id] || ""}
              simpleDraft={simpleDraft}
              simpleRemaining={simpleMixSize}
              simpleError={simpleError}
              isApplying={isApplying}
              hasChanges={hasChanges}
              artworkUrl={getFlowArtworkUrl(flow.id)}
              canExport={canExport}
              canConvertToStatic={canConvertToStatic}
              convertingId={convertingId}
              togglingId={togglingId}
              deletingId={deletingId}
              onExport={() => handleExportFlow(flow)}
              onConvertToStatic={() => handleConvertFlowToStatic(flow)}
              onToggleNameEditing={() => handleToggleFlowNameEditing(flow)}
              onToggleEditing={() => handleToggleEditing(flow.id)}
              onToggleEnabled={(checked) => handleToggleRequest(flow, checked)}
              onDelete={() => handleDelete(flow)}
              onViewTracks={() => handleToggleTracks(flow.id)}
              onNavigateArtist={handleNavigateArtist}
              onNameCancel={() => handleCancelFlowNameEdit(flow)}
              onNameApply={() => handleApplyFlowNameEdit(flow)}
              onCancel={() => handleCancelSimple(flow)}
              onApply={() => handleApplySimple(flow)}
              onDraftChange={(updater) =>
                setSimpleDrafts((prev) => {
                  const base = prev[flow.id] ?? simpleDraft;
                  return { ...prev, [flow.id]: updater(base) };
                })
              }
              onClearError={() => {
                if (simpleErrors[flow.id]) {
                  setSimpleErrors((prev) => {
                    const next = { ...prev };
                    delete next[flow.id];
                    return next;
                  });
                }
              }}
              mixPresets={MIX_PRESETS}
              focusOptions={FOCUS_OPTIONS}
              normalizeMixPercent={normalizeMixPercent}
            />
          );
        })}
      </div>

      <ConfirmDeleteModal
        confirmDelete={confirmDelete}
        deletingId={deletingId}
        onCancel={() => setConfirmDelete(null)}
        onConfirm={handleConfirmDelete}
      />
      <ConfirmDisableModal
        confirmDisable={confirmDisable}
        togglingId={togglingId}
        onCancel={() => setConfirmDisable(null)}
        onConfirm={handleConfirmDisable}
      />
      <FlowWorkerSettingsModal
        isOpen={isWorkerSettingsOpen}
        settings={workerSettingsDraft}
        hasChanges={hasWorkerSettingsChanges}
        saving={savingWorkerSettings}
        onCancel={() => {
          if (savingWorkerSettings) return;
          setIsWorkerSettingsOpen(false);
        }}
        onChange={setWorkerSettingsDraft}
        onSave={handleSaveWorkerSettings}
      />
      <FlowImportReviewModal
        importReview={importReview}
        importing={importing}
        onNameChange={(index, name) => {
          setImportReview((prev) => {
            if (!prev || !Array.isArray(prev.flows)) return prev;
            const nextFlows = prev.flows.map((flow, flowIndex) =>
              flowIndex === index ? { ...flow, importName: name } : flow,
            );
            return {
              ...prev,
              flows: nextFlows,
            };
          });
        }}
        onCancel={() => {
          if (importing) return;
          setImportReview(null);
        }}
        onConfirm={handleConfirmImport}
      />
    </div>
  );
}

export default FlowPage;

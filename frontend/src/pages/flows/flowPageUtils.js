import { parseFlowTimestamp } from "./flowStats";
import { formatDate } from "../../utils/dateTime.js";

export const DEFAULT_MIX = { discover: 34, mix: 33, trending: 33, focus: 0 };
export const DEFAULT_SIZE = 30;

export const NEW_FLOW_TEMPLATE = {
  name: "Discover",
  size: DEFAULT_SIZE,
  mix: DEFAULT_MIX,
  deepDive: false,
  recordHistory: true,
  yearFrom: null,
  yearTo: null,
  tags: [],
  relatedArtists: [],
  scheduleTime: "00:00",
};

const FLOW_SHARE_FILE_VERSION = 1;
const FLOW_SHARE_FILE_TYPE = "aurral-static-tracklist";

function getNextRunDiff(nextRunAt, now = Date.now()) {
  if (!nextRunAt) return null;
  const ts = parseFlowTimestamp(nextRunAt);
  if (!Number.isFinite(ts)) return null;
  return ts - now;
}

export function formatNextRun(nextRunAt, now = Date.now()) {
  const diff = getNextRunDiff(nextRunAt, now);
  if (diff === null) return null;
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

export function formatNextRunShort(nextRunAt, now = Date.now()) {
  const diff = getNextRunDiff(nextRunAt, now);
  if (diff === null) return null;
  if (diff <= 0) return "soon";
  const dayMs = 24 * 60 * 60 * 1000;
  const days = Math.ceil(diff / dayMs);
  if (days >= 1) {
    return `${days}d`;
  }
  return "soon";
}

export function formatFlowLastRunShort(lastRunAt) {
  const timestamp = parseFlowTimestamp(lastRunAt);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  return formatDate(date, { month: "numeric", day: "numeric" });
}

export const slugifyFilePart = (value, fallback = "flow") => {
  const slug = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || fallback;
};

export const normalizeNameKey = (value) =>
  String(value || "")
    .trim()
    .toLowerCase();

export const reserveUniqueFlowName = (reservedNames, baseName) => {
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

export const getNextFlowName = (flows, baseName = "Discover") =>
  reserveUniqueFlowName(
    new Set(
      (Array.isArray(flows) ? flows : [])
        .map((flow) => normalizeNameKey(flow?.name))
        .filter(Boolean),
    ),
    String(baseName || "").trim() || "Discover",
  );

export const normalizeDurationMs = (value) => {
  const numeric = Number(value);
  return value != null && Number.isFinite(numeric) ? Math.max(0, Math.round(numeric)) : null;
};

export const normalizeArtistAliases = (aliases) =>
  Array.isArray(aliases) ? aliases.map((entry) => String(entry || "").trim()).filter(Boolean) : [];

const parseListInput = (value) =>
  String(value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

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

export const normalizeFlowEntryList = (value) => {
  const raw = Array.isArray(value)
    ? value
    : value && typeof value === "object"
      ? Object.keys(value)
      : value == null
        ? []
        : [value];
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

export const normalizeScheduleDays = (value) => {
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

export const normalizeScheduleTime = (value) => {
  const text = String(value ?? "").trim();
  const match = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (!match) return "00:00";
  const hours = Number(match[1]);
  if (!Number.isInteger(hours) || hours < 0 || hours > 23) {
    return "00:00";
  }
  return `${String(hours).padStart(2, "0")}:00`;
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

const parseOptionalYearInput = (value, label) => {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const parsed = Number(text);
  if (!Number.isFinite(parsed) || Math.trunc(parsed) < 1000 || Math.trunc(parsed) > 9999) {
    throw new Error(`${label} must be a 4-digit year`);
  }
  return Math.trunc(parsed);
};

export const normalizeMixPercent = (mix) => {
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

export const flowToForm = (flow) => {
  const tagsList = normalizeFlowEntryList(flow?.tags);
  const relatedList = normalizeFlowEntryList(flow?.relatedArtists);
  const scheduleDays = normalizeScheduleDays(flow?.scheduleDays);
  const rawSize = Number(flow?.size || 0);
  const size = Number.isFinite(rawSize) && rawSize > 0 ? rawSize : DEFAULT_SIZE;
  const mix = normalizeMixPercent(flow?.mix || DEFAULT_MIX);
  const { yearFrom, yearTo } = normalizeYearRange(flow?.yearFrom, flow?.yearTo);
  return {
    name: flow?.name || "",
    size: Number.isFinite(size) && size > 0 ? Math.round(size) : DEFAULT_SIZE,
    mix,
    deepDive: flow?.deepDive === true,
    recordHistory: flow?.recordHistory !== false,
    yearFrom: yearFrom == null ? "" : String(yearFrom),
    yearTo: yearTo == null ? "" : String(yearTo),
    includeTags: tagsList.join(", "),
    includeRelatedArtists: relatedList.join(", "),
    scheduleDays: scheduleDays.length > 0 ? scheduleDays : [new Date().getDay()],
    scheduleTime: normalizeScheduleTime(flow?.scheduleTime),
  };
};

export const buildFlowFromForm = (draft) => {
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
  const scheduleDays = normalizeScheduleDays(draft?.scheduleDays);
  if (scheduleDays.length === 0) {
    throw new Error("Select at least one day for this flow schedule");
  }
  const scheduleTime = normalizeScheduleTime(draft?.scheduleTime);
  const mix = normalizeMixPercent(draft?.mix);
  const focusEnabled = Number(mix.focus || 0) > 0;
  if (focusEnabled && includeTags.length === 0 && includeRelatedArtists.length === 0) {
    throw new Error("Focus needs at least one genre tag or related artist");
  }
  const { yearFrom, yearTo } = normalizeYearRange(
    parseOptionalYearInput(draft?.yearFrom, "From year"),
    parseOptionalYearInput(draft?.yearTo, "To year"),
  );
  return {
    name,
    size,
    mix,
    tags: includeTags,
    relatedArtists: includeRelatedArtists,
    deepDive: draft?.deepDive === true,
    recordHistory: draft?.recordHistory !== false,
    yearFrom,
    yearTo,
    scheduleDays,
    scheduleTime,
  };
};

export const getUnavailableFlowSourceMessage = (draft, disabledSources = {}) => {
  const mix = normalizeMixPercent(draft?.mix);
  for (const [source, reason] of Object.entries(disabledSources || {})) {
    if (Number(mix?.[source] || 0) > 0 && reason) {
      return reason;
    }
  }
  return "";
};

const normalizeDraftForCompare = (draft) => {
  const normalizeList = (value) =>
    parseListInput(value)
      .map((entry) => entry.toLowerCase())
      .sort((a, b) => a.localeCompare(b))
      .join(", ");
  const { yearFrom, yearTo } = normalizeYearRange(draft?.yearFrom, draft?.yearTo);
  return {
    name: String(draft?.name ?? "").trim(),
    size: Number(draft?.size ?? 0),
    mix: normalizeMixPercent(draft?.mix),
    includeTags: normalizeList(draft?.includeTags),
    includeRelatedArtists: normalizeList(draft?.includeRelatedArtists),
    deepDive: draft?.deepDive === true,
    recordHistory: draft?.recordHistory !== false,
    yearFrom,
    yearTo,
    scheduleDays: normalizeScheduleDays(draft?.scheduleDays),
    scheduleTime: normalizeScheduleTime(draft?.scheduleTime),
  };
};

export const isFlowDirty = (flow, draft) => {
  const base = normalizeDraftForCompare(flowToForm(flow));
  const next = normalizeDraftForCompare(draft);
  return JSON.stringify(base) !== JSON.stringify(next);
};

const normalizeScheduleDraftForCompare = (draft) => ({
  size: Number(draft?.size ?? 0),
  recordHistory: draft?.recordHistory !== false,
  scheduleDays: normalizeScheduleDays(draft?.scheduleDays),
  scheduleTime: normalizeScheduleTime(draft?.scheduleTime),
});

export const isScheduleOnlyFlowDirty = (flow, draft) => {
  const base = normalizeScheduleDraftForCompare(flowToForm(flow));
  const next = normalizeScheduleDraftForCompare(draft);
  return JSON.stringify(base) !== JSON.stringify(next);
};

export const buildScheduleOnlyFlowFromForm = (flow, draft, { sizeError, extra = {} } = {}) => {
  const sizeValue = Number(draft?.size);
  if (!Number.isFinite(sizeValue) || sizeValue <= 0) {
    throw new Error(sizeError || "Tracks must be a positive number");
  }
  const scheduleDays = normalizeScheduleDays(draft?.scheduleDays);
  if (scheduleDays.length === 0) {
    throw new Error("Select at least one day for this flow schedule");
  }
  return {
    name: String(flow?.name ?? "").trim(),
    size: Math.round(sizeValue),
    mix: flow?.mix || DEFAULT_MIX,
    tags: normalizeFlowEntryList(flow?.tags),
    relatedArtists: normalizeFlowEntryList(flow?.relatedArtists),
    deepDive: flow?.deepDive === true,
    recordHistory: draft?.recordHistory !== false,
    yearFrom: flow?.yearFrom ?? null,
    yearTo: flow?.yearTo ?? null,
    scheduleDays,
    scheduleTime: normalizeScheduleTime(draft?.scheduleTime),
    ...extra,
  };
};

export const buildEditorialFlowFromForm = (flow, draft) =>
  buildScheduleOnlyFlowFromForm(flow, draft, {
    sizeError: "Tracks must be a positive number",
    extra: { tag: flow?.tag || null },
  });

export const buildReleaseRadarFlowFromForm = (flow, draft) =>
  buildScheduleOnlyFlowFromForm(flow, draft, {
    sizeError: "Max tracks must be a positive number",
  });

export const normalizeSharedTrackEntry = (track) => {
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
  return {
    artistName,
    trackName,
    albumName: albumName || null,
    artistMbid: artistMbid || null,
    albumMbid: albumMbid || null,
    trackMbid: trackMbid || null,
    releaseYear: releaseYear || null,
    durationMs: normalizeDurationMs(track.durationMs),
    artistAliases: normalizeArtistAliases(track.artistAliases),
    reason: track.reason ? String(track.reason).trim() : null,
  };
};

export const buildSharedTracklistPayload = ({ name, sourceName, sourceFlowId, tracks }) => ({
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
    albumMbid: track.albumMbid ? String(track.albumMbid).trim() : null,
    trackMbid: track.trackMbid ? String(track.trackMbid).trim() : null,
    releaseYear: track.releaseYear ? String(track.releaseYear).trim() : null,
    durationMs: normalizeDurationMs(track.durationMs),
    artistAliases: normalizeArtistAliases(track.artistAliases),
  })),
});

export const downloadFlowShareBundle = (fileName, payload) => {
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

export const parseFlowImportFile = (content) => {
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
      sourceName: String(entry.sourceName ?? entry.source?.name ?? "").trim() || null,
      sourceFlowId: String(entry.sourceFlowId ?? entry.source?.id ?? "").trim() || null,
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
  } else if (parsed && typeof parsed === "object" && Array.isArray(parsed.playlists)) {
    entries = parsed.playlists;
  } else if (parsed && typeof parsed === "object" && Array.isArray(parsed.tracks)) {
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

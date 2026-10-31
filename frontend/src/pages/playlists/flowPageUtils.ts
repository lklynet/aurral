import { parseFlowTimestamp } from "./playlistStats";
import type { Flow } from "./playlistStats";
import { formatDate } from "../../utils/dateTime.ts";
import {
  DEFAULT_FLOW_MIX,
  FLOW_SOURCES,
  splitFlowTotal,
  type FlowMix,
} from "../../../../lib/flows.ts";

export interface FlowDraft {
  name?: string;
  counts: FlowMix;
  includeTags?: string;
  includeRelatedArtists?: string;
  recentListening?: boolean;
  deepDive?: boolean;
  recordHistory?: boolean;
  yearFrom?: string;
  yearTo?: string;
  scheduleDays?: number[];
  scheduleTime?: string;
}

interface ImportedTrack {
  artistName?: unknown;
  artist?: unknown;
  artist_name?: unknown;
  trackName?: unknown;
  title?: unknown;
  name?: unknown;
  track?: unknown;
  albumName?: unknown;
  album?: unknown;
  artistMbid?: unknown;
  artistId?: unknown;
  albumMbid?: unknown;
  releaseGroupMbid?: unknown;
  albumId?: unknown;
  trackMbid?: unknown;
  recordingMbid?: unknown;
  recordingId?: unknown;
  mbid?: unknown;
  releaseYear?: unknown;
  year?: unknown;
  durationMs?: unknown;
  artistAliases?: unknown;
  reason?: unknown;
  releaseMbid?: unknown;
  trackNumber?: unknown;
  discNumber?: unknown;
}

type ImportedValue = ImportedTrack | string | number | boolean | unknown[] | null | undefined;

interface FlowEntryObject {
  name?: unknown;
  artistName?: unknown;
  artist?: unknown;
  tag?: unknown;
  label?: unknown;
  value?: unknown;
}

export const DEFAULT_SIZE = 30;

const NO_TRACKS: FlowMix = { discover: 0, mix: 0, trending: 0, focus: 0, newReleases: 0 };

export const NEW_FLOW_TEMPLATE = { name: "Discover", size: DEFAULT_SIZE, mix: DEFAULT_FLOW_MIX };

function getNextRunDiff(nextRunAt: number | null | undefined, now = Date.now()) {
  if (!nextRunAt) return null;
  const ts = parseFlowTimestamp(nextRunAt);
  if (!Number.isFinite(ts)) return null;
  return ts - now;
}

export function formatNextRun(nextRunAt: number | null | undefined, now = Date.now()) {
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

export function formatNextRunShort(nextRunAt: number | null | undefined, now = Date.now()) {
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

export function formatFlowLastRunShort(lastRunAt: number | null | undefined) {
  const timestamp = parseFlowTimestamp(lastRunAt);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  return formatDate(date, { month: "numeric", day: "numeric" });
}

export const normalizeNameKey = (value: string | null | undefined) =>
  String(value || "")
    .trim()
    .toLowerCase();

export const reserveUniqueName = (
  reservedNames: Set<string>,
  baseName: string | null | undefined,
) => {
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

export const getNextFlowName = (flows: Partial<Flow>[] | null | undefined, baseName = "Discover") =>
  reserveUniqueName(
    new Set(
      (Array.isArray(flows) ? flows : [])
        .map((flow) => normalizeNameKey(flow?.name))
        .filter(Boolean),
    ),
    String(baseName || "").trim() || "Discover",
  );

export const normalizeDurationMs = (value: unknown) => {
  const numeric = Number(value);
  return value != null && Number.isFinite(numeric) ? Math.max(0, Math.round(numeric)) : null;
};

export const normalizeArtistAliases = (aliases: unknown) =>
  Array.isArray(aliases) ? aliases.map((entry) => String(entry || "").trim()).filter(Boolean) : [];

const parseListInput = (value: string | null | undefined) =>
  String(value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

const getFlowEntryName = (value: string | number | FlowEntryObject | null | undefined) => {
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

export const normalizeFlowEntryList = (value: unknown) => {
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

export const normalizeScheduleDays = (value: unknown): number[] => {
  if (!Array.isArray(value)) return [];
  const unique = new Set<number>();
  for (const entry of value) {
    const day = Number(entry);
    if (!Number.isFinite(day)) continue;
    const normalized = Math.round(day);
    if (normalized < 0 || normalized > 6) continue;
    unique.add(normalized);
  }
  return [...unique].sort((a, b) => a - b);
};

export const normalizeScheduleTime = (value: unknown) => {
  const text = String(value ?? "").trim();
  const match = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (!match) return "00:00";
  const hours = Number(match[1]);
  if (!Number.isInteger(hours) || hours < 0 || hours > 23) {
    return "00:00";
  }
  return `${String(hours).padStart(2, "0")}:00`;
};

export const normalizeYearBound = (value: unknown) => {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const year = Math.trunc(parsed);
  if (year < 1000 || year > 9999) return null;
  return year;
};

export const normalizeYearRange = (yearFrom: unknown, yearTo: unknown) => {
  let from = normalizeYearBound(yearFrom);
  let to = normalizeYearBound(yearTo);
  if (from != null && to != null && from > to) {
    const swap = from;
    from = to;
    to = swap;
  }
  return { yearFrom: from, yearTo: to };
};

const parseOptionalYearInput = (value: unknown, label: string) => {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const parsed = Number(text);
  if (!Number.isFinite(parsed) || Math.trunc(parsed) < 1000 || Math.trunc(parsed) > 9999) {
    throw new Error(`${label} must be a 4-digit year`);
  }
  return Math.trunc(parsed);
};

export const flowToForm = (flow: Partial<Flow> | null | undefined) => {
  const tagsList = normalizeFlowEntryList(flow?.tags);
  const relatedList = normalizeFlowEntryList(flow?.relatedArtists);
  const scheduleDays = normalizeScheduleDays(flow?.scheduleDays);
  const rawSize = Number(flow?.size || 0);
  const size = Number.isFinite(rawSize) && rawSize > 0 ? Math.round(rawSize) : DEFAULT_SIZE;
  const { yearFrom, yearTo } = normalizeYearRange(flow?.yearFrom, flow?.yearTo);
  return {
    name: flow?.name || "",
    counts: splitFlowTotal(flow?.mix, size) ?? { ...NO_TRACKS },
    recentListening: flow?.recentListening === true,
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

export const flowDraftTotal = (draft: FlowDraft) =>
  FLOW_SOURCES.reduce((total, source) => total + draft.counts[source], 0);

export const FOCUS_NEEDS_SEEDS = "Focus needs a tag, a similar artist, or recent listening.";

export const focusNeedsSeeds = (draft: FlowDraft) =>
  draft.counts.focus > 0 &&
  draft.recentListening !== true &&
  parseListInput(draft.includeTags).length === 0 &&
  parseListInput(draft.includeRelatedArtists).length === 0;

export const buildFlowFromForm = (draft: FlowDraft) => {
  const name = String(draft.name ?? "").trim();
  if (!name) {
    throw new Error("Flow name is required");
  }
  const size = flowDraftTotal(draft);
  if (size <= 0) {
    throw new Error("Turn on at least one source");
  }
  const scheduleDays = normalizeScheduleDays(draft.scheduleDays);
  if (scheduleDays.length === 0) {
    throw new Error("Select at least one day for this flow schedule");
  }
  if (focusNeedsSeeds(draft)) {
    throw new Error(FOCUS_NEEDS_SEEDS);
  }
  const { yearFrom, yearTo } = normalizeYearRange(
    parseOptionalYearInput(draft.yearFrom, "From year"),
    parseOptionalYearInput(draft.yearTo, "To year"),
  );
  return {
    name,
    size,
    mix: draft.counts,
    tags: parseListInput(draft.includeTags),
    relatedArtists: parseListInput(draft.includeRelatedArtists),
    recentListening: draft.recentListening === true,
    deepDive: draft.deepDive === true,
    recordHistory: draft.recordHistory !== false,
    yearFrom,
    yearTo,
    scheduleDays,
    scheduleTime: normalizeScheduleTime(draft.scheduleTime),
  };
};

const normalizeDraftForCompare = (draft: FlowDraft) => {
  const normalizeList = (value: string | null | undefined) =>
    parseListInput(value)
      .map((entry) => entry.toLowerCase())
      .sort((a, b) => a.localeCompare(b))
      .join(", ");
  const { yearFrom, yearTo } = normalizeYearRange(draft.yearFrom, draft.yearTo);
  return {
    name: String(draft.name ?? "").trim(),
    counts: FLOW_SOURCES.map((source) => draft.counts[source]),
    includeTags: normalizeList(draft.includeTags),
    includeRelatedArtists: normalizeList(draft.includeRelatedArtists),
    recentListening: draft.recentListening === true,
    deepDive: draft.deepDive === true,
    recordHistory: draft.recordHistory !== false,
    yearFrom,
    yearTo,
    scheduleDays: normalizeScheduleDays(draft.scheduleDays),
    scheduleTime: normalizeScheduleTime(draft.scheduleTime),
  };
};

export const isFlowDirty = (flow: Partial<Flow> | null | undefined, draft: FlowDraft) => {
  const base = normalizeDraftForCompare(flowToForm(flow));
  const next = normalizeDraftForCompare(draft);
  return JSON.stringify(base) !== JSON.stringify(next);
};

const positiveInteger = (value: unknown) =>
  Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;

const albumPlacement = (track: ImportedTrack | null | undefined) => ({
  releaseMbid: String(track?.releaseMbid || "").trim() || null,
  trackNumber: positiveInteger(track?.trackNumber),
  discNumber: positiveInteger(track?.discNumber),
});

export const normalizePlaylistTrackEntry = (track: ImportedValue) => {
  if (!track || typeof track !== "object" || Array.isArray(track)) return null;
  const artistName = String(track.artistName ?? track.artist ?? track.artist_name ?? "").trim();
  const trackName = String(
    track.trackName ?? track.title ?? track.name ?? track.track ?? "",
  ).trim();
  if (!artistName || !trackName) return null;
  const albumName = String(track.albumName ?? track.album ?? "").trim();
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
    ...albumPlacement(track),
  };
};

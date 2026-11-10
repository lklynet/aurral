import { parseFlowTimestamp } from "../../utils/playlistStats";
import { normalizeNameKey, reserveUniqueName } from "../../utils/staticPlaylists.ts";
import type { Flow } from "../../utils/playlistStats";
import {
  DEFAULT_FLOW_MIX,
  DEFAULT_FLOW_SIZE,
  FLOW_SOURCES,
  normalizeScheduleDays,
  normalizeScheduleTime,
  normalizeTextList,
  normalizeYearRange,
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
  autoDownload?: boolean;
  showInLibrary?: boolean;
  yearFrom?: string;
  yearTo?: string;
  scheduleDays?: number[];
  scheduleTime?: string;
}

const NO_TRACKS: FlowMix = { discover: 0, mix: 0, trending: 0, focus: 0, newReleases: 0 };

export const NEW_FLOW_TEMPLATE = {
  name: "Discover",
  size: DEFAULT_FLOW_SIZE,
  mix: DEFAULT_FLOW_MIX,
};

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

export const getNextFlowName = (flows: Partial<Flow>[] | null | undefined, baseName = "Discover") =>
  reserveUniqueName(
    new Set(
      (Array.isArray(flows) ? flows : [])
        .map((flow) => normalizeNameKey(flow?.name))
        .filter(Boolean),
    ),
    String(baseName || "").trim() || "Discover",
  );

const parseListInput = (value: string | null | undefined) =>
  String(value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

export const parseTagInput = (value: string | null | undefined) => {
  const entries = parseListInput(value);
  return {
    tags: entries.filter((entry) => !entry.startsWith("-")),
    excludeTags: entries
      .filter((entry) => entry.startsWith("-"))
      .map((entry) => entry.slice(1).trim())
      .filter(Boolean),
  };
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
  const tagsList = [
    ...normalizeTextList(flow?.tags),
    ...normalizeTextList(flow?.excludeTags).map((tag) => `-${tag}`),
  ];
  const relatedList = normalizeTextList(flow?.relatedArtists);
  const scheduleDays = normalizeScheduleDays(flow?.scheduleDays);
  const rawSize = Number(flow?.size || 0);
  const size = Number.isFinite(rawSize) && rawSize > 0 ? Math.round(rawSize) : DEFAULT_FLOW_SIZE;
  const { yearFrom, yearTo } = normalizeYearRange(flow?.yearFrom, flow?.yearTo);
  return {
    name: flow?.name || "",
    counts: splitFlowTotal(flow?.mix, size) ?? { ...NO_TRACKS },
    recentListening: flow?.recentListening === true,
    deepDive: flow?.deepDive === true,
    recordHistory: flow?.recordHistory !== false,
    autoDownload: flow?.autoDownload !== false,
    showInLibrary: flow?.showInLibrary === true,
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
  parseTagInput(draft.includeTags).tags.length === 0 &&
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
    ...parseTagInput(draft.includeTags),
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
    autoDownload: draft.autoDownload !== false,
    showInLibrary: draft.showInLibrary === true,
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

export const newBlankFlow = (flows: Partial<Flow>[]) =>
  buildFlowFromForm(
    flowToForm({ ...NEW_FLOW_TEMPLATE, name: getNextFlowName(flows, NEW_FLOW_TEMPLATE.name) }),
  );

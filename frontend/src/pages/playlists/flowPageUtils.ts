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
  type FlowSource,
} from "../../../../lib/flows.ts";

export interface FlowDraft {
  name?: string;
  counts: FlowMix;
  includeTags?: string;
  excludeTags?: string;
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

export const YEAR_INPUT_ERROR = "Use a 4-digit year";

const isYearInputValid = (value: unknown) => {
  const text = String(value ?? "").trim();
  if (!text) return true;
  const parsed = Number(text);
  return Number.isFinite(parsed) && Math.trunc(parsed) >= 1000 && Math.trunc(parsed) <= 9999;
};

export const draftYearsInvalid = (draft: FlowDraft) =>
  !isYearInputValid(draft.yearFrom) || !isYearInputValid(draft.yearTo);

export const flowToForm = (flow: Partial<Flow> | null | undefined) => {
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
    includeTags: normalizeTextList(flow?.tags).join(", "),
    excludeTags: normalizeTextList(flow?.excludeTags).join(", "),
    includeRelatedArtists: relatedList.join(", "),
    scheduleDays: scheduleDays.length > 0 ? scheduleDays : [new Date().getDay()],
    scheduleTime: normalizeScheduleTime(flow?.scheduleTime),
  };
};

export const flowDraftTotal = (draft: FlowDraft) =>
  FLOW_SOURCES.reduce((total, source) => total + draft.counts[source], 0);

export const FOCUS_NEEDS_SEEDS =
  "Artists and tags needs an artist, a tag under Filters, or recent listening.";

export const focusNeedsSeeds = (draft: FlowDraft) =>
  draft.counts.focus > 0 &&
  draft.recentListening !== true &&
  parseListInput(draft.includeTags).length === 0 &&
  parseListInput(draft.includeRelatedArtists).length === 0;

export const buildFlowFromForm = (draft: FlowDraft) => {
  const name = String(draft.name ?? "").trim();
  if (!name) {
    throw new Error("Give this flow a name.");
  }
  const size = flowDraftTotal(draft);
  if (size <= 0) {
    throw new Error("Add tracks from at least one source.");
  }
  const scheduleDays = normalizeScheduleDays(draft.scheduleDays);
  if (scheduleDays.length === 0) {
    throw new Error("Pick at least one day to refresh on.");
  }
  if (focusNeedsSeeds(draft)) {
    throw new Error(FOCUS_NEEDS_SEEDS);
  }
  if (draftYearsInvalid(draft)) {
    throw new Error(YEAR_INPUT_ERROR);
  }
  const { yearFrom, yearTo } = normalizeYearRange(draft.yearFrom, draft.yearTo);
  return {
    name,
    size,
    mix: draft.counts,
    tags: parseListInput(draft.includeTags),
    excludeTags: parseListInput(draft.excludeTags),
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
    excludeTags: normalizeList(draft.excludeTags),
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

type FlowRecipe = {
  mix?: Partial<Record<FlowSource, unknown>> | null;
  relatedArtists?: unknown;
  recentListening?: boolean | null;
  tags?: unknown;
  excludeTags?: unknown;
  yearFrom?: unknown;
  yearTo?: unknown;
};

const listFormat = new Intl.ListFormat("en", { type: "conjunction" });

const SOURCE_ALONE: Record<Exclude<FlowSource, "focus">, string> = {
  discover: "Your recommendations",
  mix: "Artists in your Library",
  trending: "Trending this week",
  newReleases: "New releases you're missing",
};

const SOURCE_SHORT: Record<FlowSource, string> = {
  discover: "Recommendations",
  mix: "Library",
  trending: "Trending",
  focus: "Similar artists",
  newReleases: "New releases",
};

export const draftRecipe = (draft: FlowDraft): FlowRecipe => ({
  mix: draft.counts,
  relatedArtists: parseListInput(draft.includeRelatedArtists),
  recentListening: draft.recentListening,
  tags: parseListInput(draft.includeTags),
  excludeTags: parseListInput(draft.excludeTags),
  yearFrom: draft.yearFrom,
  yearTo: draft.yearTo,
});

export function describeFlowRecipe(flow: FlowRecipe) {
  const sources = FLOW_SOURCES.filter((source) => Number(flow.mix?.[source] ?? 0) > 0);
  const seeds = [
    ...normalizeTextList(flow.relatedArtists),
    ...(flow.recentListening === true ? ["your recent listening"] : []),
  ];
  const [only, ...others] = sources;
  const sourcePart = !only
    ? ""
    : others.length > 0
      ? listFormat.format(
          sources.map((source) =>
            source === "focus" && seeds.length === 0 ? "Your tags" : SOURCE_SHORT[source],
          ),
        )
      : only !== "focus"
        ? SOURCE_ALONE[only]
        : seeds.length > 0
          ? `Similar to ${listFormat.format(seeds)}`
          : "Your tags";
  const tags = normalizeTextList(flow.tags);
  const excluded = normalizeTextList(flow.excludeTags);
  const { yearFrom, yearTo } = normalizeYearRange(flow.yearFrom, flow.yearTo);
  const years =
    yearFrom != null && yearTo != null
      ? yearFrom === yearTo
        ? String(yearFrom)
        : `${yearFrom} to ${yearTo}`
      : yearFrom != null
        ? `${yearFrom} and later`
        : yearTo != null
          ? `${yearTo} and earlier`
          : "";
  return [
    sourcePart,
    tags.join(", "),
    excluded.length > 0 ? `not ${excluded.join(", ")}` : "",
    years,
  ]
    .filter(Boolean)
    .join(" · ");
}

const weekdayName = (day: number, weekday: "long" | "short" = "long") =>
  new Date(2024, 0, 7 + day).toLocaleDateString("en-US", { weekday });

const formatHour = (scheduleTime: unknown) => {
  const hour = Number(normalizeScheduleTime(scheduleTime).split(":")[0]);
  return `${hour % 12 || 12} ${hour >= 12 ? "PM" : "AM"}`;
};

export function formatFlowSchedule(scheduleDays: unknown, scheduleTime: unknown) {
  const days = normalizeScheduleDays(scheduleDays);
  if (days.length === 0) return null;
  const key = days.join("");
  const when =
    key === "0123456"
      ? "Every day"
      : key === "12345"
        ? "Weekdays"
        : key === "06"
          ? "Weekends"
          : days.length === 1
            ? `${weekdayName(days[0] ?? 0)}s`
            : days.map((day) => weekdayName(day, "short")).join(", ");
  return `${when} at ${formatHour(scheduleTime)}`;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const calendarDaysBetween = (from: number, to: number) =>
  Math.round((new Date(to).setHours(0, 0, 0, 0) - new Date(from).setHours(0, 0, 0, 0)) / DAY_MS);

export function formatFlowFreshness(lastRunAt: number | null | undefined, now = Date.now()) {
  const timestamp = parseFlowTimestamp(lastRunAt);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  const days = calendarDaysBetween(timestamp, now);
  if (days <= 0) return "Refreshed today";
  if (days === 1) return "Refreshed yesterday";
  const date = new Date(timestamp);
  if (days < 7) return `Refreshed ${weekdayName(date.getDay())}`;
  return `Refreshed ${date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() !== new Date(now).getFullYear() && { year: "numeric" }),
  })}`;
}

export function formatNextRefresh(scheduleDays: unknown, scheduleTime: unknown, now = Date.now()) {
  const days = normalizeScheduleDays(scheduleDays);
  if (days.length === 0) return null;
  const hour = Number(normalizeScheduleTime(scheduleTime).split(":")[0]);
  const today = new Date(now);
  const offset =
    [0, 1, 2, 3, 4, 5, 6, 7].find((ahead) => {
      if (!days.includes((today.getDay() + ahead) % 7)) return false;
      return ahead > 0 || today.getHours() < hour;
    }) ?? 7;
  const day =
    offset === 0 ? "today" : offset === 1 ? "tomorrow" : weekdayName((today.getDay() + offset) % 7);
  return `Next refresh ${day} at ${formatHour(scheduleTime)}`;
}

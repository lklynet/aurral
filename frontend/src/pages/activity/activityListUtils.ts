import {
  DOWNLOAD_CLIENTS,
  lookupLabel,
  type ActivityRequest,
  type AlbumActivityRequest,
} from "../../../../lib/activity.ts";
import { formatDate, formatTime } from "../../utils/dateTime.ts";

export const downloadClientLabel = (request: ActivityRequest) =>
  request.sourceSummary || lookupLabel(DOWNLOAD_CLIENTS, request.source) || null;

export const isAlbumActivityRequest = (request: ActivityRequest): request is AlbumActivityRequest =>
  request.kind === "album_download" && Boolean(request.children && request.albumGrab);

export const formatTimelineTime = (value: string | number | null | undefined) => {
  if (value == null) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return formatTime(date, {
    hour: "numeric",
    minute: "2-digit",
  });
};

const formatReviewDuration = (ms: number | undefined) => {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return null;
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
};

export const formatReviewReasonSummary = (subtitle: string | null | undefined) => {
  const raw = String(subtitle || "").trim();
  if (!raw) return null;
  const colon = raw.indexOf(":");
  const code = (colon === -1 ? raw : raw.slice(0, colon)).trim();
  const fields = new Map<string, number>();
  for (const part of (colon === -1 ? "" : raw.slice(colon + 1)).split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = Number(part.slice(eq + 1).trim());
    if (key && Number.isFinite(value)) fields.set(key, value);
  }
  const parts = [code.replace(/-/g, " ").replace(/^\w/, (c) => c.toUpperCase())];
  for (const key of ["title", "artist", "album"]) {
    if (fields.has(key)) parts.push(`${key} ${fields.get(key)}`);
  }
  const actual = formatReviewDuration(fields.get("actualDurationMs"));
  const expected = formatReviewDuration(fields.get("expectedDurationMs"));
  if (actual && expected) parts.push(`${actual} vs ${expected}`);
  else if (actual) parts.push(actual);
  return parts.join(" · ");
};

const formatDateGroupLabel = (value: string | null | undefined) => {
  if (value == null) return "Unknown date";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown date";
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.round(
    (startOfToday.getTime() - startOfDate.getTime()) / (24 * 60 * 60 * 1000),
  );
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return formatDate(date, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: date.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
  });
};

export type ActivityListEntry =
  | { type: "date"; label: string; key: string }
  | { type: "item"; request: ActivityRequest; key: string };

export const buildHistoryListEntries = (requests: ActivityRequest[]) => {
  const groups: ActivityListEntry[] = [];
  let currentLabel = null;
  for (const request of requests) {
    const label = formatDateGroupLabel(request.completedAt || request.requestedAt);
    if (label !== currentLabel) {
      currentLabel = label;
      groups.push({ type: "date", label, key: `date-${label}` });
    }
    groups.push({ type: "item", request, key: request.id });
  }
  return groups;
};

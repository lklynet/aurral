import { formatDate, formatTime } from "./dateTime.ts";

const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface NearbyShow {
  eventName: string | null;
  artistNames?: string[];
  image: string | null;
  url: string | null;
  date: string | null;
  time: string | null;
  dateTime: string | null;
  venueName: string | null;
  city: string | null;
  region: string | null;
  distance: number | null;
}

export const parseShowDate = (value: string | null) => {
  if (!value) return null;
  const raw = String(value);
  const dateOnlyMatch = raw.match(DATE_ONLY_PATTERN);
  if (dateOnlyMatch) {
    const [, year, month, day] = dateOnlyMatch;
    return new Date(Number(year), Number(month) - 1, Number(day));
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

export const getShowDay = (show: NearbyShow) =>
  parseShowDate(show.date) || parseShowDate(show.dateTime);

const formatShowTime = (value: string | null) => {
  if (!value) return null;
  const match = String(value).match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!match) return value;
  const [, hour, minute] = match;
  const parsed = new Date(2000, 0, 1, Number(hour), Number(minute));
  return formatTime(parsed, {
    hour: "numeric",
    minute: "2-digit",
  });
};

export const formatShowDate = (show: NearbyShow) => {
  if (!show?.date && !show?.dateTime) return null;
  const parsed = getShowDay(show);
  if (!parsed) return show.date || null;
  const dateLabel = formatDate(parsed, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const timeLabel = formatShowTime(show.time);
  return timeLabel ? `${dateLabel} at ${timeLabel}` : dateLabel;
};

export const formatShowLocation = (show: NearbyShow) =>
  [show?.venueName, [show?.city, show?.region].filter(Boolean).join(", ")]
    .filter(Boolean)
    .join(" - ");

export const formatDistance = (distance: number | string | null) => {
  if (distance == null || distance === "") return null;
  const numericDistance = Number(distance);
  return Number.isFinite(numericDistance) ? `${Math.round(numericDistance)} mi` : null;
};

export const getEventUrl = (value: string | null) => {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) return "";
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : "";
  } catch {
    return "";
  }
};

export const titleNamesArtists = (title: string, artistNames: string[]) => {
  const normalizedTitle = String(title || "").toLocaleLowerCase();
  return (
    artistNames.length > 0 &&
    artistNames.every((name) => normalizedTitle.includes(String(name).toLocaleLowerCase()))
  );
};

export const DATE_TIME_FORMATS = ["browser", "day-first", "year-first"];

let currentFormat = "browser";

export const normalizeDateTimeFormat = (value) =>
  DATE_TIME_FORMATS.includes(value) ? value : "browser";

export const setDateTimeFormat = (value) => {
  currentFormat = normalizeDateTimeFormat(value);
};

const getLocale = () => {
  if (currentFormat === "day-first") return "en-GB";
  if (currentFormat === "year-first") return "ja-JP";
  return undefined;
};

const pad = (value) => String(value).padStart(2, "0");

export const formatDate = (date, options) => {
  if (currentFormat === "browser" || Number.isNaN(date.getTime())) {
    return date.toLocaleDateString(getLocale(), options);
  }
  const utc = options?.timeZone === "UTC";
  const year = utc ? date.getUTCFullYear() : date.getFullYear();
  const month = pad((utc ? date.getUTCMonth() : date.getMonth()) + 1);
  const day = pad(utc ? date.getUTCDate() : date.getDate());
  return currentFormat === "day-first"
    ? `${day}/${month}/${year}`
    : `${year}/${month}/${day}`;
};

export const formatTime = (date, options) => {
  if (currentFormat === "browser" || Number.isNaN(date.getTime())) {
    return date.toLocaleTimeString(getLocale(), options);
  }
  const utc = options?.timeZone === "UTC";
  return `${pad(utc ? date.getUTCHours() : date.getHours())}:${pad(
    utc ? date.getUTCMinutes() : date.getMinutes(),
  )}`;
};

export const formatDateTime = (date, options) => {
  if (currentFormat === "browser" || Number.isNaN(date.getTime())) {
    return date.toLocaleString(getLocale(), options);
  }
  const datePart = formatDate(date, options);
  const timePart = formatTime(date, options);
  return currentFormat === "day-first"
    ? `${timePart} ${datePart}`
    : `${datePart} ${timePart}`;
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const relativeFormatters = new Map();

const getRelativeFormatter = () => {
  const locale = getLocale();
  if (!relativeFormatters.has(locale)) {
    relativeFormatters.set(locale, new Intl.RelativeTimeFormat(locale, { numeric: "auto" }));
  }
  return relativeFormatters.get(locale);
};

const startOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());

const calendarDaysBetween = (date, now) =>
  Math.round((startOfDay(date).getTime() - startOfDay(now).getTime()) / DAY);

export const formatRelativeTime = (date, { now = new Date(), unit } = {}) => {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
  const formatter = getRelativeFormatter();
  const diff = date.getTime() - now.getTime();
  const distance = Math.abs(diff);
  if (unit !== "day") {
    if (distance < 45_000) return formatter.format(0, "second");
    if (distance < HOUR) return formatter.format(Math.round(diff / MINUTE), "minute");
    if (distance < DAY) return formatter.format(Math.round(diff / HOUR), "hour");
  }
  const days = unit === "day" ? calendarDaysBetween(date, now) : Math.round(diff / DAY);
  if (Math.abs(days) < 7) return formatter.format(days, "day");
  if (Math.abs(days) < 30) return formatter.format(Math.round(days / 7), "week");
  if (Math.abs(days) < 365) return formatter.format(Math.round(days / 30), "month");
  return formatter.format(Math.round(days / 365), "year");
};

export const nextRelativeTimeChange = (date, { now = new Date(), unit } = {}) => {
  const distance = Math.abs(date.getTime() - now.getTime());
  if (unit !== "day" && distance < HOUR) return 30_000;
  if (unit !== "day" && distance < DAY) return 5 * MINUTE;
  const nextMidnight = startOfDay(now).getTime() + DAY;
  return Math.max(nextMidnight - now.getTime() + 1000, MINUTE);
};

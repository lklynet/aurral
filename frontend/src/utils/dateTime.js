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

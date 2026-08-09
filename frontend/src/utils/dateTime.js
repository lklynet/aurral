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
  if (options || currentFormat === "browser" || Number.isNaN(date.getTime())) {
    return date.toLocaleDateString(getLocale(), options);
  }
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  return currentFormat === "day-first"
    ? `${day}/${month}/${year}`
    : `${year}/${month}/${day}`;
};

export const formatTime = (date, options) => {
  if (options || currentFormat === "browser" || Number.isNaN(date.getTime())) {
    return date.toLocaleTimeString(getLocale(), options);
  }
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

export const formatDateTime = (date, options) => {
  if (options || currentFormat === "browser" || Number.isNaN(date.getTime())) {
    return date.toLocaleString(getLocale(), options);
  }
  const datePart = formatDate(date);
  const timePart = formatTime(date);
  return currentFormat === "day-first"
    ? `${timePart} ${datePart}`
    : `${datePart} ${timePart}`;
};

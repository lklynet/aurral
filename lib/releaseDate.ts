export const utcDay = (time: number | Date = Date.now()) =>
  new Date(time).toISOString().slice(0, 10);

const releaseDay = (releaseDate: string | null | undefined) => {
  const day = String(releaseDate ?? "")
    .trim()
    .slice(0, 10);
  return /^\d{4}/.test(day) ? day : null;
};

export const isUnreleased = (
  releaseDate: string | null | undefined,
  now: number | Date = Date.now(),
) => {
  const day = releaseDay(releaseDate);
  return day !== null && day > utcDay(now);
};

export const releasedSince = (
  releaseDate: string | null | undefined,
  since: number,
  now: number | Date = Date.now(),
) => {
  const day = releaseDay(releaseDate);
  return day !== null && day > utcDay(since) && day <= utcDay(now);
};

const NEW_RELEASE_DAYS = 60;

export const isNewRelease = (releaseDate: string | null | undefined, now = Date.now()) =>
  /^\d{4}-\d{2}-\d{2}/.test(String(releaseDate ?? "").trim()) &&
  releasedSince(releaseDate, now - NEW_RELEASE_DAYS * 86_400_000, now);

// Tag editors also write 25/03/2022 or 03/25/2022. When the day and month
// can't be told apart, only the year is kept.
export const yearFirstReleaseDate = (value: string) => {
  const date = value.trim();
  const [, first = "", second = "", year = ""] =
    /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(date) ?? [];
  if (!year) return date || null;
  const [day, month] =
    Number(first) > 12 || Number(first) === Number(second)
      ? [first, second]
      : Number(second) > 12
        ? [second, first]
        : [];
  return day && month && Number(month) <= 12
    ? `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`
    : year;
};

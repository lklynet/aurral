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

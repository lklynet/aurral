export const isWrappedPreviewBuild = (appVersion: string) =>
  /^pr\.\d+\+[0-9a-f]{7,40}$/.test(appVersion);

export function wrappedSeason(appVersion: string, now = Date.now()) {
  if (isWrappedPreviewBuild(appVersion))
    return { year: new Date(now).getUTCFullYear(), cutoff: now, preview: true };
  const nightly = appVersion.startsWith("nightly.");
  const release = (year: number) => (nightly ? Date.UTC(year, 10, 28) : Date.UTC(year, 11, 1));
  const year = new Date(now).getUTCFullYear();
  if (year < 2026 || now < release(year)) return null;
  return { year, cutoff: release(year), preview: false };
}

export type WrappedSeason = NonNullable<ReturnType<typeof wrappedSeason>>;

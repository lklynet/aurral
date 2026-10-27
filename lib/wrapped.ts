export const isWrappedPreviewBuild = (appVersion: string) =>
  /^pr\.\d+\+[0-9a-f]{7,40}$/.test(appVersion);

export function wrappedSeason(appVersion: string, now = Date.now()) {
  const nightly = appVersion.startsWith("nightly.");
  const release = (year: number) => (nightly ? Date.UTC(year, 10, 28) : Date.UTC(year, 11, 1));
  if (now < release(2026)) return null;
  const currentYear = new Date(now).getUTCFullYear();
  const year = now >= release(currentYear) ? currentYear : currentYear - 1;
  return { year, cutoff: release(year), expiresAt: release(year + 1) };
}

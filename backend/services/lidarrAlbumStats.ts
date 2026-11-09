export function normalizePercentOfTracks(value: unknown) {
  const raw = Number(value);
  return Number.isFinite(raw) ? Math.min(100, Math.max(0, Math.round(raw))) : 0;
}

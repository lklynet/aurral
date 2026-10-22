export function normalizePercentOfTracks(value) {
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  if (raw > 1 && raw <= 100) return Math.round(raw);
  if (raw <= 1) return Math.round(raw * 100);
  return Math.min(100, Math.round(raw / 10));
}

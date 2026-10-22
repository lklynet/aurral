export function normalizeBaseUrl(value) {
  return String(value || "")
    .trim()
    .replace(/\/+$/, "");
}

export function normalizeInteger(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.trunc(parsed);
}

export function sanitizeNzbName(value) {
  const raw = String(value || "aurral-download");
  const cleaned = Array.from(raw)
    .map((ch) => {
      const code = ch.codePointAt(0);
      if (code < 0x20) return "_";
      if ('<>:"/\\|?*'.includes(ch)) return "_";
      return ch;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
  return cleaned || "aurral-download";
}

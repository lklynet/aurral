export const USENET_CLIENT_KEYS = ["sabnzbd", "nzbget", "tidarr"] as const;

export type UsenetClientKey = (typeof USENET_CLIENT_KEYS)[number];

export const isUsenetClientKey = (key: unknown): key is UsenetClientKey =>
  USENET_CLIENT_KEYS.some((entry) => entry === key);

export function normalizeBaseUrl(value: unknown) {
  return String(value || "")
    .trim()
    .replace(/\/+$/, "");
}

export function normalizeInteger(value: unknown, fallback: number): number;
export function normalizeInteger(value: unknown, fallback: null): number | null;
export function normalizeInteger(value: unknown, fallback: number | null = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.trunc(parsed);
}

export function sanitizeNzbName(value: unknown) {
  const raw = String(value || "aurral-download");
  const cleaned = Array.from(raw)
    .map((ch) => {
      const code = ch.codePointAt(0)!;
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

export const SHARE_ORIGIN = "https://aurral.org";

const PAYLOAD_VERSION = 1;
const KINDS = {
  artist: { code: 1, ids: ["artistMbid"], names: ["artistName"] },
  album: { code: 2, ids: ["albumMbid", "artistMbid"], names: ["title", "artistName"] },
  track: {
    code: 3,
    ids: ["trackMbid", "albumMbid", "artistMbid"],
    names: ["title", "artistName", "albumTitle"],
  },
};
const MBID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NAME_BYTES = 160;
const encoder = new TextEncoder();

const mbidBytes = (value) => {
  const text = String(value || "").trim();
  if (!MBID_PATTERN.test(text)) return null;
  const hex = text.replace(/-/g, "");
  return Uint8Array.from({ length: 16 }, (_, index) => parseInt(hex.slice(index * 2, index * 2 + 2), 16));
};

const nameBytes = (value) => {
  const text = String(value ?? "")
    .replace(/\p{Cc}/gu, " ")
    .trim();
  const bytes = encoder.encode(text);
  if (bytes.length <= MAX_NAME_BYTES) return bytes;
  let end = MAX_NAME_BYTES;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.slice(0, end);
};

const toBase64Url = (bytes) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

export function buildShareUrl(item) {
  const kind = KINDS[item?.kind];
  if (!kind) return null;
  const names = kind.names.map((field) => nameBytes(item[field]));
  const requiredNames = [names[0], names[kind.names.indexOf("artistName")]];
  if (requiredNames.some((bytes) => !bytes.length)) return null;
  const ids = kind.ids.map((field) => mbidBytes(item[field]));
  const idMask = ids.reduce((mask, bytes, index) => (bytes ? mask | (1 << index) : mask), 0);
  const parts = [Uint8Array.of(PAYLOAD_VERSION, kind.code, idMask), ...ids.filter(Boolean)];
  names.forEach((bytes, index) => {
    if (index) parts.push(Uint8Array.of(0));
    parts.push(bytes);
  });
  const payload = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    payload.set(part, offset);
    offset += part.length;
  }
  return `${SHARE_ORIGIN}/s/${toBase64Url(payload)}`;
}

const copyWithSelection = (text) => {
  if (typeof document === "undefined" || typeof document.execCommand !== "function") return false;
  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.appendChild(field);
  field.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    field.remove();
  }
};

export async function shareLink(url, title) {
  const nav = typeof navigator === "undefined" ? null : navigator;
  if (typeof nav?.share === "function") {
    try {
      await nav.share({ title, url });
      return "shared";
    } catch (error) {
      if (error?.name === "AbortError") return "cancelled";
    }
  }
  if (typeof nav?.clipboard?.writeText === "function") {
    try {
      await nav.clipboard.writeText(url);
      return "copied";
    } catch {}
  }
  if (copyWithSelection(url)) return "copied";
  throw new Error("Could not copy the share link");
}

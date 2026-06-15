import crypto from "crypto";

const PREFIX = "AURRAL_ENC:";
const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;

function encryptWithKey(text, key) {
  if (text == null || text === "") return text;
  if (!key || key.length !== 32) return text;
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv, {
    authTagLength: TAG_LEN,
  });
  const enc = Buffer.concat([
    cipher.update(String(text), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, enc]).toString("base64");
}

function decryptWithKey(text, key) {
  if (text == null || text === "") return text;
  if (typeof text !== "string" || !text.startsWith(PREFIX)) return text;
  if (!key || key.length !== 32) return text;
  try {
    const buf = Buffer.from(text.slice(PREFIX.length), "base64");
    if (buf.length < IV_LEN + TAG_LEN) return text;
    const iv = buf.subarray(0, IV_LEN);
    const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const enc = buf.subarray(IV_LEN + TAG_LEN);
    const decipher = crypto.createDecipheriv(ALGO, key, iv, {
      authTagLength: TAG_LEN,
    });
    decipher.setAuthTag(tag);
    return decipher.update(enc) + decipher.final("utf8");
  } catch {
    return text;
  }
}

const SENSITIVE_PATHS = [
  ["navidrome", "password"],
  ["plex", "token"],
  ["general", "authPassword"],
  ["lidarr", "apiKey"],
  ["slskd", "apiKey"],
  ["gotify", "token"],
  ["lastfm", "apiKey"],
];

function getAt(obj, path) {
  let cur = obj;
  for (const p of path) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[p];
  }
  return cur;
}

function setAt(obj, path, value) {
  let cur = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const p = path[i];
    if (cur[p] == null) cur[p] = {};
    cur = cur[p];
  }
  if (cur != null) cur[path[path.length - 1]] = value;
}

export function decryptIntegrations(integrations, key) {
  if (!integrations || typeof integrations !== "object") return integrations;
  const out = JSON.parse(JSON.stringify(integrations));
  for (const path of SENSITIVE_PATHS) {
    const v = getAt(out, path);
    if (v != null && typeof v === "string")
      setAt(out, path, decryptWithKey(v, key));
  }
  return out;
}

export function encryptIntegrations(integrations, key) {
  if (!integrations || typeof integrations !== "object") return integrations;
  const out = JSON.parse(JSON.stringify(integrations));
  for (const path of SENSITIVE_PATHS) {
    const v = getAt(out, path);
    if (v != null && typeof v === "string")
      setAt(out, path, encryptWithKey(v, key));
  }
  return out;
}

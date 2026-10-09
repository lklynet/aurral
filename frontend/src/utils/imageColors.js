import { useEffect, useState } from "react";
import { cacheImageLocally } from "./api/endpoints/images.js";
import { normalizeMediaUrl } from "./normalizeMediaUrl.js";
import { hexToOklch, oklchToHex, pickVividColor } from "./themeColor.js";

const N = 64;
const washCache = new Map();
const accentCache = new Map();
const localCopyCache = new Map();
const WASH_LIGHTNESS = { dark: [0.3, 0.52], light: [0.78, 0.9] };
const NEUTRAL_CHROMA = 0.012;

function averageHex(data) {
  let r = 0,
    g = 0,
    b = 0,
    n = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
    n++;
  }
  if (!n) return null;
  const h = (v) => Math.round(v / n).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

function pickArtworkWash(data) {
  const vivid = pickVividColor(data);
  const base = hexToOklch(vivid || averageHex(data));
  if (!base) return null;
  const chroma = vivid ? base.c : Math.min(base.c, NEUTRAL_CHROMA);
  const tone = ([min, max]) => oklchToHex({ l: Math.min(max, Math.max(min, base.l)), c: chroma, h: base.h });
  return { dark: tone(WASH_LIGHTNESS.dark), light: tone(WASH_LIGHTNESS.light) };
}

function isCrossOrigin(src) {
  try {
    const url = new URL(src, window.location.href);
    return /^https?:$/.test(url.protocol) && url.origin !== window.location.origin;
  } catch {
    return false;
  }
}

function sameOriginCopy(src) {
  if (!localCopyCache.has(src)) {
    if (localCopyCache.size >= 200) localCopyCache.delete(localCopyCache.keys().next().value);
    localCopyCache.set(
      src,
      cacheImageLocally(src)
        .then((url) => url || src)
        .catch(() => {
          localCopyCache.delete(src);
          return src;
        }),
    );
  }
  return localCopyCache.get(src);
}

async function readImagePixels(src) {
  const normalized = normalizeMediaUrl(src);
  const readable = isCrossOrigin(normalized) ? await sameOriginCopy(normalized) : normalized;
  return new Promise((ok, err) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => ok(img);
    img.onerror = err;
    img.src = readable;
  }).then((img) => {
    const c = Object.assign(document.createElement("canvas"), { width: N, height: N });
    const ctx = c.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, N, N);
    return ctx.getImageData(0, 0, N, N).data;
  });
}

export function extractArtworkAccent(src) {
  if (!src) return Promise.resolve(null);
  if (!accentCache.has(src)) {
    if (accentCache.size >= 200) accentCache.delete(accentCache.keys().next().value);
    accentCache.set(src, readImagePixels(src).then((data) => (data ? pickVividColor(data) : null)).catch(() => null));
  }
  return accentCache.get(src);
}

export async function extractArtworkWash(src) {
  if (!src) return null;
  if (washCache.has(src)) return washCache.get(src);
  if (washCache.size >= 200) washCache.delete(washCache.keys().next().value);
  const request = readImagePixels(src)
    .then((data) => (data ? pickArtworkWash(data) : null))
    .catch(() => null);
  washCache.set(src, request);
  const result = await request;
  if (!result) washCache.delete(src);
  return result;
}

export function useArtworkWash(src) {
  const [wash, setWash] = useState(null);
  useEffect(() => {
    if (!src) return void setWash(null);
    let dead = false;
    setWash(null);
    extractArtworkWash(src).then((r) => !dead && setWash(r));
    return () => {
      dead = true;
    };
  }, [src]);
  return wash;
}

import { useEffect, useState } from "react";
import { cacheImageLocally } from "./api/endpoints/images.js";
import { normalizeMediaUrl } from "./normalizeMediaUrl.js";
import { pickVividColor } from "./themeColor.js";

const N = 64;
const gradientCache = new Map();
const accentCache = new Map();
const localCopyCache = new Map();
export const FALLBACK_GRADIENT = { top: "var(--aurral-surface-raised)", bottom: "var(--aurral-surface)" };

function avgHex(data, y0, y1) {
  let r = 0,
    g = 0,
    b = 0,
    n = 0;
  for (let i = y0 * N * 4; i < y1 * N * 4; i += 4) {
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

export async function extractTwoToneGradientFromImage(src) {
  if (!src) return null;
  if (gradientCache.has(src)) return gradientCache.get(src);
  const request = readImagePixels(src)
    .then((data) => {
      if (!data) return null;
      const top = avgHex(data, 0, N >> 1);
      const bottom = avgHex(data, N >> 1, N);
      return top || bottom ? { top: top || bottom, bottom: bottom || top } : null;
    })
    .catch(() => FALLBACK_GRADIENT);
  gradientCache.set(src, request);
  const result = await request;
  if (!result) gradientCache.delete(src);
  return result;
}

export function useImageGradientColors(src) {
  const [colors, setColors] = useState(null);
  useEffect(() => {
    if (!src) return void setColors(null);
    let dead = false;
    setColors(null);
    extractTwoToneGradientFromImage(src).then((r) => !dead && setColors(r));
    return () => {
      dead = true;
    };
  }, [src]);
  return colors;
}

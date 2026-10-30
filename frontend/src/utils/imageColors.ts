import { useEffect, useState, type FocusEvent, type PointerEvent } from "react";
import { useThemeDocument } from "../hooks/useThemeDocument.ts";
import { cacheImageLocally } from "./api/endpoints/images.ts";
import { normalizeMediaUrl } from "./normalizeMediaUrl.ts";
import { getThemeDocument } from "./theme.ts";
import { hexToOklch, oklchToHex, pickVividColor } from "./themeColor.ts";

type ArtworkWash = NonNullable<ReturnType<typeof pickArtworkWash>>;

const N = 64;
const washCache = new Map<string, Promise<ArtworkWash | null>>();
const accentCache = new Map<string, Promise<string | null>>();
const localCopyCache = new Map<string, Promise<string>>();
const WASH_LIGHTNESS = { dark: [0.3, 0.52], light: [0.78, 0.9] } as const;
const NEUTRAL_CHROMA = 0.012;

function averageHex(data: Uint8ClampedArray) {
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
  const h = (v: number) =>
    Math.round(v / n)
      .toString(16)
      .padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

function pickArtworkWash(data: Uint8ClampedArray) {
  const vivid = pickVividColor(data);
  const base = hexToOklch(vivid || averageHex(data));
  if (!base) return null;
  const chroma = vivid ? base.c : Math.min(base.c, NEUTRAL_CHROMA);
  const tone = ([min, max]: readonly number[]) =>
    oklchToHex({ l: Math.min(max, Math.max(min, base.l)), c: chroma, h: base.h });
  return { dark: tone(WASH_LIGHTNESS.dark), light: tone(WASH_LIGHTNESS.light) };
}

function isCrossOrigin(src: string) {
  try {
    const url = new URL(src, window.location.href);
    return /^https?:$/.test(url.protocol) && url.origin !== window.location.origin;
  } catch {
    return false;
  }
}

function sameOriginCopy(src: string) {
  if (!localCopyCache.has(src)) {
    if (localCopyCache.size >= 200) localCopyCache.delete(localCopyCache.keys().next().value!);
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
  return localCopyCache.get(src)!;
}

function readPixels(src: string) {
  return new Promise<HTMLImageElement>((ok, err) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => ok(img);
    img.onerror = err;
    img.src = src;
  }).then((img) => {
    const c = Object.assign(document.createElement("canvas"), { width: N, height: N });
    const ctx = c.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, N, N);
    return ctx.getImageData(0, 0, N, N).data;
  });
}

async function readImagePixels(src: string) {
  const normalized = normalizeMediaUrl(src);
  try {
    return await readPixels(normalized);
  } catch (error) {
    if (!isCrossOrigin(normalized)) throw error;
    return readPixels(await sameOriginCopy(normalized));
  }
}

export function extractArtworkAccent(src: string | null | undefined) {
  if (!src) return Promise.resolve(null);
  if (!accentCache.has(src)) {
    if (accentCache.size >= 200) accentCache.delete(accentCache.keys().next().value!);
    accentCache.set(
      src,
      readImagePixels(src)
        .then((data) => (data ? pickVividColor(data) : null))
        .catch(() => null),
    );
  }
  return accentCache.get(src)!;
}

export async function extractArtworkWash(src: string | null | undefined) {
  if (!src) return null;
  if (washCache.has(src)) return washCache.get(src)!;
  if (washCache.size >= 200) washCache.delete(washCache.keys().next().value!);
  const request = readImagePixels(src)
    .then((data) => (data ? pickArtworkWash(data) : null))
    .catch(() => null);
  washCache.set(src, request);
  const result = await request;
  if (!result) washCache.delete(src);
  return result;
}

export function useArtworkWash(src: string | null | undefined) {
  const { matchArtwork: immersiveMode } = useThemeDocument();
  const artwork = immersiveMode ? src : null;
  const [wash, setWash] = useState<ArtworkWash | null>(null);
  if (!artwork && wash) setWash(null);
  useEffect(() => {
    if (!artwork) return undefined;
    let dead = false;
    extractArtworkWash(artwork).then((value) => !dead && setWash(value));
    return () => {
      dead = true;
    };
  }, [artwork]);
  return wash;
}

function tintCard(card: HTMLElement) {
  if (!getThemeDocument().matchArtwork) {
    card.style.removeProperty("--card-tint-surface");
    card.style.removeProperty("--card-tint-text");
    return;
  }
  void extractArtworkWash(card.querySelector("img")?.currentSrc).then((wash) => {
    if (!wash || !getThemeDocument().matchArtwork) return;
    card.style.setProperty(
      "--card-tint-surface",
      `color-mix(in oklch, light-dark(${wash.light}, ${wash.dark}) 35%, var(--aurral-surface-raised))`,
    );
    card.style.setProperty(
      "--card-tint-text",
      `color-mix(in oklch, light-dark(${wash.dark}, ${wash.light}) 65%, var(--aurral-text-muted))`,
    );
  });
}

export const artworkHoverTint = {
  onPointerEnter: (event: PointerEvent<HTMLElement>) => {
    if (event.pointerType !== "touch") tintCard(event.currentTarget);
  },
  onFocus: (event: FocusEvent<HTMLElement>) => tintCard(event.currentTarget),
};

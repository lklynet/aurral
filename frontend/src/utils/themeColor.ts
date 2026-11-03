type Oklch = { l: number; c: number; h: number };
type Triple = readonly [number, number, number];

export type HexColor = `#${string}`;

const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const each = ([a, b, c]: Triple, map: (value: number) => number): Triple => [
  map(a),
  map(b),
  map(c),
];

export function normalizeHexColor(value: HexColor): HexColor;
export function normalizeHexColor(value: unknown): HexColor | null;
export function normalizeHexColor(value: unknown): HexColor | null {
  if (typeof value !== "string") return null;
  const hex = value.trim().replace(/^#/, "").toLowerCase();
  if (/^[\da-f]{3}$/.test(hex)) return `#${[...hex].map((digit) => digit + digit).join("")}`;
  if (/^[\da-f]{6}$/.test(hex)) return `#${hex}`;
  return null;
}

function hexToRgb(hex: HexColor): Triple;
function hexToRgb(hex: unknown): Triple | null;
function hexToRgb(hex: unknown): Triple | null {
  const value = normalizeHexColor(hex);
  if (!value) return null;
  const channel = (index: number) => Number.parseInt(value.slice(index, index + 2), 16) / 255;
  return [channel(1), channel(3), channel(5)];
}

function rgbToHex(rgb: Triple): HexColor {
  return `#${rgb
    .map((channel) =>
      Math.round(clamp(channel) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

const toLinear = (channel: number) =>
  channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
const fromLinear = (channel: number) =>
  channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055;

function linearToOklab([r, g, b]: Triple): Triple {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function oklabToLinear([lightness, a, b]: Triple): Triple {
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

function rgbToOklch(rgb: Triple) {
  const [l, a, b] = linearToOklab(each(rgb, toLinear));
  const c = Math.hypot(a, b);
  return { l, c, h: c < 1e-4 ? 0 : ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360 };
}

export function hexToOklch(hex: HexColor): Oklch;
export function hexToOklch(hex: unknown): Oklch | null;
export function hexToOklch(hex: unknown) {
  const rgb = hexToRgb(hex);
  return rgb ? rgbToOklch(rgb) : null;
}

export function pickVividColor(pixels: ArrayLike<number>) {
  const bins = Array.from({ length: 24 }, () => ({ weight: 0, l: 0, c: 0, x: 0, y: 0 }));
  let count = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    if ((pixels[index + 3] ?? 0) < 128) continue;
    count += 1;
    const color = rgbToOklch([
      (pixels[index] ?? 0) / 255,
      (pixels[index + 1] ?? 0) / 255,
      (pixels[index + 2] ?? 0) / 255,
    ]);
    if (color.c < 0.04 || color.l < 0.2 || color.l > 0.95) continue;
    const weight = color.c * (1 - Math.abs(color.l - 0.65));
    const bin = bins[Math.floor(color.h / 15) % 24];
    if (!bin) continue;
    const radians = (color.h * Math.PI) / 180;
    bin.weight += weight;
    bin.l += color.l * weight;
    bin.c += color.c * weight;
    bin.x += Math.cos(radians) * weight;
    bin.y += Math.sin(radians) * weight;
  }
  const total = bins.reduce((sum, bin) => sum + bin.weight, 0);
  if (!count || total / count < 0.004) return null;
  const weightAt = (index: number) => bins[(index + 24) % 24]?.weight ?? 0;
  const score = (index: number) =>
    weightAt(index) + 0.5 * (weightAt(index - 1) + weightAt(index + 1));
  let best: (typeof bins)[number] | undefined;
  let bestScore = -Infinity;
  bins.forEach((bin, index) => {
    const binScore = score(index);
    if (binScore > bestScore) {
      best = bin;
      bestScore = binScore;
    }
  });
  if (!best) return null;
  return oklchToHex({
    l: best.l / best.weight,
    c: best.c / best.weight,
    h: ((Math.atan2(best.y, best.x) * 180) / Math.PI + 360) % 360,
  });
}

const inGamut = (linear: Triple) =>
  linear.every((channel) => channel >= -1e-4 && channel <= 1 + 1e-4);

function oklchToLinear({ l, c, h }: Oklch) {
  const radians = (h * Math.PI) / 180;
  return oklabToLinear([l, c * Math.cos(radians), c * Math.sin(radians)]);
}

export function oklchToHex({ l, c, h }: Oklch) {
  const lightness = clamp(l);
  let linear = oklchToLinear({ l: lightness, c, h });
  if (!inGamut(linear)) {
    let low = 0;
    let high = c;
    for (let step = 0; step < 20; step += 1) {
      const mid = (low + high) / 2;
      if (inGamut(oklchToLinear({ l: lightness, c: mid, h }))) low = mid;
      else high = mid;
    }
    linear = oklchToLinear({ l: lightness, c: low, h });
  }
  return rgbToHex(each(linear, (channel) => fromLinear(clamp(channel))));
}

export function relativeLuminance(hex: HexColor) {
  const [r, g, b] = each(hexToRgb(hex), toLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(first: HexColor, second: HexColor) {
  const a = relativeLuminance(first);
  const b = relativeLuminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

export function isDarkColor(hex: HexColor) {
  return hexToOklch(hex).l < 0.6;
}

export function mixColors(first: HexColor, second: HexColor, amount: number) {
  const [al, aa, ab] = linearToOklab(each(hexToRgb(first), toLinear));
  const [bl, ba, bb] = linearToOklab(each(hexToRgb(second), toLinear));
  const mix = (from: number, to: number) => from + (to - from) * amount;
  const mixed = oklabToLinear([mix(al, bl), mix(aa, ba), mix(ab, bb)]);
  return rgbToHex(each(mixed, (channel) => fromLinear(clamp(channel))));
}

export function withAlpha(hex: HexColor, alpha: number) {
  return `${hex}${Math.round(clamp(alpha) * 255)
    .toString(16)
    .padStart(2, "0")}`;
}

function contrastAtLightness(color: Omit<Oklch, "l">, lightness: number, background: HexColor) {
  return contrastRatio(oklchToHex({ ...color, l: lightness }), background);
}

export function adjustLightnessForContrast(hex: HexColor, background: HexColor, target: number) {
  if (contrastRatio(hex, background) >= target) return hex;
  const color = hexToOklch(hex);
  const towardLight = contrastRatio("#ffffff", background) >= contrastRatio("#000000", background);
  const limit = towardLight ? 1 : 0;
  if (contrastAtLightness(color, limit, background) < target)
    return oklchToHex({ ...color, l: limit });
  let near = color.l;
  let far = limit;
  for (let step = 0; step < 24; step += 1) {
    const mid = (near + far) / 2;
    if (contrastAtLightness(color, mid, background) >= target) far = mid;
    else near = mid;
  }
  return oklchToHex({ ...color, l: far });
}

export function colorAtContrast(
  hue: number,
  chroma: number,
  background: HexColor,
  target: number,
  towardLight: boolean,
) {
  const color = { c: chroma, h: hue };
  let near = hexToOklch(background).l;
  let far = towardLight ? 1 : 0;
  if (contrastAtLightness(color, far, background) <= target)
    return oklchToHex({ ...color, l: far });
  for (let step = 0; step < 24; step += 1) {
    const mid = (near + far) / 2;
    if (contrastAtLightness(color, mid, background) >= target) far = mid;
    else near = mid;
  }
  return oklchToHex({ ...color, l: far });
}

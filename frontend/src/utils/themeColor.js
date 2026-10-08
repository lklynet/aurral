const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));

export function normalizeHexColor(value) {
  if (typeof value !== "string") return null;
  const hex = value.trim().replace(/^#/, "").toLowerCase();
  if (/^[\da-f]{3}$/.test(hex)) return `#${[...hex].map((digit) => digit + digit).join("")}`;
  if (/^[\da-f]{6}$/.test(hex)) return `#${hex}`;
  return null;
}

function hexToRgb(hex) {
  const value = normalizeHexColor(hex);
  if (!value) return null;
  return [1, 3, 5].map((index) => Number.parseInt(value.slice(index, index + 2), 16) / 255);
}

function rgbToHex(rgb) {
  return `#${rgb.map((channel) => Math.round(clamp(channel) * 255).toString(16).padStart(2, "0")).join("")}`;
}

const toLinear = (channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
const fromLinear = (channel) => (channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055);

function linearToOklab([r, g, b]) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function oklabToLinear([lightness, a, b]) {
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

function rgbToOklch(rgb) {
  const [l, a, b] = linearToOklab(rgb.map(toLinear));
  const c = Math.hypot(a, b);
  return { l, c, h: c < 1e-4 ? 0 : ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360 };
}

export function hexToOklch(hex) {
  const rgb = hexToRgb(hex);
  return rgb ? rgbToOklch(rgb) : null;
}

export function pickVividColor(pixels) {
  const bins = Array.from({ length: 24 }, () => ({ weight: 0, l: 0, c: 0, x: 0, y: 0 }));
  let count = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    if (pixels[index + 3] < 128) continue;
    count += 1;
    const color = rgbToOklch([pixels[index] / 255, pixels[index + 1] / 255, pixels[index + 2] / 255]);
    if (color.c < 0.04 || color.l < 0.2 || color.l > 0.95) continue;
    const weight = color.c * (1 - Math.abs(color.l - 0.65));
    const bin = bins[Math.floor(color.h / 15) % 24];
    const radians = (color.h * Math.PI) / 180;
    bin.weight += weight;
    bin.l += color.l * weight;
    bin.c += color.c * weight;
    bin.x += Math.cos(radians) * weight;
    bin.y += Math.sin(radians) * weight;
  }
  const total = bins.reduce((sum, bin) => sum + bin.weight, 0);
  if (!count || total / count < 0.004) return null;
  const score = (index) => bins[index].weight + 0.5 * (bins[(index + 23) % 24].weight + bins[(index + 1) % 24].weight);
  const best = bins[bins.reduce((top, _bin, index) => (score(index) > score(top) ? index : top), 0)];
  return oklchToHex({
    l: best.l / best.weight,
    c: best.c / best.weight,
    h: (((Math.atan2(best.y, best.x) * 180) / Math.PI) + 360) % 360,
  });
}

const inGamut = (linear) => linear.every((channel) => channel >= -1e-4 && channel <= 1 + 1e-4);

function oklchToLinear({ l, c, h }) {
  const radians = (h * Math.PI) / 180;
  return oklabToLinear([l, c * Math.cos(radians), c * Math.sin(radians)]);
}

export function oklchToHex({ l, c, h }) {
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
  return rgbToHex(linear.map((channel) => fromLinear(clamp(channel))));
}

export function relativeLuminance(hex) {
  const [r, g, b] = hexToRgb(hex).map(toLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(first, second) {
  const a = relativeLuminance(first);
  const b = relativeLuminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

export function isDarkColor(hex) {
  return hexToOklch(hex).l < 0.6;
}

export function mixColors(first, second, amount) {
  const a = linearToOklab(hexToRgb(first).map(toLinear));
  const b = linearToOklab(hexToRgb(second).map(toLinear));
  const mixed = a.map((value, index) => value + (b[index] - value) * amount);
  return rgbToHex(oklabToLinear(mixed).map((channel) => fromLinear(clamp(channel))));
}

export function withAlpha(hex, alpha) {
  return `${hex}${Math.round(clamp(alpha) * 255).toString(16).padStart(2, "0")}`;
}

function contrastAtLightness(color, lightness, background) {
  return contrastRatio(oklchToHex({ ...color, l: lightness }), background);
}

export function adjustLightnessForContrast(hex, background, target) {
  if (contrastRatio(hex, background) >= target) return hex;
  const color = hexToOklch(hex);
  const towardLight = contrastRatio("#ffffff", background) >= contrastRatio("#000000", background);
  const limit = towardLight ? 1 : 0;
  if (contrastAtLightness(color, limit, background) < target) return oklchToHex({ ...color, l: limit });
  let near = color.l;
  let far = limit;
  for (let step = 0; step < 24; step += 1) {
    const mid = (near + far) / 2;
    if (contrastAtLightness(color, mid, background) >= target) far = mid;
    else near = mid;
  }
  return oklchToHex({ ...color, l: far });
}

export function colorAtContrast(hue, chroma, background, target, towardLight) {
  const color = { c: chroma, h: hue };
  let near = hexToOklch(background).l;
  let far = towardLight ? 1 : 0;
  if (contrastAtLightness(color, far, background) <= target) return oklchToHex({ ...color, l: far });
  for (let step = 0; step < 24; step += 1) {
    const mid = (near + far) / 2;
    if (contrastAtLightness(color, mid, background) >= target) far = mid;
    else near = mid;
  }
  return oklchToHex({ ...color, l: far });
}

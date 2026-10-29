import latin from "@fontsource-variable/archivo/files/archivo-latin-wdth-normal.woff2?url";
import latinExt from "@fontsource-variable/archivo/files/archivo-latin-ext-wdth-normal.woff2?url";
import type { WrappedRecap } from "../hooks/useWrapped.ts";
import { resolveApiPath } from "./api/core.ts";

export const WRAPPED_DISPLAY = '"Wrapped Display", sans-serif';
export const WRAPPED_TEXT = '"Wrapped Text", ui-sans-serif, system-ui, sans-serif';
const SUBSETS = [
  [
    latin,
    "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD",
  ],
  [
    latinExt,
    "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF",
  ],
] as const;
const FACES = [
  ["Wrapped Display", "62%", "700 900"],
  ["Wrapped Text", "100%", "400 700"],
] as const;

let registered = false;

export function loadWrappedFonts(text: string) {
  if (!registered) {
    registered = true;
    for (const [family, stretch, weight] of FACES)
      for (const [url, unicodeRange] of SUBSETS)
        document.fonts.add(
          new FontFace(family, `url("${url}") format("woff2")`, { stretch, weight, unicodeRange }),
        );
  }
  return Promise.all([
    document.fonts.load(`900 16px ${WRAPPED_DISPLAY}`, text),
    document.fonts.load(`500 16px ${WRAPPED_TEXT}`, text),
  ]);
}

export const wrappedImageUrl = (url: string) =>
  url.startsWith("/api/") ? resolveApiPath(url) : url;

const channels = (color: string) =>
  [1, 3, 5].map((index) => Number.parseInt(color.slice(index, index + 2), 16));

export function wrappedInk(color: string) {
  const [r, g, b] = channels(color);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 115 ? "#000000" : "#ffffff";
}

export function wrappedPalette(summary: WrappedRecap) {
  const colors: string[] = [];
  for (const { color } of [
    ...summary.topAlbums,
    ...summary.topSongs.slice(0, 5),
    ...summary.topArtists,
  ]) {
    if (!color) continue;
    const [r, g, b] = channels(color);
    const distinct = colors.every((seen) => {
      const [sr, sg, sb] = channels(seen);
      return Math.abs(r - sr) + Math.abs(g - sg) + Math.abs(b - sb) > 90;
    });
    if (distinct) colors.push(color);
  }
  return colors.length ? colors : ["#000000"];
}

export function wrappedCovers(summary: WrappedRecap, count = 4) {
  return [...summary.topAlbums, ...summary.topSongs, ...summary.topArtists]
    .flatMap((row) => (row.artwork ? [row.artwork] : []))
    .filter((url, index, urls) => urls.indexOf(url) === index)
    .slice(0, count);
}

export async function loadWrappedImage(url: string) {
  const image = new Image();
  image.crossOrigin = "anonymous";
  image.src = wrappedImageUrl(url);
  await image.decode();
  return image;
}

let logo: Promise<{ path: Path2D; length: number } | null> | null = null;

export function loadWrappedLogo() {
  logo ??= fetch(`${import.meta.env.BASE_URL}arralogo.svg`)
    .then((response) => response.text())
    .then((svg) => {
      const d = svg.match(/\sd="([^"]+)"/)?.[1];
      if (!d) return null;
      const measure = document.createElementNS("http://www.w3.org/2000/svg", "path");
      measure.setAttribute("d", d);
      return { path: new Path2D(d), length: measure.getTotalLength() };
    })
    .catch(() => null);
  return logo;
}

export const WRAPPED_CARD_BUILD = 3.6;
const progress = (time: number, start: number, length: number) =>
  1 - (1 - Math.min(1, Math.max(0, (time - start) / length))) ** 3;

function wrappedTexture(width: number, height: number, ink: string) {
  const u = width / 100;
  const texture = document.createElement("canvas");
  texture.width = width;
  texture.height = height;
  const grain = document.createElement("canvas");
  grain.width = 200;
  grain.height = 200;
  const paint = texture.getContext("2d");
  const speck = grain.getContext("2d");
  if (!paint || !speck) return texture;

  const noise = speck.createImageData(200, 200);
  for (let index = 3; index < noise.data.length; index += 4)
    noise.data[index] = Math.max(0, Math.random() * 2.4 - 0.95) * 255;
  speck.putImageData(noise, 0, 0);
  speck.globalCompositeOperation = "source-in";
  speck.fillStyle = ink;
  speck.fillRect(0, 0, 200, 200);

  paint.save();
  paint.translate(width / 2, height * 0.42);
  paint.scale(1.4 * width, 0.95 * height);
  const shade = paint.createRadialGradient(0, 0, 0, 0, 0, 1);
  shade.addColorStop(0.55, "rgba(0, 0, 0, 0)");
  shade.addColorStop(1, "rgba(0, 0, 0, 0.28)");
  paint.fillStyle = shade;
  paint.fillRect(-1, -1, 2, 2);
  paint.restore();

  paint.globalAlpha = 0.12;
  paint.strokeStyle = ink;
  paint.lineWidth = 0.25 * u;
  for (let radius = 24.875 * u; radius < 112 * u; radius += 1.25 * u) {
    paint.beginPath();
    paint.arc(104 * u, -4 * u, radius, 0, Math.PI * 2);
    paint.stroke();
  }

  const pattern = paint.createPattern(grain, "repeat");
  if (pattern) {
    pattern.setTransform(new DOMMatrix().scale(width / 430));
    paint.globalAlpha = 0.09;
    paint.fillStyle = pattern;
    paint.fillRect(0, 0, width, height);
  }
  return texture;
}

export async function prepareWrappedCard(summary: WrappedRecap, field: string, username: string) {
  const names = summary.topArtists.map((artist) => artist.name);
  const [covers, mark] = await Promise.all([
    Promise.all(wrappedCovers(summary).map((url) => loadWrappedImage(url).catch(() => null))),
    loadWrappedLogo(),
    loadWrappedFonts(`${summary.year}0123456789,.${names.join("")}${username}`),
  ]);
  const width = 1080;
  const height = 1920;
  const u = width / 100;
  const left = 5 * u;
  const room = width - 10 * u;
  const ink = wrappedInk(field);
  const texture = wrappedTexture(width, height, ink);
  const year = String(summary.year);
  const stats = [
    ...(summary.minutes === null ? [] : [{ value: summary.minutes, label: "minutes" }]),
    { value: summary.totalPlays, label: "plays" },
    { value: summary.uniqueArtists, label: "artists" },
  ];

  return (context: CanvasRenderingContext2D, time = Number.POSITIVE_INFINITY) => {
    const font = (size: number, family: string, weight: number, value = "", max = room) => {
      context.font = `${weight} ${size}px ${family}`;
      const measured = context.measureText(value).width;
      if (measured > max)
        context.font = `${weight} ${Math.floor((size * max) / measured)}px ${family}`;
      return context.measureText(value);
    };
    const rise = (start: number, length: number, distance: number) => {
      const k = progress(time, start, length);
      context.globalAlpha = k;
      return distance * (1 - k);
    };

    context.globalAlpha = 1;
    context.fillStyle = field;
    context.fillRect(0, 0, width, height);
    context.drawImage(texture, 0, 0);
    context.fillStyle = ink;

    context.letterSpacing = `${-0.06 * 44 * u}px`;
    const yearBox = font(44 * u, WRAPPED_DISPLAY, 900, year);
    let y = 6 * u + yearBox.actualBoundingBoxAscent;
    const grow = progress(time, 0, 0.7);
    context.save();
    context.globalAlpha = grow;
    context.translate(left - 1.4 * u, 6 * u);
    context.scale(1.18 - 0.18 * grow, 1.18 - 0.18 * grow);
    context.fillText(year, 0, y - 6 * u);
    context.restore();
    context.letterSpacing = "0px";

    y += 6 * u;
    let x = left;
    const statTop = y + font(14 * u, WRAPPED_DISPLAY, 900, "0").actualBoundingBoxAscent;
    stats.forEach((stat, index) => {
      const final = stat.value.toLocaleString();
      const valueWidth = font(14 * u, WRAPPED_DISPLAY, 900, final).width;
      const counted = 1 - (1 - Math.min(1, Math.max(0, (time - 0.3 - index * 0.1) / 1.6))) ** 4;
      const offset = rise(0.25 + index * 0.1, 0.7, 3 * u);
      context.fillText(Math.round(stat.value * counted).toLocaleString(), x, statTop + offset);
      context.globalAlpha *= 0.6;
      const labelWidth = font(3.4 * u, WRAPPED_TEXT, 600, stat.label).width;
      context.fillText(stat.label, x, statTop + 6.4 * u + offset);
      x += Math.max(valueWidth, labelWidth) + 6 * u;
    });

    y = statTop + 6.4 * u + 5 * u;
    names.forEach((name, index) => {
      y += 8.8 * u;
      font(8.6 * u, WRAPPED_DISPLAY, 800, name);
      context.fillText(name, left, y + rise(0.8 + index * 0.1, 0.6, 4 * u));
    });

    const logoHeight = (6.4 * u * 485) / 650;
    const brandBottom = height - 6 * u;
    const brandTop = brandBottom - logoHeight;
    const coverSize = 15 * u;
    const coverTop = brandTop - 4 * u - coverSize;
    covers.forEach((cover, index) => {
      if (!cover) return;
      const k = progress(time, 1.3 + index * 0.09, 0.6);
      const side = Math.min(cover.naturalWidth, cover.naturalHeight);
      const coverLeft = left + index * (coverSize + 2 * u);
      context.save();
      context.globalAlpha = k;
      context.translate(coverLeft + coverSize / 2, coverTop + coverSize / 2 - 6 * u * (1 - k));
      context.rotate((-4 * (1 - k) * Math.PI) / 180);
      context.drawImage(
        cover,
        (cover.naturalWidth - side) / 2,
        (cover.naturalHeight - side) / 2,
        side,
        side,
        -coverSize / 2,
        -coverSize / 2,
        coverSize,
        coverSize,
      );
      context.restore();
    });
    context.globalAlpha = 1;
    if (mark) {
      const scale = (6.4 * u) / 650;
      context.save();
      context.translate(left, brandTop);
      context.scale(scale, scale);
      const drawn = progress(time, 1.9, 1.5);
      if (drawn < 1) {
        context.strokeStyle = ink;
        context.lineWidth = 14;
        context.setLineDash([mark.length]);
        context.lineDashOffset = mark.length * (1 - drawn);
        context.stroke(mark.path);
      }
      context.globalAlpha = progress(time, 3.1, 0.5);
      context.fill(mark.path);
      context.restore();
    }
    context.globalAlpha = progress(time, 1.9, 0.5);
    font(3.6 * u, WRAPPED_TEXT, 700);
    context.textBaseline = "middle";
    context.fillText(`${username} on aurral`, left + 8 * u, brandTop + logoHeight / 2);
    context.textBaseline = "alphabetic";
    context.globalAlpha = 1;
  };
}

export async function createWrappedImage(summary: WrappedRecap, field: string, username: string) {
  const draw = await prepareWrappedCard(summary, field, username);
  const canvas = document.createElement("canvas");
  canvas.width = 1080;
  canvas.height = 1920;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Image export is unavailable in this browser");
  draw(context);
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Image export failed"))),
      "image/png",
    ),
  );
  return new File([blob], `aurral-wrapped-${summary.year}.png`, { type: "image/png" });
}

export function downloadWrappedFile(file: File) {
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = file.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

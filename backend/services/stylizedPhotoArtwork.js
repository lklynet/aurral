import axios from "axios";
import sharp from "sharp";
import { FIXED_DISCOVER_PLAYLIST_ARTWORK_COLORS } from "../config/discoverPlaylistPresets.js";

const ARTWORK_SIZE = 1200;
const TITLE_PADDING_X = 72;

export const PHOTO_ARTWORK_COLORS = [
  "#e6194B",
  "#3cb44b",
  "#ffe119",
  "#4363d8",
  "#f58231",
  "#42d4f4",
  "#f032e6",
  "#fabed4",
  "#469990",
  "#dcbeff",
  "#9A6324",
  "#fffac8",
  "#800000",
  "#aaffc3",
  "#000075",
];

const hexToRgb = (hex) => {
  const normalized = String(hex || "")
    .replace("#", "")
    .trim();
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) {
    return { r: 67, g: 99, b: 216 };
  }
  return {
    r: Number.parseInt(normalized.slice(0, 2), 16),
    g: Number.parseInt(normalized.slice(2, 4), 16),
    b: Number.parseInt(normalized.slice(4, 6), 16),
  };
};

const buildPaletteFromHex = (hex) => {
  const light = hexToRgb(hex);
  return {
    dark: {
      r: Math.round(light.r * 0.16 + 10),
      g: Math.round(light.g * 0.16 + 8),
      b: Math.round(light.b * 0.16 + 12),
    },
    light,
  };
};

const hashString = (value) => {
  let hash = 0;
  const input = String(value || "");
  for (let index = 0; index < input.length; index += 1) {
    hash = input.charCodeAt(index) + ((hash << 5) - hash);
    hash |= 0;
  }
  return Math.abs(hash);
};

export const pickRandomPhotoArtworkPalette = () => {
  const index = Math.floor(Math.random() * PHOTO_ARTWORK_COLORS.length);
  return buildPaletteFromHex(PHOTO_ARTWORK_COLORS[index]);
};

export const pickSeededPhotoArtworkPalette = (seed) => {
  const presetId = String(seed || "").trim();
  const fixedHex = FIXED_DISCOVER_PLAYLIST_ARTWORK_COLORS[presetId];
  if (fixedHex) return buildPaletteFromHex(fixedHex);
  const index = hashString(presetId) % PHOTO_ARTWORK_COLORS.length;
  return buildPaletteFromHex(PHOTO_ARTWORK_COLORS[index]);
};

const escapeXml = (value) =>
  String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

const buildCoverTitleLines = (title) => {
  const words = String(title || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const cleaned = [];
  for (const word of words) {
    const previous = cleaned[cleaned.length - 1];
    if (previous && previous.toLowerCase() === word.toLowerCase()) continue;
    cleaned.push(word);
  }
  return cleaned.length > 0 ? cleaned : ["Untitled"];
};

const estimateTextWidth = (line, fontSize) =>
  String(line || "").length * fontSize * 0.56;

const renderArtworkTitleOverlay = async (titleLines) => {
  const maxWidth = ARTWORK_SIZE - TITLE_PADDING_X * 2;
  const maxHeight = ARTWORK_SIZE - 144;
  let fontSize = 132;

  while (fontSize > 28) {
    const lineHeight = fontSize * 1.05;
    const totalHeight = titleLines.length * lineHeight;
    const widestLine = Math.max(
      ...titleLines.map((line) => estimateTextWidth(line, fontSize)),
      0,
    );
    if (totalHeight <= maxHeight && widestLine <= maxWidth) break;
    fontSize -= 2;
  }

  const lineHeight = fontSize * 1.05;
  const totalHeight = titleLines.length * lineHeight;
  const startY = (ARTWORK_SIZE - totalHeight) / 2 + fontSize * 0.82;
  const titleMarkup = titleLines
    .map(
      (line, index) =>
        `<tspan x="${TITLE_PADDING_X}" dy="${index === 0 ? 0 : lineHeight}">${escapeXml(line)}</tspan>`,
    )
    .join("");

  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${ARTWORK_SIZE}" height="${ARTWORK_SIZE}" viewBox="0 0 ${ARTWORK_SIZE} ${ARTWORK_SIZE}">
  <text
    x="${TITLE_PADDING_X}"
    y="${startY}"
    font-family="Arial Black, Helvetica Neue, Arial, sans-serif"
    font-size="${fontSize}"
    font-weight="900"
    fill="#ffffff"
  >${titleMarkup}</text>
</svg>`.trim();

  return sharp(Buffer.from(svg)).png().toBuffer();
};

const mapToneBufferToPalette = (toneMapRaw, palette) => {
  const pixelCount = ARTWORK_SIZE * ARTWORK_SIZE;
  const mapped = Buffer.alloc(pixelCount * 3);
  const { dark, light } = palette;

  for (let index = 0; index < pixelCount; index += 1) {
    const luminance = toneMapRaw[index] / 255;
    const mappedLuminance = 0.05 + luminance ** 1.38 * 0.32;
    const offset = index * 3;
    mapped[offset] = Math.round(dark.r + (light.r - dark.r) * mappedLuminance);
    mapped[offset + 1] = Math.round(
      dark.g + (light.g - dark.g) * mappedLuminance,
    );
    mapped[offset + 2] = Math.round(
      dark.b + (light.b - dark.b) * mappedLuminance,
    );
  }

  return mapped;
};

export async function fetchImageBuffer(imageUrl) {
  const response = await axios.get(String(imageUrl || "").trim(), {
    responseType: "arraybuffer",
    timeout: 20000,
    maxRedirects: 5,
    validateStatus: (status) => status >= 200 && status < 400,
  });
  return Buffer.from(response.data);
}

export async function renderStylizedPhotoArtwork({
  imageBuffer,
  title,
  paletteSeed = null,
}) {
  const base = sharp(imageBuffer, { animated: false })
    .resize(ARTWORK_SIZE, ARTWORK_SIZE, { fit: "cover", position: "attention" })
    .ensureAlpha();

  const toneMapRaw = await base
    .clone()
    .grayscale()
    .normalize()
    .linear(1.5, -36)
    .gamma(1.12)
    .raw()
    .toBuffer();

  const palette = paletteSeed
    ? pickSeededPhotoArtworkPalette(paletteSeed)
    : pickRandomPhotoArtworkPalette();
  const mappedRgb = mapToneBufferToPalette(toneMapRaw, palette);
  const mappedImage = await sharp(mappedRgb, {
    raw: { width: ARTWORK_SIZE, height: ARTWORK_SIZE, channels: 3 },
  })
    .png()
    .toBuffer();

  const detailLayer = await base
    .clone()
    .grayscale()
    .normalize()
    .linear(1.18, -12)
    .sharpen({ sigma: 1, m1: 1.2, m2: 2, x1: 2, y2: 10, y3: 16 })
    .png()
    .toBuffer();

  const darkWash = await sharp({
    create: {
      width: ARTWORK_SIZE,
      height: ARTWORK_SIZE,
      channels: 4,
      background: { r: 20, g: 12, b: 18, alpha: 0.18 },
    },
  })
    .png()
    .toBuffer();

  const titleOverlay = await renderArtworkTitleOverlay(
    buildCoverTitleLines(title),
  );

  return sharp({
    create: {
      width: ARTWORK_SIZE,
      height: ARTWORK_SIZE,
      channels: 4,
      background: "#000000",
    },
  })
    .composite([
      { input: mappedImage, blend: "over" },
      { input: detailLayer, blend: "overlay" },
      { input: darkWash, blend: "multiply" },
      { input: titleOverlay, blend: "over" },
    ])
    .linear(0.96, -10)
    .jpeg({ quality: 90, mozjpeg: true })
    .toBuffer();
}

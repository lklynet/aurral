import sharp from "sharp";

const TAG_COLORS = [
  "#845336",
  "#57553c",
  "#a17e3e",
  "#43454f",
  "#604848",
  "#5c6652",
  "#a18b62",
  "#8c4f4a",
  "#898471",
  "#c8b491",
  "#65788f",
  "#755e4a",
  "#718062",
  "#bc9d66",
];

const ARTWORK_SIZE = 1000;
const TITLE_SAFE_WIDTH = 760;
const TITLE_SAFE_TOP = 240;
const TITLE_SAFE_BOTTOM = 890;
const TITLE_SAFE_HEIGHT = TITLE_SAFE_BOTTOM - TITLE_SAFE_TOP;
const TITLE_MAX_LINES = 6;
const AURRAL_LOGO_PATH =
  "m471 0.68c-1.38 0.23-7.23 1.33-13 2.46-5.77 1.13-14.77 3.64-20 5.58-5.23 1.94-13.55 5.56-18.5 8.04-4.95 2.48-11.48 6.18-14.5 8.23-3.02 2.04-8.2 6.05-11.5 8.91-3.3 2.86-9.33 8.89-13.4 13.4-4.07 4.51-9.61 11.57-12.31 15.7-2.71 4.13-6.64 11.1-8.74 15.5-2.1 4.4-5.26 12.05-7.01 17-1.75 4.95-4.53 14.4-6.18 21-2.56 10.26-3.07 14.54-3.52 29.5-0.4 13.19-0.2 18.48 0.82 21.46 0.86 2.56 2.58 4.79 4.84 6.28 2.19 1.45 4.99 2.32 7.5 2.32 2.81 0 5.19-0.86 8-2.87 2.2-1.58 8.14-6.43 13.21-10.78 5.06-4.35 11.59-9.36 14.5-11.13 2.91-1.78 10.46-5.49 16.79-8.26 6.33-2.77 12.63-5.86 14-6.87 1.51-1.11 4.09-5.58 6.5-11.25 2.2-5.17 5.07-11.43 6.39-13.9 1.31-2.48 6.04-8.13 10.5-12.56 4.48-4.46 10.12-9 12.61-10.14 2.48-1.15 7.42-3.07 11-4.28 4.38-1.48 10.08-2.38 17.5-2.76 6.75-0.35 14.09-0.08 19 0.68 4.4 0.69 11.15 2.56 15 4.15 4.38 1.82 9.78 5.25 14.43 9.16 4.09 3.44 9.82 9.4 12.75 13.25 2.93 3.85 6.85 10.15 8.72 14 1.87 3.85 4.57 10.6 6 15 1.43 4.4 3.37 11.6 4.31 16 1.28 5.97 1.72 12.96 1.75 27.5 0.02 15.16-0.37 21.39-1.78 28-1 4.68-2.95 11.88-4.33 16-1.38 4.13-4.74 12-7.46 17.5-2.73 5.5-7.85 14.05-11.37 19-3.53 4.95-13.68 17.77-22.56 28.5-8.87 10.73-18.53 22.88-21.46 27-2.93 4.13-7.37 11.33-9.88 16-2.5 4.67-5.86 12.1-7.47 16.5-1.61 4.4-3.65 11.38-4.54 15.5-0.9 4.13-2.25 12.45-3 18.5-0.76 6.05-2.05 12.35-2.86 14-0.82 1.65-2.67 3.79-4.12 4.75-1.45 0.96-3.75 1.75-5.13 1.75-1.37 0-5.2-1.12-8.5-2.5-3.73-1.55-7.98-2.51-11.25-2.53-3.64-0.03-6.02 0.54-7.75 1.85-1.37 1.04-5.75 6.57-9.72 12.29-3.96 5.71-11.28 15-16.25 20.64-4.96 5.64-9.32 11.49-9.67 13-0.35 1.51-0.41 5.45-0.14 8.75 0.45 5.58 0.79 6.27 4.88 9.9 2.42 2.15 9.35 6.3 15.4 9.22 6.05 2.93 14.6 6.26 19 7.39 4.4 1.14 12.95 2.33 19 2.65 7.93 0.41 13.58 0.13 20.25-1.04 5.09-0.89 13.2-3.08 18.03-4.87 4.83-1.79 12.52-5.5 17.1-8.25 5.46-3.28 10.94-7.76 15.97-13.04 4.21-4.42 9.49-11.17 11.74-15 2.24-3.83 5.55-10.79 7.34-15.46 1.79-4.67 3.88-11.65 4.65-15.5 0.78-3.85 2.05-11.73 2.84-17.5 0.79-5.77 2.05-12.3 2.79-14.5 0.74-2.2 3.43-7.15 5.98-11 2.55-3.85 8.58-11.73 13.41-17.5 4.84-5.77 13.33-16.13 18.88-23 5.55-6.88 13.06-17 16.69-22.5 3.62-5.5 8.87-14.27 11.66-19.5 2.8-5.23 7.07-14.23 9.5-20 2.43-5.77 6.02-16.35 7.98-23.5 1.96-7.15 4.38-17.27 5.37-22.5 1.49-7.8 1.81-14.69 1.82-38.5 0-23.9-0.32-30.67-1.82-38.5-1-5.23-2.71-13.1-3.79-17.5-1.09-4.4-3.15-11.6-4.58-16-1.43-4.4-4.48-12.27-6.78-17.5-2.3-5.23-6.71-13.77-9.79-19-3.09-5.22-8.51-13.1-12.04-17.5-3.53-4.4-10.42-11.79-15.31-16.41-4.89-4.63-11.14-10.08-13.89-12.12-2.75-2.03-8.83-5.72-13.5-8.2-4.67-2.48-12.55-6.13-17.5-8.1-4.95-1.98-13.5-4.74-19-6.13-5.5-1.4-14.73-3-20.5-3.54-5.77-0.55-16.58-0.94-24-0.86-7.42 0.07-14.63 0.32-16 0.54zm-268.5 78.76c-3.85 0.7-11.05 2.93-16 4.96-4.95 2.03-11.7 5.64-15 8.01-3.3 2.38-8.7 7.19-12.01 10.71-3.31 3.51-8.34 10.2-11.17 14.88-2.84 4.68-6.81 12.32-8.82 17-2 4.68-4.97 13.23-6.6 19-1.62 5.77-3.82 15.68-4.88 22-1.07 6.32-2.43 16-3.03 21.5-0.6 5.5-2.01 13.37-3.11 17.5-1.11 4.12-3.68 10.64-5.7 14.48-2.02 3.84-6.38 9.88-9.68 13.42-3.3 3.54-9.15 8.51-13 11.05-3.85 2.53-10.49 6.06-14.75 7.83-4.26 1.77-9.66 3.49-12 3.83-3.28 0.46-5.73 0-10.75-2.05-3.57-1.46-8.75-4.36-11.5-6.44-2.75-2.09-6.35-5.14-8-6.78-1.65-1.64-5.14-4.64-7.75-6.66-3.05-2.37-5.82-3.68-7.75-3.68-1.65 0-5.01 1.24-7.46 2.75-2.81 1.73-5.2 4.23-6.43 6.75-1.08 2.2-2.91 9.18-4.07 15.5-1.16 6.32-2.37 16.45-2.7 22.5-0.36 6.49-0.11 14.69 0.59 20 0.65 4.95 1.92 11.48 2.81 14.5 1.1 3.72 2.86 6.71 5.44 9.25 2.1 2.06 7.08 5.31 11.07 7.21 3.99 1.9 11.3 4.63 16.25 6.07 4.95 1.43 12.37 2.96 16.5 3.4 4.82 0.51 10.9 0.36 17-0.44 5.22-0.68 12.43-1.99 16-2.91 3.57-0.92 10.1-2.82 14.5-4.21 4.4-1.4 11.82-4.32 16.5-6.51 4.68-2.18 12.1-6.03 16.5-8.56 4.4-2.52 11.6-7.39 16-10.82 4.4-3.42 11.94-10.33 16.75-15.35 4.81-5.02 11.17-12.84 14.13-17.38 2.96-4.54 7.3-12.07 9.64-16.75 2.34-4.68 5.32-11.31 6.62-14.75 1.3-3.44 3.23-9.96 4.3-14.5 1.06-4.54 3.32-17.93 5-29.75 1.69-11.82 3.9-24.43 4.91-28 1.02-3.57 2.82-8.64 4-11.25 1.18-2.61 2.87-5.09 3.76-5.5 1.12-0.52 2.17 0.02 3.43 1.75 0.99 1.37 2.98 5.87 4.4 10 1.43 4.12 3.45 12 4.5 17.5 1.05 5.5 2.18 16.52 2.51 24.5 0.33 7.98 1.05 32.73 1.6 55 0.56 23.02 1.66 46.33 2.54 54 0.85 7.42 2.45 18 3.54 23.5 1.09 5.5 2.67 12.7 3.51 16 0.84 3.3 3.11 10.27 5.05 15.5 1.93 5.23 6.28 14.43 9.66 20.46 4.77 8.51 8.16 13.02 15.15 20.14 7.48 7.64 10.52 9.94 18 13.69 4.95 2.47 11.93 5.48 15.5 6.68 4.8 1.61 9.91 2.32 19.5 2.71 9.45 0.39 14.91 0.12 20-0.96 3.85-0.81 10.15-2.74 14-4.27 3.85-1.54 9.7-4.38 13-6.31 3.3-1.94 9.15-6.7 13-10.58 3.86-3.88 9.39-10.66 12.31-15.06 2.91-4.4 6.59-10.7 8.19-14 1.59-3.3 4.52-10.95 6.5-17 1.99-6.05 4.91-17.52 6.5-25.5 1.59-7.98 3.59-23.05 4.44-33.5 0.86-10.45 2.06-24.63 2.67-31.5 0.61-6.88 2.13-16.55 3.39-21.5 1.25-4.95 3.38-11.48 4.71-14.5 1.34-3.02 3.98-7.25 5.86-9.39 1.89-2.13 4.44-4.27 5.68-4.75 1.46-0.56 3.39-0.39 5.5 0.48 1.79 0.74 4.42 2.87 5.86 4.75 1.44 1.88 3.96 6.11 5.61 9.41 1.66 3.3 4.42 10.61 6.14 16.25 2.46 8.03 3.79 10.79 6.14 12.75 2.32 1.93 4.13 2.5 8 2.5 2.75 0 6.24-0.62 7.75-1.38 1.51-0.77 5.68-4.48 9.27-8.25 3.58-3.78 9.04-10.25 12.13-14.37 3.08-4.13 7.67-11.1 10.19-15.5 2.52-4.4 5.95-11.71 7.62-16.25 1.67-4.54 3.04-10.05 3.04-12.25 0-2.2-0.75-5.91-1.67-8.25-0.91-2.34-3.27-6.73-5.24-9.75-1.97-3.02-6.96-9.05-11.09-13.38-4.12-4.33-10.2-9.71-13.5-11.94-3.3-2.24-9.6-5.72-14-7.75-4.4-2.03-10.48-4.45-13.5-5.38-3.46-1.06-10.7-1.89-19.5-2.24-8.17-0.32-17.75-0.08-23 0.59-6.69 0.85-11.44 2.22-18.5 5.34-5.23 2.31-12.65 6.32-16.5 8.91-3.85 2.59-9.55 7.33-12.66 10.53-3.11 3.2-8.07 9.19-11.02 13.32-2.95 4.12-7.67 12.23-10.49 18-2.81 5.77-6.32 14.32-7.79 19-1.47 4.68-3.74 13.45-5.04 19.5-1.3 6.05-2.85 14.6-3.43 19-0.59 4.4-1.75 17.68-2.59 29.5-0.83 11.82-2.23 25.77-3.1 31-0.87 5.23-2.89 13.55-4.48 18.5-1.6 4.95-3.69 10.04-4.65 11.31-1.68 2.21-1.82 2.23-3.46 0.5-0.95-1-3.06-5.64-4.7-10.31-1.64-4.67-3.87-13.45-4.95-19.5-1.09-6.05-2.24-16.63-2.57-23.5-0.34-6.88-1.07-32.3-1.62-56.5-0.64-27.37-1.6-48.54-2.55-56-0.84-6.6-2.66-17.4-4.06-24-1.39-6.6-4-16.5-5.81-22-1.8-5.5-5.52-14.5-8.27-20-2.75-5.5-7.68-13.38-10.95-17.5-3.27-4.13-8.39-9.68-11.38-12.34-2.99-2.67-7.68-6.13-10.43-7.7-2.75-1.56-8.15-4.04-12-5.51-3.85-1.46-10.38-3.28-14.5-4.02-4.13-0.75-11.77-1.34-17-1.3-5.23 0.03-12.65 0.62-16.5 1.31z";

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

const hashString = (value) => {
  let hash = 0;
  const input = String(value || "");
  for (let i = 0; i < input.length; i += 1) {
    hash = input.charCodeAt(i) + ((hash << 5) - hash);
    hash |= 0;
  }
  return Math.abs(hash);
};

const hexToRgb = (hex) => {
  const normalized = String(hex || "")
    .replace("#", "")
    .trim();
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) {
    return { r: 33, g: 31, b: 39 };
  }
  return {
    r: Number.parseInt(normalized.slice(0, 2), 16),
    g: Number.parseInt(normalized.slice(2, 4), 16),
    b: Number.parseInt(normalized.slice(4, 6), 16),
  };
};

const rgbToHex = ({ r, g, b }) =>
  `#${[r, g, b]
    .map((value) =>
      clamp(Math.round(value), 0, 255).toString(16).padStart(2, "0"),
    )
    .join("")}`;

const mixHex = (left, right, weight = 0.5) => {
  const ratio = clamp(Number(weight) || 0, 0, 1);
  const a = hexToRgb(left);
  const b = hexToRgb(right);
  return rgbToHex({
    r: a.r + (b.r - a.r) * ratio,
    g: a.g + (b.g - a.g) * ratio,
    b: a.b + (b.b - a.b) * ratio,
  });
};

const hexToRgba = (hex, alpha) => {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${clamp(Number(alpha) || 0, 0, 1)})`;
};

const escapeXml = (value) =>
  String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

const normalizeDisplayName = (playlistName) =>
  String(playlistName || "")
    .replace(/^\[(?:A|AS)\]\s*/i, "")
    .replace(/^Aurral(?: Shared)?\s+/i, "")
    .trim();

const normalizeKind = (kind) =>
  String(kind || "")
    .trim()
    .toLowerCase() === "flow"
    ? "Flow"
    : "Playlist";

const chunkWord = (word, limit) => {
  const chunks = [];
  const input = String(word || "");
  for (let index = 0; index < input.length; index += limit) {
    chunks.push(input.slice(index, index + limit));
  }
  return chunks;
};

const SMALL_TITLE_WORDS = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "by",
  "for",
  "in",
  "of",
  "on",
  "or",
  "the",
  "to",
  "vs",
  "with",
]);

const isSmallTitleWord = (word) => {
  const normalized = String(word || "")
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase();
  return normalized.length <= 3 || SMALL_TITLE_WORDS.has(normalized);
};

const buildTitlePhrases = (words, limit) => {
  const phrases = [];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (!isSmallTitleWord(word)) {
      phrases.push(word);
      continue;
    }

    const smallWords = [word];
    let nextIndex = index + 1;
    while (nextIndex < words.length && isSmallTitleWord(words[nextIndex])) {
      const nextPhrase = `${smallWords.join(" ")} ${words[nextIndex]}`;
      if (nextPhrase.length > limit) break;
      smallWords.push(words[nextIndex]);
      nextIndex += 1;
    }

    if (smallWords.length > 1) {
      phrases.push(smallWords.join(" "));
      index = nextIndex - 1;
      continue;
    }

    const nextWord = words[index + 1];
    if (
      nextWord &&
      !isSmallTitleWord(nextWord) &&
      `${word} ${nextWord}`.length <= limit
    ) {
      phrases.push(`${word} ${nextWord}`);
      index += 1;
      continue;
    }

    phrases.push(word);
  }
  return phrases;
};

const buildTitleLayout = (value) => {
  const input = String(value || "").trim() || "Untitled";
  const chunkLimit = input.length > 36 ? 12 : 14;
  const words = input
    .split(/\s+/)
    .flatMap((word) =>
      word.length > chunkLimit ? chunkWord(word, chunkLimit) : [word],
    )
    .filter(Boolean);
  const phrases = buildTitlePhrases(words, chunkLimit + 6);
  const lines = phrases.slice(0, TITLE_MAX_LINES);
  if (phrases.length > TITLE_MAX_LINES) {
    const lastIndex = Math.max(lines.length - 1, 0);
    const base = lines[lastIndex] || "";
    lines[lastIndex] = base.length >= chunkLimit
      ? `${base.slice(0, Math.max(chunkLimit - 1, 1)).trimEnd()}…`
      : `${base}…`;
  }

  const maxLineLength = Math.max(...lines.map((line) => line.length), 1);
  const widthLimitedSize = Math.floor(TITLE_SAFE_WIDTH / (maxLineLength * 0.58));
  const heightLimitedSize = Math.floor(TITLE_SAFE_HEIGHT / (lines.length * 1.12));
  const fontSize = clamp(
    Math.min(132, widthLimitedSize, heightLimitedSize),
    64,
    132,
  );
  const lineHeight = Math.round(fontSize * 1.1);
  const totalHeight = fontSize + lineHeight * (lines.length - 1);
  const y = Math.round(
    TITLE_SAFE_TOP +
      (TITLE_SAFE_HEIGHT - totalHeight) / 2 +
      fontSize * 0.78,
  );

  return { lines, fontSize, lineHeight, y };
};

const getPalette = (playlistName) => {
  const hash = hashString(playlistName);
  const base1 = TAG_COLORS[hash % TAG_COLORS.length];
  const base2 = TAG_COLORS[(hash + 3) % TAG_COLORS.length];
  const base3 = TAG_COLORS[(hash + 7) % TAG_COLORS.length];
  const base4 = TAG_COLORS[(hash + 11) % TAG_COLORS.length];
  return {
    bgStart: mixHex(base1, "#11131a", 0.58),
    bgEnd: mixHex(base2, "#090a0f", 0.7),
    blob1: hexToRgba(base1, 0.45),
    blob2: hexToRgba(base2, 0.35),
    blob3: hexToRgba(base3, 0.4),
    blob4: hexToRgba(base4, 0.3),
    line1: hexToRgba(base3, 0.15),
    line2: hexToRgba(base4, 0.15),
    title: "#f5f2ea",
  };
};

const generateBlobPath = (cx, cy, r, seed) => {
  const points = [];
  const numPoints = 5 + (seed % 4);
  const angleStep = (Math.PI * 2) / numPoints;

  for (let i = 0; i < numPoints; i++) {
    const angle = i * angleStep;
    const variance = 0.7 + ((seed * (i + 1) * 11) % 60) / 100;
    const pr = r * variance;
    points.push({
      x: cx + Math.cos(angle) * pr,
      y: cy + Math.sin(angle) * pr,
    });
  }

  let path = "";
  const mids = points.map((p, i) => {
    const next = points[(i + 1) % numPoints];
    return { x: (p.x + next.x) / 2, y: (p.y + next.y) / 2 };
  });

  path += `M ${mids[0].x} ${mids[0].y}`;
  for (let i = 1; i <= numPoints; i++) {
    const p = points[i % numPoints];
    const mid = mids[i % numPoints];
    path += ` Q ${p.x} ${p.y} ${mid.x} ${mid.y}`;
  }
  path += " Z";

  return path;
};

const buildArtworkSvg = ({ playlistName, kind }) => {
  const displayName = normalizeDisplayName(playlistName) || "Untitled";
  const normalizedKind = normalizeKind(kind);
  const palette = getPalette(displayName);
  const titleLayout = buildTitleLayout(displayName);
  const seed = hashString(`${normalizedKind}:${displayName}`);
  const angle = seed % 360;

  const titleMarkup = titleLayout.lines
    .map(
      (line, index) =>
        `<tspan x="500" dy="${index === 0 ? 0 : titleLayout.lineHeight}">${escapeXml(line)}</tspan>`,
    )
    .join("");

  const b1 = generateBlobPath(
    200 + (seed % 200),
    200 + ((seed >> 1) % 200),
    250 + (seed % 100),
    seed,
  );
  const b2 = generateBlobPath(
    800 - (seed % 200),
    800 - ((seed >> 2) % 200),
    300 + (seed % 150),
    seed + 1,
  );
  const b3 = generateBlobPath(
    800 - ((seed >> 3) % 200),
    200 + ((seed >> 4) % 200),
    200 + (seed % 100),
    seed + 2,
  );
  const b4 = generateBlobPath(
    200 + ((seed >> 5) % 200),
    800 - ((seed >> 6) % 200),
    250 + (seed % 100),
    seed + 3,
  );

  const lb1 = generateBlobPath(500, 500, 380, seed + 4);
  const lb2 = generateBlobPath(500, 500, 320, seed + 5);

  return `
<svg xmlns="http://www.w3.org/2000/svg" width="${ARTWORK_SIZE}" height="${ARTWORK_SIZE}" viewBox="0 0 ${ARTWORK_SIZE} ${ARTWORK_SIZE}">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${palette.bgStart}" />
      <stop offset="100%" stop-color="${palette.bgEnd}" />
    </linearGradient>
    <filter id="blur" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="24" />
    </filter>
    <filter id="noise">
      <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="3" stitchTiles="stitch" />
      <feColorMatrix type="saturate" values="0" />
    </filter>
  </defs>
  <rect width="${ARTWORK_SIZE}" height="${ARTWORK_SIZE}" fill="url(#bg)" rx="52" />
  <g filter="url(#blur)">
    <path d="${b1}" fill="${palette.blob1}" />
    <path d="${b2}" fill="${palette.blob2}" />
    <path d="${b3}" fill="${palette.blob3}" />
    <path d="${b4}" fill="${palette.blob4}" />
  </g>
  <rect width="${ARTWORK_SIZE}" height="${ARTWORK_SIZE}" filter="url(#noise)" opacity="0.28" rx="52" style="mix-blend-mode: overlay;" />
  <g transform="rotate(${angle} 500 500)">
    <path d="${lb1}" fill="none" stroke="${palette.line1}" stroke-width="2" />
    <path d="${lb2}" fill="none" stroke="${palette.line2}" stroke-width="1.5" />
  </g>
  <svg x="425" y="74" width="150" height="112" viewBox="0 0 650 485" opacity="0.72">
    <path d="${AURRAL_LOGO_PATH}" fill="${palette.title}" />
  </svg>
  <text x="500" y="${titleLayout.y}" text-anchor="middle" font-family="system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="${titleLayout.fontSize}" font-weight="800" fill="${palette.title}">${titleMarkup}</text>
</svg>`.trim();
};

export const PLAYLIST_ARTWORK_WEBP_QUALITY = 70;

export async function writePlaylistArtworkWebpFromBuffer(buffer, outputPath) {
  await sharp(buffer, { animated: false })
    .rotate()
    .resize(ARTWORK_SIZE, ARTWORK_SIZE, { fit: "cover" })
    .webp({ quality: PLAYLIST_ARTWORK_WEBP_QUALITY })
    .toFile(outputPath);
}

export async function writePlaylistArtworkSidecar({
  playlistName,
  kind,
  outputPath,
}) {
  const svg = buildArtworkSvg({ playlistName, kind });
  const webpPath = outputPath.replace(/\.(png|webp)$/i, ".webp");
  await sharp(Buffer.from(svg))
    .webp({ quality: PLAYLIST_ARTWORK_WEBP_QUALITY })
    .toFile(webpPath);
}

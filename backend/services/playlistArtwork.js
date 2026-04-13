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

const buildTitleLines = (value) => {
  const input = String(value || "").trim() || "Untitled";
  const target = input.length > 24 ? 13 : input.length > 16 ? 16 : 20;
  const words = input
    .split(/\s+/)
    .flatMap((word) =>
      word.length > target ? chunkWord(word, target) : [word],
    )
    .filter(Boolean);
  const lines = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length <= target || !current) {
      current = next;
      continue;
    }
    lines.push(current);
    current = word;
    if (lines.length === 2) break;
  }
  if (lines.length < 2 && current) {
    lines.push(current);
  }
  if (lines.length > 2) {
    lines.length = 2;
  }
  const consumed = lines.join(" ").length;
  if (consumed < input.length) {
    const lastIndex = Math.max(lines.length - 1, 0);
    const base = lines[lastIndex] || input.slice(0, target);
    lines[lastIndex] =
      base.length >= target
        ? `${base.slice(0, Math.max(target - 1, 1)).trimEnd()}…`
        : `${base}…`;
  }
  return lines.slice(0, 2);
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
    chip: mixHex(base1, "#ffffff", 0.22),
    chipStroke: hexToRgba("#ffffff", 0.16),
    line1: hexToRgba(base3, 0.15),
    line2: hexToRgba(base4, 0.15),
    title: "#f5f2ea",
    subtitle: "rgba(245, 242, 234, 0.76)",
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
  const titleLines = buildTitleLines(displayName);
  const titleY = titleLines.length === 1 ? 500 : 450;
  const titleSize = titleLines.some((line) => line.length > 16) ? 104 : 116;
  const seed = hashString(`${normalizedKind}:${displayName}`);
  const angle = seed % 360;

  const chipWidth = normalizedKind === "Flow" ? 188 : 220;
  const chipX = (ARTWORK_SIZE - chipWidth) / 2;
  const titleMarkup = titleLines
    .map(
      (line, index) =>
        `<tspan x="500" dy="${index === 0 ? 0 : 128}">${escapeXml(line)}</tspan>`,
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
  <rect x="${chipX}" y="136" width="${chipWidth}" height="58" rx="29" fill="${palette.chip}" stroke="${palette.chipStroke}" />
  <text x="500" y="174" text-anchor="middle" font-family="system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="28" font-weight="700" fill="${palette.subtitle}">${normalizedKind.toUpperCase().split("").join(" ")}</text>
  <text x="500" y="${titleY}" text-anchor="middle" font-family="system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="${titleSize}" font-weight="800" fill="${palette.title}">${titleMarkup}</text>
  <text x="500" y="878" text-anchor="middle" font-family="system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="28" font-weight="600" fill="${palette.subtitle}">A U R R A L</text>
</svg>`.trim();
};

export async function writePlaylistArtworkSidecar({
  playlistName,
  kind,
  outputPath,
}) {
  const svg = buildArtworkSvg({ playlistName, kind });
  await sharp(Buffer.from(svg))
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toFile(outputPath);
}

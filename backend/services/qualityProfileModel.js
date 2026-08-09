import path from "path";

export const QUALITY_TIERS = [
  { id: "flac-hires", label: "FLAC hi-res", family: "flac" },
  { id: "flac-standard", label: "FLAC standard", family: "flac" },
  { id: "mp3-320", label: "MP3 320", family: "mp3", bitrate: 320 },
  { id: "m4a-320", label: "M4A 320", family: "m4a", bitrate: 320 },
  { id: "mp3-256", label: "MP3 256", family: "mp3", bitrate: 256 },
  { id: "m4a-256", label: "M4A 256", family: "m4a", bitrate: 256 },
  { id: "mp3-192", label: "MP3 192", family: "mp3", bitrate: 192 },
  { id: "m4a-192", label: "M4A 192", family: "m4a", bitrate: 192 },
  { id: "mp3-128", label: "MP3 128", family: "mp3", bitrate: 128 },
  { id: "m4a-128", label: "M4A 128", family: "m4a", bitrate: 128 },
];

const TIER_BY_ID = new Map(QUALITY_TIERS.map((tier) => [tier.id, tier]));

export function createDefaultQualityProfile(slskd = {}) {
  const preferred = String(slskd?.preferredFormat || "flac").toLowerCase() === "mp3"
    ? "mp3"
    : "flac";
  const strict = slskd?.preferredFormatStrict === true;
  const preferredIds = QUALITY_TIERS.filter((tier) => tier.family === preferred).map(
    (tier) => tier.id,
  );
  const otherIds = QUALITY_TIERS.filter((tier) => tier.family !== preferred).map(
    (tier) => tier.id,
  );
  const order = preferred === "flac"
    ? QUALITY_TIERS.map((tier) => tier.id)
    : [...preferredIds, ...otherIds];
  return {
    order,
    enabled: strict
      ? preferredIds
      : QUALITY_TIERS.map((tier) => tier.id),
    cutoff: preferred === "mp3" ? "mp3-320" : "flac-standard",
    automaticUpgrades: false,
    intervalDays: 2,
  };
}

export function normalizeQualityProfile(value, slskd = {}) {
  const fallback = createDefaultQualityProfile(slskd);
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const order = [];
  for (const id of Array.isArray(raw.order) ? raw.order : fallback.order) {
    const safeId = String(id || "").trim();
    if (TIER_BY_ID.has(safeId) && !order.includes(safeId)) order.push(safeId);
  }
  for (const tier of QUALITY_TIERS) {
    if (!order.includes(tier.id)) order.push(tier.id);
  }
  const enabled = [];
  for (const id of Array.isArray(raw.enabled) ? raw.enabled : fallback.enabled) {
    const safeId = String(id || "").trim();
    if (TIER_BY_ID.has(safeId) && !enabled.includes(safeId)) enabled.push(safeId);
  }
  if (enabled.length === 0) enabled.push(order[0]);
  const requestedCutoff = String(raw.cutoff || fallback.cutoff).trim();
  const cutoff = enabled.includes(requestedCutoff)
    ? requestedCutoff
    : order.find((id) => enabled.includes(id));
  const parsedInterval = Number(raw.intervalDays);
  return {
    order,
    enabled,
    cutoff,
    automaticUpgrades: raw.automaticUpgrades === true,
    intervalDays: Number.isFinite(parsedInterval)
      ? Math.min(365, Math.max(1, Math.round(parsedInterval)))
      : 2,
  };
}

function readAudioFamily(parsed, filePath) {
  const ext = path.extname(String(filePath || "")).toLowerCase();
  const container = String(parsed?.format?.container || "").toLowerCase();
  const codec = String(parsed?.format?.codec || "").toLowerCase();
  const lossless = parsed?.format?.lossless === true;
  if (ext === ".flac" || container.includes("flac") || codec.includes("flac")) {
    return lossless === false ? null : "flac";
  }
  if (lossless) return null;
  if (ext === ".mp3" || container.includes("mpeg") && !container.includes("4") || codec.includes("mp3")) {
    return "mp3";
  }
  if (
    ext === ".m4a" ||
    ext === ".aac" ||
    container.includes("mp4") ||
    container.includes("m4a") ||
    codec.includes("aac")
  ) {
    return "m4a";
  }
  return null;
}

function classifyLossyTier(family, bitrateKbps) {
  if (!Number.isFinite(bitrateKbps) || bitrateKbps < 128) return null;
  if (bitrateKbps >= 320) return `${family}-320`;
  if (bitrateKbps >= 256) return `${family}-256`;
  if (bitrateKbps >= 192) return `${family}-192`;
  return `${family}-128`;
}

export function classifyAudioQuality(parsed, filePath) {
  const family = readAudioFamily(parsed, filePath);
  const sampleRate = Number(parsed?.format?.sampleRate);
  const bitDepth = Number(parsed?.format?.bitsPerSample);
  const bitrate = Number(parsed?.format?.bitrate);
  const bitrateKbps = Number.isFinite(bitrate) && bitrate > 0
    ? Math.round(bitrate / 1000)
    : null;
  let tier = null;
  if (family === "flac" && Number.isFinite(sampleRate) && Number.isFinite(bitDepth)) {
    tier = bitDepth > 16 || sampleRate > 48000 ? "flac-hires" : "flac-standard";
  } else if (family === "mp3" || family === "m4a") {
    tier = classifyLossyTier(family, bitrateKbps);
  }
  return {
    tier,
    format: family,
    bitrateKbps,
    sampleRate: Number.isFinite(sampleRate) ? Math.round(sampleRate) : null,
    bitDepth: Number.isFinite(bitDepth) ? Math.round(bitDepth) : null,
  };
}

export function getQualityState(classification, profile) {
  const normalized = normalizeQualityProfile(profile);
  const tier = String(classification?.tier || "");
  const enabled = new Set(normalized.enabled);
  if (!tier || !enabled.has(tier)) return "below-floor";
  const rank = normalized.order.indexOf(tier);
  const cutoffRank = normalized.order.indexOf(normalized.cutoff);
  return rank <= cutoffRank ? "preferred" : "upgrade";
}

export function isQualityUpgrade(candidate, currentTier, profile) {
  const normalized = normalizeQualityProfile(profile);
  const enabled = new Set(normalized.enabled);
  const candidateTier = String(candidate?.tier || "");
  if (!candidateTier || !enabled.has(candidateTier)) return false;
  if (!currentTier || !enabled.has(currentTier)) return true;
  return normalized.order.indexOf(candidateTier) < normalized.order.indexOf(currentTier);
}

export function getQualityTier(id) {
  return TIER_BY_ID.get(String(id || "")) || null;
}

export function classifyAdvertisedQuality(fileName, bitrate = null) {
  const text = String(fileName || "").toLowerCase();
  if (/\.flac\b|\bflac\b/.test(text)) {
    return /\b(?:24[ -]?bit|(?:88\.2|96|176\.4|192)\s*k?hz)\b/.test(text)
      ? "flac-hires"
      : "flac-standard";
  }
  const family = /\.mp3\b|\bmp3\b/.test(text)
    ? "mp3"
    : /\.(?:m4a|aac)\b|\b(?:m4a|aac)\b/.test(text)
      ? "m4a"
      : null;
  if (!family) return null;
  const textBitrate = /\b(128|192|256|320)\s*k(?:bps)?\b/.exec(text);
  const measured = Number(bitrate);
  const value = Number(textBitrate?.[1] || (Number.isFinite(measured) ? measured : 0));
  if (value >= 320) return `${family}-320`;
  if (value >= 256) return `${family}-256`;
  if (value >= 192) return `${family}-192`;
  if (value >= 128) return `${family}-128`;
  return null;
}

export function orderAdvertisedQualityCandidates(
  entries,
  { profile, currentTier = null, upgrade = false, readName, readBitrate } = {},
) {
  const normalized = normalizeQualityProfile(profile);
  const enabled = new Set(normalized.enabled);
  return (Array.isArray(entries) ? entries : [])
    .map((entry, index) => ({
      entry,
      index,
      tier: classifyAdvertisedQuality(readName?.(entry), readBitrate?.(entry)),
    }))
    .filter(({ tier }) =>
      !tier || enabled.has(tier) && (!upgrade || isQualityUpgrade({ tier }, currentTier, normalized)),
    )
    .sort((left, right) => {
      if (!left.tier && !right.tier) return left.index - right.index;
      if (!left.tier) return 1;
      if (!right.tier) return -1;
      const rank = normalized.order.indexOf(left.tier) - normalized.order.indexOf(right.tier);
      return rank || left.index - right.index;
    })
    .map(({ entry }) => entry);
}

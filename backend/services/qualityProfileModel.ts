import path from "path";
import type { IFormat } from "music-metadata";
import type { StoredIntegrations } from "../db/helpers/settings.ts";
import { QUALITY_PRESETS, QUALITY_TIERS } from "../../lib/qualityTiers.ts";

type SlskdSettings = StoredIntegrations["slskd"];
type ParsedAudio =
  | {
      format?: {
        [K in "container" | "codec" | "lossless" | "sampleRate" | "bitsPerSample" | "bitrate"]?:
          | IFormat[K]
          | null;
      };
    }
  | null
  | undefined;
type ProfileInput = {
  order?: unknown;
  enabled?: unknown;
  cutoff?: unknown;
  automaticUpgrades?: unknown;
  intervalDays?: unknown;
};

const TIER_BY_ID = new Map(QUALITY_TIERS.map((tier) => [tier.id, tier]));

export function createDefaultQualityProfile(slskd: SlskdSettings = {}) {
  const preferred =
    String(slskd?.preferredFormat || "flac").toLowerCase() === "mp3" ? "mp3" : "flac";
  const preset = QUALITY_PRESETS[preferred === "mp3" ? "smaller" : "lossless"];
  return {
    order: preset.order,
    enabled:
      slskd?.preferredFormatStrict === true
        ? QUALITY_TIERS.filter((tier) => tier.family === preferred).map((tier) => tier.id)
        : preset.enabled,
    cutoff: preset.cutoff,
    automaticUpgrades: false,
    intervalDays: 2,
  };
}

export function normalizeIntervalDays(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(365, Math.max(1, Math.round(parsed))) : fallback;
}

export function normalizeQualityProfile(value: unknown, slskd: SlskdSettings = {}) {
  const fallback = createDefaultQualityProfile(slskd);
  const raw: ProfileInput =
    value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const order: string[] = [];
  for (const id of Array.isArray(raw.order) ? raw.order : fallback.order) {
    const safeId = String(id || "").trim();
    if (TIER_BY_ID.has(safeId) && !order.includes(safeId)) order.push(safeId);
  }
  for (const tier of QUALITY_TIERS) {
    if (!order.includes(tier.id)) order.push(tier.id);
  }
  const enabled: string[] = [];
  for (const id of Array.isArray(raw.enabled) ? raw.enabled : fallback.enabled) {
    const safeId = String(id || "").trim();
    if (TIER_BY_ID.has(safeId) && !enabled.includes(safeId)) enabled.push(safeId);
  }
  const [firstTier] = order;
  if (enabled.length === 0 && firstTier) enabled.push(firstTier);
  const requestedCutoff = String(raw.cutoff || fallback.cutoff).trim();
  const cutoff = enabled.includes(requestedCutoff)
    ? requestedCutoff
    : (order.find((id) => enabled.includes(id)) as string);
  return {
    order,
    enabled,
    cutoff,
    automaticUpgrades: raw.automaticUpgrades === true,
    intervalDays: normalizeIntervalDays(raw.intervalDays, 2),
  };
}

function readAudioFamily(parsed: ParsedAudio, filePath: string) {
  const ext = path.extname(String(filePath || "")).toLowerCase();
  const container = String(parsed?.format?.container || "").toLowerCase();
  const codec = String(parsed?.format?.codec || "").toLowerCase();
  const lossless = parsed?.format?.lossless === true || codec.includes("alac");
  if (ext === ".flac" || container.includes("flac") || codec.includes("flac")) {
    return parsed?.format?.lossless === false ? null : "flac";
  }
  if (lossless) return null;
  if (
    ext === ".mp3" ||
    (container.includes("mpeg") && !container.includes("4")) ||
    codec.includes("mp3")
  ) {
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

function classifyLossyTier(family: "mp3" | "m4a", bitrateKbps: number | null) {
  if (bitrateKbps === null || !Number.isFinite(bitrateKbps) || bitrateKbps < 128) return null;
  if (bitrateKbps >= 320) return `${family}-320`;
  if (bitrateKbps >= 256) return `${family}-256`;
  if (bitrateKbps >= 192) return `${family}-192`;
  return `${family}-128`;
}

export function classifyAudioQuality(parsed: ParsedAudio, filePath: string) {
  const family = readAudioFamily(parsed, filePath);
  const sampleRate = Number(parsed?.format?.sampleRate);
  const bitDepth = Number(parsed?.format?.bitsPerSample);
  const bitrate = Number(parsed?.format?.bitrate);
  const bitrateKbps = Number.isFinite(bitrate) && bitrate > 0 ? Math.round(bitrate / 1000) : null;
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

export type QualityState = "below-floor" | "upgrade" | "preferred" | "external";

export function getQualityState(
  classification: { tier?: string | null } | null | undefined,
  profile: unknown,
): Exclude<QualityState, "external"> {
  const normalized = normalizeQualityProfile(profile);
  const tier = String(classification?.tier || "");
  const enabled = new Set(normalized.enabled);
  if (!tier || !enabled.has(tier)) return "below-floor";
  const rank = normalized.order.indexOf(tier);
  const cutoffRank = normalized.order.indexOf(normalized.cutoff);
  return rank <= cutoffRank ? "preferred" : "upgrade";
}

export function isQualityUpgrade(
  candidate: { tier?: string | null } | null | undefined,
  currentTier: string | null | undefined,
  profile: unknown,
) {
  const normalized = normalizeQualityProfile(profile);
  const enabled = new Set(normalized.enabled);
  const candidateTier = String(candidate?.tier || "");
  if (!candidateTier || !enabled.has(candidateTier)) return false;
  const rank = normalized.order.indexOf(candidateTier);
  if (!currentTier) return rank <= normalized.order.indexOf(normalized.cutoff);
  if (!enabled.has(currentTier)) return true;
  return rank < normalized.order.indexOf(currentTier);
}

export function getQualityTier(id: unknown) {
  return TIER_BY_ID.get(String(id || "")) || null;
}

function advertisedLossyFamily(text: string) {
  if (/\.mp3\b|\bmp3\b/.test(text)) return "mp3";
  if (/\.(?:m4a|aac)\b|\b(?:m4a|aac)\b/.test(text)) return "m4a";
  return null;
}

export type AdvertisedAudio = {
  bitDepth?: unknown;
  sampleRate?: unknown;
};

function positiveNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

const BRACKETED_FLAC_QUALITY =
  /[[(]\s*(16|24|32)\s*(?:bit|b)?\s*[-/]\s*(44\.1|48|88\.2|96|176\.4|192|352\.8|384)\s*(?:k?hz)?\s*[\])]/;

function advertisedBitDepth(text: string) {
  const tagged = /\b(16|24|32)(?:-?\s*bit\b|b\b)/.exec(text);
  if (tagged?.[1]) return Number(tagged[1]);
  const paired = BRACKETED_FLAC_QUALITY.exec(text);
  return paired?.[1] ? Number(paired[1]) : null;
}

function advertisedSampleRate(text: string) {
  const tagged = /\b(44\.1|48|88\.2|96|176\.4|192|352\.8|384)\s*k?hz\b/.exec(text);
  if (tagged?.[1]) return Math.round(Number(tagged[1]) * 1000);
  const paired = BRACKETED_FLAC_QUALITY.exec(text);
  return paired?.[2] ? Math.round(Number(paired[2]) * 1000) : null;
}

function advertisedFlacTier(text: string, advertised: AdvertisedAudio | null) {
  const bitDepth = positiveNumber(advertised?.bitDepth) ?? advertisedBitDepth(text);
  const sampleRate = positiveNumber(advertised?.sampleRate) ?? advertisedSampleRate(text);
  return (bitDepth !== null && bitDepth > 16) || (sampleRate !== null && sampleRate > 48000)
    ? "flac-hires"
    : "flac-standard";
}

export function classifyAdvertisedQuality(
  fileName: unknown,
  bitrate: unknown = null,
  advertised: AdvertisedAudio | null = null,
) {
  const text = String(fileName || "").toLowerCase();
  if (/\.flac\b|\bflac\b/.test(text)) return advertisedFlacTier(text, advertised);
  const family = advertisedLossyFamily(text);
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

const NEVER_TIERED_ADVERTISED_EXTENSION =
  /\.(?:opus|ogg|oga|wma|wav|aiff?|ape|mpc|ac3|dts|mka)\s*$/i;

export function isAdvertisedQualityEligible(
  fileName: unknown,
  bitrate: unknown,
  {
    profile,
    currentTier = null,
    upgrade = false,
    advertised = null,
  }: {
    profile?: unknown;
    currentTier?: string | null;
    upgrade?: boolean;
    advertised?: AdvertisedAudio | null;
  } = {},
) {
  const normalized = normalizeQualityProfile(profile);
  const tier = classifyAdvertisedQuality(fileName, bitrate, advertised);
  if (!tier) {
    const name = String(fileName || "").trim();
    if (NEVER_TIERED_ADVERTISED_EXTENSION.test(name)) return false;
    const family = advertisedLossyFamily(name.toLowerCase());
    return (
      !upgrade ||
      !family ||
      normalized.enabled.some(
        (id) =>
          id.startsWith(`${family}-`) && isQualityUpgrade({ tier: id }, currentTier, normalized),
      )
    );
  }
  return (
    normalized.enabled.includes(tier) &&
    (!upgrade || isQualityUpgrade({ tier }, currentTier, normalized))
  );
}

export function getAdvertisedQualityRank(
  fileName: unknown,
  bitrate: unknown,
  {
    profile,
    advertised = null,
  }: {
    profile?: unknown;
    advertised?: AdvertisedAudio | null;
  } = {},
) {
  const normalized = normalizeQualityProfile(profile);
  const tier = classifyAdvertisedQuality(fileName, bitrate, advertised);
  const index = tier === null ? -1 : normalized.order.indexOf(tier);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

export function orderAdvertisedQualityCandidates<T>(
  entries: T[],
  {
    profile,
    currentTier = null,
    upgrade = false,
    readName,
    readBitrate,
    readAdvertised,
  }: {
    profile?: unknown;
    currentTier?: string | null;
    upgrade?: boolean;
    readName?: (entry: T) => string | null | undefined;
    readBitrate?: (entry: T) => unknown;
    readAdvertised?: (entry: T) => AdvertisedAudio | null | undefined;
  } = {},
) {
  const normalized = normalizeQualityProfile(profile);
  return (Array.isArray(entries) ? entries : [])
    .map((entry, index) => {
      const name = readName?.(entry);
      return {
        entry,
        index,
        name,
        tier: classifyAdvertisedQuality(name, readBitrate?.(entry), readAdvertised?.(entry)),
      };
    })
    .filter(({ entry, name }) => {
      const advertised = readAdvertised?.(entry) ?? null;
      return isAdvertisedQualityEligible(name, readBitrate?.(entry), {
        profile: normalized,
        currentTier,
        upgrade,
        advertised,
      });
    })
    .sort((left, right) => {
      if (!left.tier && !right.tier) return left.index - right.index;
      if (!left.tier) return 1;
      if (!right.tier) return -1;
      const rank = normalized.order.indexOf(left.tier) - normalized.order.indexOf(right.tier);
      return rank || left.index - right.index;
    })
    .map(({ entry }) => entry);
}

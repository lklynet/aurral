// Aurral-owned semantic variant policy.
//
// beets' string distance under-penalizes parenthesized descriptors ("Get
// Lucky" vs "Get Lucky (Live)" is only ~0.1), so variant contradictions are
// detected here BEFORE candidates reach beets. Contradictions are
// non-overridable: positive fuzzy-title evidence must never outweigh them.
//
// Variant detection is intentionally conservative: it only fires on explicit
// descriptors, never on words that commonly appear inside real titles
// (e.g. "Live and Let Die", "Demon Days").

const MIX_VARIANT_PATTERNS = [
  { value: "radio_edit", pattern: /\bradio\s+edit\b/ },
  { value: "single_edit", pattern: /\bsingle\s+edit\b/ },
  { value: "extended", pattern: /\b(?:extended(?:\s+mix)?|full\s+length|long(?:\s+version)?|extended\s+version)\b/ },
  { value: "club_mix", pattern: /\b(?:club\s+mix|club\s+edit)\b/ },
  {
    value: "remix",
    pattern:
      /\b(?:remix|rework|bootleg|vip\s?(?:mix|edit)|mash\s?-?\s?up|mix\s?(?:2024|20\d\d))\b/,
  },
];

const VARIANT_PATTERNS = [
  {
    value: "live",
    pattern:
      /\((?:live\b|live at[^)]*)\)|\[(?:live\b|live at[^\]]*)\]|\b(?:live at|live from|live version|live recording|live session)\b|(?:\s-|\s–)\s*live\b/i,
  },
  { value: "concert", pattern: /\b(?:concert|in\s+concert)\b/i },
  { value: "acoustic", pattern: /\bacoustic(?:\s+version)?\b/i },
  { value: "instrumental", pattern: /\binstrumental\b/i },
  { value: "karaoke", pattern: /\bkaraoke(?:\s+version)?\b/i },
  { value: "demo", pattern: /\bdemo(?:\s+version|s)?\b|\bouttake/i },
  { value: "cover", pattern: /\b(?:cover|covered\s+by|tribute(?:\s+(?:band|album))?|rerecorded|re-recorded)\b/i },
  { value: "sped_up", pattern: /\bsped\s*up\b/i },
  { value: "slowed", pattern: /\bslowed(?:\s*(?:\+|and|&|n)\s*reverb)?\b|\breverb\s*slowed\b/i },
  { value: "nightcore", pattern: /\bnightcore\b/i },
  { value: "eight_d", pattern: /\b8d\s*audio\b/i },
  { value: "remaster", pattern: /\b(?:re-?master(?:ed)?|20\d\d\s*re-?master)\b/i },
  { value: "rehearsal", pattern: /\brehearsal\b/i },
];

const NOISE_PATTERNS = [
  { value: "reaction", pattern: /\breaction\b/i },
  { value: "tutorial", pattern: /\b(?:tutorial|lesson|how\s+to\s+play)\b/i },
  { value: "full_album", pattern: /\bfull\s+album\b/i },
  { value: "discography", pattern: /\bdiscography\b/i },
  { value: "fan_made", pattern: /\bfan.?made\b/i },
  { value: "loop", pattern: /\b(?:10\s*hour|10hr|hours?\s+long|1\s*hour\s+version)\b/i },
];

function normalizeVariantText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractVariants(value) {
  const rawText = String(value || "");
  const text = normalizeVariantText(rawText);
  const variants = {
    live: false,
    acoustic: false,
    instrumental: false,
    karaoke: false,
    demo: false,
    cover: false,
    sped_up: false,
    slowed: false,
    nightcore: false,
    eight_d: false,
    remaster: false,
    remix: false,
  };
  for (const { value: name, pattern } of VARIANT_PATTERNS) {
    if (pattern.test(rawText) || pattern.test(text)) variants[name] = true;
  }
  const mixVariant =
    MIX_VARIANT_PATTERNS.find((entry) => entry.pattern.test(text))?.value || null;
  if (mixVariant === "remix") variants.remix = true;
  const monoStereo = /\bmono\b/.test(text)
    ? "mono"
    : /\bstereo\b/.test(text)
      ? "stereo"
      : null;
  const contentRating = /\bclean\b/.test(text)
    ? "clean"
    : /\bexplicit\b/.test(text)
      ? "explicit"
      : null;
  return {
    ...variants,
    mixVariant,
    monoStereo,
    contentRating,
  };
}

export function detectNoise(value) {
  const text = normalizeVariantText(value);
  if (!text) return [];
  return NOISE_PATTERNS.filter((entry) => entry.pattern.test(text)).map(
    (entry) => entry.value,
  );
}

// Variants where ANY difference between the requested and offered version is
// a hard contradiction (mirrors the Soulseek matcher's hardMismatch set, so
// the shared layer never loosens existing behavior).
const CONTRADICTION_VARIANTS = [
  "live",
  "concert",
  "acoustic",
  "demo",
  "instrumental",
  "karaoke",
  "cover",
  "sped_up",
  "slowed",
  "nightcore",
  "eight_d",
];

function contradictionLabel(variantName) {
  return variantName;
}

export function compareVariantProfiles(expected, actual) {
  const contradictions = [];
  let score = 0;

  for (const name of CONTRADICTION_VARIANTS) {
    if (expected[name] && actual[name]) {
      score += 12;
    } else if (Boolean(expected[name]) !== Boolean(actual[name])) {
      contradictions.push(contradictionLabel(name));
      score -= 80;
    }
  }

  if (expected.mixVariant && actual.mixVariant) {
    if (expected.mixVariant === actual.mixVariant) {
      score += 10;
    } else {
      contradictions.push(actual.mixVariant);
      score -= 90;
    }
  } else if (actual.mixVariant) {
    contradictions.push(actual.mixVariant);
    score -= 90;
  } else if (expected.mixVariant) {
    score -= 20;
  }

  if (expected.monoStereo && actual.monoStereo) {
    score += expected.monoStereo === actual.monoStereo ? 6 : -10;
  } else if (expected.monoStereo || actual.monoStereo) {
    score -= 6;
  }

  // Clean/explicit matters only when explicitly requested: a requested
  // rating contradicts a differently-rated candidate, but an unqualified
  // request must not reject a rated one.
  if (expected.contentRating && actual.contentRating) {
    if (expected.contentRating === actual.contentRating) {
      score += 4;
    } else {
      contradictions.push(`content-rating-${actual.contentRating}`);
      score -= 80;
    }
  } else if (expected.contentRating && !actual.contentRating) {
    score -= 10;
  } else if (actual.contentRating) {
    score -= 6;
  }

  return { score, contradictions };
}

const MERGEABLE_VARIANT_KEYS = [
  ...CONTRADICTION_VARIANTS,
  "remaster",
  "mixVariant",
  "monoStereo",
  "contentRating",
];

export function mergeVariantProfiles(primary, secondary) {
  if (!secondary) return primary;
  const merged = { ...primary };
  for (const key of MERGEABLE_VARIANT_KEYS) {
    if (secondary[key]) merged[key] = secondary[key];
  }
  return merged;
}

// A requested variant profile is built from the requested track name plus any
// explicit variant hints carried by the request context.
export function buildRequestVariantProfile(request) {
  const fromTitle = extractVariants(request?.trackName);
  const requested = request?.variants;
  if (!requested || typeof requested !== "object") return fromTitle;
  const merged = { ...fromTitle };
  for (const key of MERGEABLE_VARIANT_KEYS) {
    if (requested[key] != null) merged[key] = requested[key];
  }
  return merged;
}

export function checkVariantCompatibility(request, candidate) {
  const expected = buildRequestVariantProfile(request);
  // Only the offered title and file name contribute variant evidence. Folder
  // and album names describe the release around the file, not the file
  // itself, and must not create contradictions.
  const candidateText = [candidate?.title, candidate?.filename]
    .filter(Boolean)
    .join(" ");
  const actual = mergeVariantProfiles(
    extractVariants(candidateText),
    candidate?.variants && typeof candidate.variants === "object"
      ? candidate.variants
      : null,
  );
  const { score, contradictions } = compareVariantProfiles(expected, actual);
  return {
    compatible: contradictions.length === 0,
    contradictions,
    variantScore: score,
    expectedVariants: expected,
    candidateVariants: actual,
  };
}

// Words inside a parenthesized/bracketed group that mark the group as a
// version descriptor rather than part of the work's title.
const DESCRIPTOR_GROUP_WORDS = new Set([
  "live",
  "concert",
  "acoustic",
  "instrumental",
  "karaoke",
  "demo",
  "cover",
  "sped",
  "up",
  "slowed",
  "reverb",
  "nightcore",
  "8d",
  "remaster",
  "remastered",
  "remix",
  "rework",
  "bootleg",
  "mashup",
  "radio",
  "single",
  "extended",
  "club",
  "mono",
  "stereo",
  "rehearsal",
  "version",
  "edit",
  "mix",
]);

// Groups that carry no identity information at all (uploader/label noise).
const PROMO_GROUP_WORDS = new Set([
  "official",
  "audio",
  "video",
  "lyric",
  "lyrics",
  "visualizer",
  "hd",
  "hq",
  "4k",
  "mv",
  "topic",
]);

function groupWords(inner) {
  return normalizeVariantText(inner).split(" ").filter(Boolean);
}

function isDescriptorGroup(inner) {
  // "Live at Wembley" or "2011 Remaster" carry extra words next to the
  // descriptor, so a single descriptor word is enough to classify the group.
  const words = groupWords(inner);
  return words.some((word) => DESCRIPTOR_GROUP_WORDS.has(word));
}

function isPromoGroup(inner) {
  const words = groupWords(inner);
  return words.length > 0 && words.every((word) => PROMO_GROUP_WORDS.has(word));
}

// Version descriptors move a lot in file and video titles. beets string
// distance only lightly penalizes them, but the semantic policy has already
// judged variant compatibility — so identity scoring compares core titles.
// Descriptors preserved via extractVariants() never reach this function
// destructively.
export function stripPromoDescriptors(value) {
  let text = String(value || "").trim();
  text = text.replace(/[([]([^)\]]*)[)\]]/g, (group, inner) => (isPromoGroup(inner) ? " " : group));
  return text.replace(/\s+/g, " ").trim();
}

export function getCoreTitle(value) {
  let text = String(value || "").trim();
  text = stripPromoDescriptors(text);
  // Leading track numbers ("07. Song", "01 - Song"). A bare space after the
  // number is not enough, so numeric artist names ("50 Cent") survive.
  text = text.replace(/^\d{1,3}(?:\s*[-._)\]]|\s+-\s+)\s*/, "");
  text = text.replace(/[([]([^)\]]*)[)\]]/g, (group, inner) =>
    isDescriptorGroup(inner) ? " " : group,
  );
  // Trailing dash-separated descriptors: "Song - Live at Wembley",
  // "Song - Radio Edit", "Song - 2011 Remaster".
  text = text.replace(
    /\s+(?:-|–|—)\s+[^-–—]*$/,
    (suffix) => (isDescriptorGroup(suffix.replace(/\s+(?:-|–|—)\s+/, "")) ? " " : suffix),
  );
  return text.replace(/\s+/g, " ").trim() || String(value || "").trim();
}

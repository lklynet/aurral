import { getPathParts } from "./candidateNormalizer.js";
import { foldDiacritics } from "../providers/brainzmashRanking.js";
import { coreAlbumTitle, discFolderNumber, isReleaseNoiseWord } from "./titleText.js";

// Aurral-owned semantic variant policy.
//
// Variant contradictions are non-overridable: positive title evidence must
// never outweigh them.
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
      /\b(?:remix|rework(?:ed)?|bootleg|vip\s?(?:mix|edit)|mash\s?-?\s?up|workout\s+mix|mix\s?(?:2024|20\d\d))\b/,
  },
  { value: "alternate_mix", pattern: /\b(?:alternat(?:e|ive)\s+(?:mix(?:es)?|versions?|takes?)|stereo\s+mix(?:es)?)\b/ },
];

const VARIANT_PATTERNS = [
  {
    value: "live",
    pattern:
      /\(\s*live\b[^)]*\)|\[\s*live\b[^\]]*\]|\b(?:live at|live from|live version|live recording|live session)\b|(?:\s-|\s–)\s*live\b/i,
  },
  { value: "concert", pattern: /\b(?:concert|in\s+concert)\b/i },
  { value: "acoustic", pattern: /\b(?:acoustic(?:\s+version)?|unplugged)\b/i },
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
  // "(Original Mix) [2013]" is not a "Mix 2013".
  const groups = rawText.split(/[()[\]{}]/u).map(normalizeVariantText);
  const mixVariant =
    MIX_VARIANT_PATTERNS.find((entry) => groups.some((group) => entry.pattern.test(group)))?.value || null;
  if (mixVariant === "remix") variants.remix = true;
  const monoStereo = /\bmono\b/.test(text)
    ? "mono"
    : /\bstereo\b/.test(text)
      ? "stereo"
      : null;
  const contentRating = /\b(?:clean|edited|censored)\b/.test(text)
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

// At its place on a release a file is that release's mix, whatever its
// title calls it, so only a request's candidates are held to these.
export const RELEASE_MIX_VARIANTS = new Set(["alternate_mix", "mono", "stereo"]);

function contradictionLabel(variantName) {
  return variantName;
}

// `allowed` names versions the request's artist or album carries, such as a
// live album: an offered title may say so without the requested title saying
// it too.
export function compareVariantProfiles(expected, actual, allowed = null) {
  const contradictions = [];
  let score = 0;

  for (const name of CONTRADICTION_VARIANTS) {
    if (expected[name] && actual[name]) {
      score += 12;
    } else if (actual[name] && allowed?.has(name)) {
      continue;
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
  } else if (actual.mixVariant && allowed?.has(actual.mixVariant)) {
    // A remix album's tracks are remixes, and a stereo mix album's are
    // stereo mixes.
  } else if (actual.mixVariant) {
    contradictions.push(actual.mixVariant);
    score -= 90;
  } else if (expected.mixVariant) {
    score -= 20;
  }

  // Album titles rarely say which mix they are, so an unrequested "Mono"
  // is soft: the 1960s catalogs label their own album tracks so.
  if (expected.monoStereo && actual.monoStereo) {
    if (expected.monoStereo === actual.monoStereo) {
      score += 6;
    } else {
      contradictions.push(actual.monoStereo);
      score -= 80;
    }
  } else if (expected.monoStereo || actual.monoStereo) {
    score -= 6;
  }

  // A requested rating contradicts a differently rated candidate. An
  // unqualified request is the release version: an "explicit" label is soft
  // evidence, but a clean or edited copy is censored audio.
  if (expected.contentRating && actual.contentRating) {
    if (expected.contentRating === actual.contentRating) {
      score += 4;
    } else {
      contradictions.push(`content-rating-${actual.contentRating}`);
      score -= 80;
    }
  } else if (expected.contentRating && !actual.contentRating) {
    score -= 10;
  } else if (actual.contentRating === "clean") {
    contradictions.push("content-rating-clean");
    score -= 80;
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

// Versions no one files an original recording under, even in a share's top
// folder.
const NEVER_ORIGINAL_VARIANTS = new Set(["karaoke", "sped_up", "slowed", "nightcore", "eight_d"]);

// Version words in a release, folder, or credit name, wherever they stand.
// "Covers" alone names artwork ("[FLAC+Covers]", "Covers-Album Art") or a
// label ("Run for Cover Records"), and "bonus" or "deluxe" an edition, not a
// version.
const LABEL_VERSIONS = [
  ["live", / live /u],
  ["concert", / concert /u],
  ["acoustic", / (?:acoustic|unplugged) /u],
  ["instrumental", / instrumentals? /u],
  ["karaoke", / karaoke /u],
  ["demo", / (?:demos?|outtakes?) /u],
  ["cover", / (?:tribute|covers? (?:versions?|albums?(?! (?:art|artwork|scans?|covers?) ))|covered by|re ?recorded) /u],
  ["sped_up", / sped ?up /u],
  ["slowed", / slowed /u],
  ["nightcore", / nightcore /u],
  ["eight_d", / 8d ?audio /u],
  ["remix", / (?:remix(?:es|ed)?|rework(?:ed)?|bootleg|mash ?ups?|vip (?:mix|edit)|workout mix(?:es)?|mix 20\d\d) /u],
];

const ANY_LABEL_VERSION = new RegExp(LABEL_VERSIONS.map(([, pattern]) => pattern.source).join("|"), "u");

function spacedWords(folded) {
  const words = folded.replace(/&/gu, " and ").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return words ? ` ${words} ` : " ";
}

// The words of a label: scene names separate words with "_" or ".".
function labelWords(value) {
  return spacedWords(foldDiacritics(String(value || "")).toLowerCase());
}

// The groups of a label that names a version, read once for every request
// that checks it. Brackets, slashes, and a spaced dash end a group, while a
// hyphen joins words inside one ("Sped-Up", scene names), so each group keeps
// its dash pieces for names that stand alone. Taking names out only removes
// words, so a label without a version word names none.
function readLabel(label) {
  const folded = foldDiacritics(String(label || "")).toLowerCase();
  if (!ANY_LABEL_VERSION.test(spacedWords(folded))) return null;
  return folded.replace(/_/gu, " ").split(/[\\/()[\]{}]|\s[-–—]+\s/u)
    .map((group) => group.split(/[-–—]/u).map(spacedWords));
}

// The versions a label names once the requested names are taken out:
// "Album (Instrumentals & Bonus)" is an instrumental album. A one-word name
// such as the band Live is spelled like the version word, so it is taken out
// only where it stands alone between dashes, as in "Live - Throwing Copper",
// and "Live at the Paradiso" is still a live album. Each group is read on its
// own, so "[Covers] [Album Art]" is not a covers album, though a name such as
// "Live - The Album" is taken out across groups.
function labelVersions(labelGroups, names) {
  const groups = labelGroups.map((pieces) => [...pieces]);
  for (const name of names.filter((entry) => entry.oneWord)) {
    const pieces = groups.find((entry) => entry.includes(name.text));
    pieces?.splice(pieces.indexOf(name.text), 1);
  }
  let rest = ` ${groups.map((pieces) => pieces.join(" ")).join("|").replace(/ +/gu, " ").trim()} `;
  for (const name of names.filter((entry) => !entry.oneWord)) rest = rest.replace(name.pattern, " ");
  return LABEL_VERSIONS.filter(([, pattern]) => pattern.test(rest)).map(([variant]) => variant);
}

function labelNames(prepared) {
  prepared.labelNames ??= [...new Set(prepared.requested.names.map(labelWords).filter((name) => name.trim()))]
    .sort((left, right) => right.length - left.length)
    .map((text) => {
      const words = text.trim().split(" ");
      return { text, oneWord: words.length === 1, pattern: new RegExp(` ${words.map(escapeRegExp).join(" (?:\\| )*")} `, "u") };
    });
  return prepared.labelNames;
}

function groupsContradictions(labelGroups, prepared) {
  if (!labelGroups) return [];
  return labelVersions(labelGroups, labelNames(prepared)).filter((variant) => !prepared.labelAllowed.has(variant));
}

// The versions a release, folder, or credit name claims that the request
// does not ask for.
export function labelContradictions(label, prepared) {
  return groupsContradictions(readLabel(label), prepared);
}

// What a requested name asks for: "Alive! (Live)", "MTV Unplugged", or
// "Live in Paris" name a version, while the band Live and the album "Live
// Through This" do not.
const CONTEXT_VARIANT_PATTERNS = [
  { value: "live", pattern: /[-–—([]\s*live\s+(?:in|on)\b|\blive\s*@|\blive\s+(?:album|ep|set|bootleg)s?\b/iu },
  { value: "instrumental", pattern: /\binstrumentals\b/iu },
  { value: "cover", pattern: /\b(?:tribute|covers?\s+(?:album|version)s?|covered\s+by|re-?recorded)\b/iu },
  { value: "remix", pattern: /\bremix(?:es|ed)?\b/iu },
];

// MusicBrainz release-group types that make every track that version.
const SECONDARY_TYPE_VARIANTS = new Map([["live", "live"], ["remix", "remix"], ["demo", "demo"]]);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function asList(value) {
  return (Array.isArray(value) ? value : [value]).map((entry) => String(entry || "").trim()).filter(Boolean);
}

const namePatterns = new Map();

function namePattern(name) {
  if (!namePatterns.has(name)) {
    const words = normalizeVariantText(name).split(" ").filter(Boolean);
    if (namePatterns.size >= 4096) namePatterns.clear();
    namePatterns.set(name, words.length ? {
      first: words[0],
      pattern: new RegExp(`(?<![\\p{L}\\p{N}])${words.map(escapeRegExp).join("[^\\p{L}\\p{N}]+")}(?![\\p{L}\\p{N}])`, "iu"),
    } : null);
  }
  return namePatterns.get(name);
}

// A requested name such as "Live Through This" or "Acoustic Alchemy" is a
// name, not a version, so its first appearance is taken out of the offered
// text before looking for versions. A second "Live" is still a version.
function withoutNames(text, names) {
  let rest = String(text || "");
  let lower = rest.toLowerCase();
  for (const name of names) {
    const entry = namePattern(name);
    if (!entry || !lower.includes(entry.first)) continue;
    const next = rest.replace(entry.pattern, " ");
    if (next !== rest) {
      rest = next;
      lower = rest.toLowerCase();
    }
  }
  return rest;
}

function profileNames(profile) {
  const names = CONTRADICTION_VARIANTS.filter((name) => profile[name]);
  if (profile.remix) names.push("remix");
  if (profile.mixVariant) names.push(profile.mixVariant);
  return names;
}

function isBareLive(text) {
  const words = normalizeVariantText(text).split(" ").filter((word) => word && !isReleaseNoiseWord(word));
  return words.length === 1 && words[0] === "live";
}

function startsWithLiveVenue(text) {
  const words = normalizeVariantText(text).split(" ").filter(Boolean);
  const start = words.findIndex((word) => !isReleaseNoiseWord(word));
  return start >= 0 && words[start] === "live" && ["in", "at", "from", "on"].includes(words[start + 1]);
}

// Versions a requested artist, album, or track name asks for. `release` marks
// an album name, where "Live" alone or "Live in Paris" names a live album; an
// artist can be called Live.
function contextVariants(text, { release = false } = {}) {
  const found = new Set(profileNames(extractVariants(text)).filter((name) => name !== "cover"));
  for (const { value, pattern } of CONTEXT_VARIANT_PATTERNS) {
    if (pattern.test(text)) found.add(value);
  }
  if (release && (isBareLive(text) || startsWithLiveVenue(text))) found.add("live");
  return found;
}

function requestedNames(request) {
  const trackName = request?.trackName ?? request?.title;
  const albumName = request?.albumName ?? request?.album;
  const artists = [
    ...asList(request?.artistName ?? request?.artist),
    ...asList(request?.artists),
    ...asList(request?.artistAliases),
  ];
  // A single named after its track, such as "Song (Live)", names nothing but
  // the track, so it must not take the track's own version out of its title.
  const trackTitles = new Set(asList(trackName).map((name) => normalizeVariantText(getCoreTitle(name))));
  const names = [
    ...[...asList(albumName), ...asList(albumName).map(coreAlbumTitle)]
      .filter((name) => !trackTitles.has(normalizeVariantText(getCoreTitle(name)))),
    ...asList(trackName).map(getCoreTitle),
    ...artists,
  ];
  return {
    trackName: asList(trackName),
    albumName: asList(albumName),
    artists,
    releaseTypes: asList(request?.secondaryTypes),
    releaseTracks: Array.isArray(request?.releaseTracks) ? request.releaseTracks : [],
    names: [...new Set(names)].sort((left, right) => right.length - left.length),
  };
}

// Versions the request asks for: those its track title names, and those its
// artist, album, or release-group type names, such as every track of a live
// album. Another track of the release naming a version does not ask for it.
function allowedVariants(expected, requested) {
  const allowed = new Set(profileNames(expected));
  for (const name of requested.trackName) {
    for (const variant of contextVariants(withoutNames(name, requested.names))) allowed.add(variant);
  }
  for (const name of requested.albumName) {
    for (const variant of contextVariants(name, { release: true })) allowed.add(variant);
  }
  // Only an artist named for a version no original is filed under, such as
  // Karaoke Kings, or a tribute act makes every track that version. Acoustic
  // Alchemy's songs are not acoustic versions.
  for (const name of requested.artists) {
    for (const variant of contextVariants(name)) {
      if (NEVER_ORIGINAL_VARIANTS.has(variant) || variant === "cover") allowed.add(variant);
    }
  }
  for (const type of requested.releaseTypes) {
    const variant = SECONDARY_TYPE_VARIANTS.get(type.toLowerCase());
    if (variant) allowed.add(variant);
  }
  return allowed;
}

// A release, folder, or credit name may also name the versions the requested
// release's own tracks are, where they make up at least half of a disc that
// holds at least a quarter of the release: the live disc of a pinned deluxe
// edition, or a single of a song's remix, demo, and instrumental. One live
// bonus track, alone or on its own disc, does not make the album live, and a
// track's title still may not name another track's version.
function labelAllowedVariants(allowed, requested) {
  const labelAllowed = new Set(allowed);
  for (const disc of Map.groupBy(requested.releaseTracks, (track) => track.discNumber ?? 1).values()) {
    if (disc.length * 4 < requested.releaseTracks.length) continue;
    const versions = disc.map((track) => contextVariants(withoutNames(track.title, requested.names)));
    if (versions.filter((found) => found.size > 0).length * 2 < disc.length) continue;
    for (const found of versions) for (const variant of found) labelAllowed.add(variant);
  }
  return labelAllowed;
}

function candidateFolders(candidate, album) {
  const parts = candidate?.directoryPath
    ? getPathParts(candidate.directoryPath)
    : getPathParts(candidate?.path).slice(0, -1);
  // A disc folder belongs to the release folder above it.
  const releaseDepth = parts.length > 1 && discFolderNumber(parts.at(-1), { album }) ? 2 : 1;
  return { release: parts.slice(-releaseDepth), above: parts.slice(0, -releaseDepth) };
}

// The offered artist, album, and release folder describe the file too: a
// track in "Album (Acoustic)" or by "Karaoke Kings" is that version. Folders
// above the release folder only sort a share ("Music/Live", "Live Albums"),
// so they count only for versions that are never the original. `labels`
// remembers each name read for this request, since one release shares its
// folder and album names across many files.
function contextContradictions(candidate, prepared, labels) {
  const found = [];
  const check = (field, text, neverOriginalOnly = false) => {
    if (!labels.has(text)) labels.set(text, readLabel(text));
    for (const variant of groupsContradictions(labels.get(text), prepared)) {
      if (!neverOriginalOnly || NEVER_ORIGINAL_VARIANTS.has(variant)) found.push({ field, variant });
    }
  };
  for (const artist of asList(candidate?.artists ?? candidate?.artist)) check("artist", artist);
  for (const album of asList(candidate?.album)) check("album", album);
  const folders = candidateFolders(candidate, prepared.requested.albumName[0]);
  for (const folder of folders.release) check("folder", folder);
  for (const folder of folders.above) check("folder", folder, true);
  return found;
}

// The request side of a variant check, worked out once for every candidate
// compared with it.
export function prepareVariantRequest(request) {
  const requested = requestedNames(request);
  // Snot's song "Unplugged" is a name on both sides, not a version.
  const expected = buildRequestVariantProfile({
    ...request,
    trackName: requested.trackName.map((name) => withoutNames(name, requested.names)).join(" "),
  });
  const allowed = allowedVariants(expected, requested);
  return { requested, expected, allowed, labelAllowed: labelAllowedVariants(allowed, requested), labelNames: null };
}

export function checkVariantCompatibility(request, candidate, prepared = prepareVariantRequest(request), labels = new Map()) {
  const { requested, expected, allowed } = prepared;
  const candidateText = [candidate?.title, candidate?.filename].filter(Boolean)
    .map((text) => withoutNames(text, requested.names)).join(" ");
  const actual = mergeVariantProfiles(
    extractVariants(candidateText),
    candidate?.variants && typeof candidate.variants === "object"
      ? candidate.variants
      : null,
  );
  const compared = compareVariantProfiles(expected, actual, allowed);
  const context = contextContradictions(candidate, prepared, labels);
  const contradictions = [...new Set([...compared.contradictions, ...context.map((entry) => entry.variant)])];
  return {
    compatible: contradictions.length === 0,
    contradictions,
    contextContradictions: context,
    variantScore: compared.score - 80 * context.length,
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
  "music",
  "video",
  "lyric",
  "lyrics",
  "visualizer",
  "hd",
  "hq",
  "4k",
  "mv",
  "topic",
  "oficial",
  "officiel",
  "letra",
  "letras",
  "explicit",
  "360",
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

export function isPromoGroup(inner) {
  const words = groupWords(inner);
  return words.length > 0 && words.every((word) => PROMO_GROUP_WORDS.has(word));
}

// Version descriptors move a lot in file and video titles. Identity scoring
// compares core titles after variant compatibility is checked.
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

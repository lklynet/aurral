export const VARIOUS_ARTISTS_MBID = "89ad4ac3-39f7-470e-963a-56509c546377";

const VARIOUS_ARTISTS_NAMES = new Set(["various artists", "various", "va", "v a"]);
const EDITION_WORDS = /\b(?:deluxe|edition|remaster(?:ed)?|expanded|anniversary|bonus|special|collector'?s|version|explicit|clean|reissue|mono|stereo)\b/iu;
const SOUNDTRACK_WORDS = /\b(?:soundtrack|ost|score|cast recording|music from (?:and inspired by )?the (?:motion picture|film|series|movie))\b/iu;

function plainWords(value) {
  return String(value || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

// "Various Artists" credits a compilation, not a performer.
export function isVariousArtistsCredit(name, mbid = null) {
  return String(mbid || "").trim().toLowerCase() === VARIOUS_ARTISTS_MBID
    || VARIOUS_ARTISTS_NAMES.has(plainWords(name));
}

// The title that release names keep: "Album (Deluxe Edition)", "Album -
// Single", and "Film: Awesome Mix, Vol. 1: Original Motion Picture
// Soundtrack" lose the edition and soundtrack wording; "Album (Part 2)" does
// not.
export function coreAlbumTitle(value) {
  const text = String(value || "")
    .replace(/\s+(?:-|–|—)\s+(?:single|ep|album)\s*$/iu, "")
    .replace(/\s+[[(](?:single|ep|album)[)\]]\s*$/iu, "")
    .replace(/\s*[[(]([^\])]*)[\])]/gu, (segment, inner) =>
      (EDITION_WORDS.test(inner) || SOUNDTRACK_WORDS.test(inner) ? " " : segment));
  const segments = text.split(/\s*:\s+|\s+(?:-|–|—)\s+/u);
  const kept = segments.filter((segment, index) =>
    index === 0 || !(EDITION_WORDS.test(segment) || SOUNDTRACK_WORDS.test(segment)));
  const core = kept.join(" ").replace(/\s+/g, " ").trim();
  return core || String(value || "").trim();
}

const REMASTER_WORD = /^re-?master(?:ed)?$/u;
const REMASTER_LABEL_WORD = /^(?:re-?master(?:ed)?|digital(?:ly)?|version|edition|deluxe|anniversary|\d{4}|\d+(?:st|nd|rd|th))$/u;

// "Song (Remastered 2012)" and "Song - 2011 Remaster" are the song itself; a
// live, demo, or remixed version is not.
export function withoutRemasterLabel(value) {
  const title = String(value || "").trim();
  const match = title.match(/^(.+?)\s*[([]([^)\]]*)[)\]]$/u) || title.match(/^(.+)\s(?:-|–|—)\s+(.+)$/u);
  if (!match) return title;
  const words = match[2].toLowerCase().split(/[^\p{L}\p{N}-]+/u).filter(Boolean);
  return words.some((word) => REMASTER_WORD.test(word)) && words.every((word) => REMASTER_LABEL_WORD.test(word))
    ? match[1]
    : title;
}

const OTHER_PRODUCTS = ["discography", "box set", "boxset", "bootleg", "tribute", "karaoke"];
const OTHER_ALBUMS = ["live", "anthology", "greatest hits", "best of", "complete albums",
  "complete studio albums", "complete recordings", "complete works"];

// A release named a discography, box set, bootleg, tribute, or karaoke
// release, or for an album a live or hits collection, is a different product
// from the one requested, unless the request names it too.
export function otherProductMarker(name, requested, { album = false } = {}) {
  const words = ` ${plainWords(name)} `;
  const wanted = ` ${requested.map(plainWords).join(" ")} `;
  return [...OTHER_PRODUCTS, ...(album ? OTHER_ALBUMS : [])]
    .find((marker) => words.includes(` ${marker} `) && !wanted.includes(` ${marker} `)) || null;
}

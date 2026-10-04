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

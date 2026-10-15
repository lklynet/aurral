export const VARIOUS_ARTISTS_MBID = "89ad4ac3-39f7-470e-963a-56509c546377";

const VARIOUS_ARTISTS_NAMES = new Set(["various artists", "various", "va", "v a"]);
const EDITION_WORDS = /\b(?:deluxe|edition|remaster(?:ed)?|expanded|anniversary|bonus|special|collector'?s|version|explicit|clean|reissue|mono|stereo)\b/iu;
const SOUNDTRACK_WORDS = /\b(?:soundtrack|ost|score|cast recording|music from (?:and inspired by )?the (?:motion picture|film|series|movie))\b/iu;

function plainWords(value) {
  return String(value || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

const NON_LATIN_LETTER = /(?!\p{Script=Latin})\p{L}/u;

export function hasNonLatinLetter(value) {
  return NON_LATIN_LETTER.test(String(value || ""));
}

// Names in different scripts, such as "Кино" and "Kino", cannot be compared,
// so neither contradicts the other.
export function inOtherScript(left, right) {
  return hasNonLatinLetter(left) !== hasNonLatinLetter(right);
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

const NUMBER_WORDS = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const DISC_FOLDER = new RegExp(
  `^[([]?\\s*(?:cd|disc|disk|lp)\\s*[-_.#]?\\s*(\\d{1,2}|${NUMBER_WORDS.join("|")})(?:\\s*of\\s*\\d+)?(?![\\p{L}\\p{N}])`, "iu");

const words = (value) => plainWords(value).split(" ").filter(Boolean);

// Where a run of words spells the name, spaced or not: "LP 4" spells "LP4".
// Returns the index after the run, or -1.
function spelledAt(labelWords, nameWords, start) {
  const name = nameWords.join("");
  let spelled = "";
  for (let end = start; end < labelWords.length && spelled.length < name.length; end += 1) {
    spelled += labelWords[end];
    if (spelled === name) return end + 1;
  }
  return -1;
}

// True when the label holds the name as whole words, spaced or not.
export function labelSpells(label, name) {
  const nameWords = words(name);
  const labelWords = words(label);
  return nameWords.length > 0 && labelWords.some((_, start) => spelledAt(labelWords, nameWords, start) >= 0);
}

// "LP4 (2010) [Japan]", "LP 4", and "LP1 - Deluxe Edition" name the albums
// LP4 and LP1: the title, then only notes in brackets, years, or formats.
function namesAlbum(folder, album) {
  const title = words(coreAlbumTitle(album));
  const name = words(coreAlbumTitle(String(folder).replace(/[[({][^\])}]*[\])}]/gu, " ")));
  const end = title.length ? spelledAt(name, title, 0) : -1;
  return end >= 0 && name.slice(end).every(isReleaseNoiseWord);
}

// "CD2", "Disc Two", "LP 2", "CD1 [FLAC]", and "Disc 1 - Dawn to Dusk" hold
// one disc of the release folder above them, unless the folder is named for
// the album, as Ratatat's "LP4" is.
export function discFolderNumber(name, { album = null } = {}) {
  const text = String(name || "").trim();
  const match = DISC_FOLDER.exec(text);
  if (!match || (album && namesAlbum(text, album))) return null;
  const disc = NUMBER_WORDS.includes(match[1].toLowerCase()) ? NUMBER_WORDS.indexOf(match[1].toLowerCase()) + 1 : Number(match[1]);
  return disc > 0 ? disc : null;
}

const RELEASE_NOISE_WORD = new RegExp(`^(?:\\d+|\\d+(?:bit|khz|kbps|cd)|cd\\d*|disc\\d*|disk\\d*|lp|ep|${NUMBER_WORDS.join("|")}|flac|mp3|aac|alac|wav|ogg|opus|m4a|ape|wma|vbr|cbr|v0|v2|web|webrip|cdrip|vinyl|lossless|hi|res|hires|va)$`, "u");

// Years, disc labels, and formats around a release name: "2009 Live",
// "CD 2 - Live", "Live [FLAC]".
export function isReleaseNoiseWord(word) {
  return RELEASE_NOISE_WORD.test(word);
}

const OTHER_PRODUCTS = ["discography", ["box set", "boxset"], "bootleg", "tribute"];
const OTHER_ALBUMS = ["anthology", "greatest hits", "best of", "complete albums",
  "complete studio albums", "complete recordings", "complete works"];

// A release named a discography, box set, bootleg, or tribute, or for an
// album a hits or complete-works collection, is a different product from the
// one requested, unless the request names it too. A version, such as a live
// or karaoke release, is the variant policy's to judge.
export function otherProductMarker(name, requested, { album = false } = {}) {
  const label = ` ${plainWords(name)} `;
  const wanted = ` ${requested.map(plainWords).join(" ")} `;
  const named = (text, marker) => text.includes(` ${marker} `);
  for (const entry of [...OTHER_PRODUCTS, ...(album ? OTHER_ALBUMS : [])]) {
    const family = [entry].flat();
    const marker = family.find((word) => named(label, word));
    if (marker && !family.some((word) => named(wanted, word))) return marker;
  }
  return null;
}

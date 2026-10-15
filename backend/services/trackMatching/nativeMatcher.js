import { distance } from "fastest-levenshtein";
import {
  checkVariantCompatibility,
  compareVariantProfiles,
  extractVariants,
  prepareVariantRequest,
  RELEASE_MIX_VARIANTS,
  stripPromoDescriptors,
} from "./semanticPolicy.js";
import { foldDiacritics } from "../providers/brainzmashRanking.js";
import { discFolderNumber, isVariousArtistsCredit } from "./titleText.js";
import { implausibleBitrateKbps } from "./candidateNormalizer.js";
import { UUID_REGEX } from "../../../lib/uuid.js";

export const MATCH_POLICY = Object.freeze({
  version: "aurral-native-6",
  maxDurationGapMs: 10000,
  selectedDurationGapMs: 2000,
  minTitleSimilarity: 0.7,
  minArtistSimilarity: 0.9,
  minArtistNonConflictSimilarity: 0.4,
  selectableScore: 0.78,
  runnerUpMargin: 0.05,
});

export function getMatcherStatus() {
  return { available: true, checked: true, policyVersion: MATCH_POLICY.version, error: null };
}

// Rip tools write Spotify or Deezer IDs into the MusicBrainz tags. Only a
// UUID is a MusicBrainz recording ID.
export function readRecordingMbid(value) {
  const id = String(value || "").trim().toLowerCase();
  return UUID_REGEX.test(id) ? id : null;
}

export function normalizeMatchText(value) {
  return foldDiacritics(String(value || "").normalize("NFKD"))
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function listingDisc(segments, encoded, album) {
  const disc = encoded ?? discFolderNumber(segments.at(-2), { album });
  return Number.isInteger(disc) && disc > 0 ? { discNumber: disc } : {};
}

// The album, when known, keeps a folder named for it from reading as a disc.
export function parseListingTitle(path, { album = null } = {}) {
  const segments = String(path || "").split(/[\\/]/);
  const base = segments.at(-1).replace(/\.[^.]+$/, "").trim();
  if (/^\d{1,3}$/u.test(base)) return { title: null, trackNumber: Number(base), ...listingDisc(segments, null, album) };
  const placeholder = /^(?:audio\s*)?track\s*(\d{1,3})$/iu.exec(base);
  if (placeholder) return { title: base, trackNumber: Number(placeholder[1]), ...listingDisc(segments, null, album) };
  const patterns = [
    /^(\d{1,2})-(\d{1,3})(?:\s*[-.]\s*|\s+)(.+)$/u,
    /^.+?\s+-\s+CD(\d{1,2})\s+-\s+(\d{1,3})\s+(.+)$/iu,
    /^\[(\d{1,2})\.(\d{1,3})\]\s*(.+)$/u,
    /^.+?\s+-\s+(\d{1,3})\s+-\s+(.+)$/u,
    /^(\d{1,3})[. -]+(.+)$/u,
    /^(.+?)\s+\((\d{1,3})\)$/u,
  ];
  for (const [index, pattern] of patterns.entries()) {
    const match = pattern.exec(base);
    if (!match) continue;
    const title = index === 5 ? match[1] : match.at(-1);
    const trackNumber = Number(index < 3 ? match[2] : index === 5 ? match[2] : match[1]);
    return {
      title: title.trim(),
      trackNumber: Number.isFinite(trackNumber) ? trackNumber : null,
      ...listingDisc(segments, index < 3 ? Number(match[1]) : null, album),
    };
  }
  return { title: base, trackNumber: null, ...listingDisc(segments, null, album) };
}

// Similarity of two normalized texts, from 0 to 1.
export function keySimilarity(a, b) {
  if (!a || !b) return 0;
  if (a.length > 512 || b.length > 512) return 0;
  if (a === b) return 1;
  return 1 - distance(a, b) / Math.max(a.length, b.length);
}

function similarity(left, right) {
  return keySimilarity(normalizeMatchText(left), normalizeMatchText(right));
}

const VARIANTS = ["live", "remix", "acoustic", "instrumental", "demo", "edit", "karaoke", "cover", "nightcore"];

function variants(title) {
  const normalized = normalizeMatchText(title);
  const found = VARIANTS.filter((variant) => new RegExp(`\\b${variant}\\b`, "u").test(normalized));
  const mix = /\b(extended|radio|club|dance|single|album) mix\b/u.exec(normalized);
  if (mix) found.push(`${mix[1]}-mix`);
  return found;
}

function coreMatchTitle(title) {
  return (stripPromoDescriptors(title) || String(title || ""))
    .replace(/\s*[[(][^\])]*\b(?:live|remix|acoustic|instrumental|demo|edit|karaoke|cover|nightcore|mix|mono|stereo|remaster(?:ed)?|feat\.?|ft\.?|featuring|official audio|official video|visualizer|lyrics|album version|original version|bonus|hidden track)\b[^\])]*[\])]/giu, "")
    .replace(/\s+[-–—]\s+(?:(?:radio|extended|club|dance|single|album)\s+)?(?:edit|mix|live|remix|acoustic|instrumental|demo|karaoke|remaster(?:ed)?)\b.*$/iu, "")
    .replace(/\s+[-–—]\s+(?:mono|stereo)(?:\s+(?:version|mix))?\s*$/iu, "")
    .replace(/\s+\b(?:feat\.?|ft\.?|featuring)\s+.+$/iu, "")
    .trim();
}

function coreArtist(name) {
  return String(name || "")
    .replace(/\s*[([]\s*(?:feat\.?|ft\.?|featuring|with)\s+[^)\]]*[)\]]/giu, "")
    .replace(/\s+\b(?:feat\.?|ft\.?|featuring)\s+.+$/iu, "")
    .trim();
}

// "Kendrick Lamar, Drake" and "Blue Swede & Björn Skifs" credit each of
// their artists. "AC/DC" has no spaces around its slash and stays whole.
function creditedArtists(credit) {
  const whole = coreArtist(credit);
  const parts = whole.split(/\s*[,;]\s*|\s+(?:&|\/|x|×)\s+/iu).map((part) => part.trim()).filter(Boolean);
  return [...new Set([whole, ...parts])];
}

function artistKey(name) {
  return normalizeMatchText(String(name || "").replace(/&/g, " and ")).replace(/^the (?=\S)/u, "");
}

function artistKeys(name) {
  const key = artistKey(name);
  return [key, key.replace(/ /g, "")];
}

function keyedArtistSimilarity(requestedKeys, credits) {
  const offered = asNames(credits).flatMap((credit) => creditedArtists(credit).map(artistKeys));
  if (!requestedKeys.length || !asNames(credits).length) return null;
  return Math.max(0, ...requestedKeys.flatMap(([left, leftJoined]) => offered.map(([right, rightJoined]) =>
    Math.max(keySimilarity(left, right), keySimilarity(leftJoined, rightJoined)))));
}

const requestedArtistKeys = (names) => asNames(names).filter((name) => !isVariousArtistsCredit(name))
  .map((name) => artistKeys(coreArtist(name)));

export function bestArtistSimilarity(requestedNames, credits) {
  return keyedArtistSimilarity(requestedArtistKeys(requestedNames), credits);
}

function nonLatinTitleContradiction(left, right) {
  const a = normalizeMatchText(coreMatchTitle(left));
  const b = normalizeMatchText(coreMatchTitle(right));
  return Boolean(a && b && a !== b && /(?!\p{Script=Latin})\p{L}/u.test(`${a} ${b}`));
}

function asNames(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  return value ? [value] : [];
}

function requestPerformers(request) {
  return [...asNames(request.artists || request.artist), ...asNames(request.artistAliases)]
    .filter((name) => !isVariousArtistsCredit(name));
}

// The request side of `compareRecording`, worked out once for every
// candidate compared with it.
export function prepareRecordingRequest(request) {
  const lengths = [request.durationMs ?? request.duration_ms, ...asNames(request.pressingDurationsMs)].map(Number);
  return {
    durations: [...new Set(lengths.filter((length) => Number.isFinite(length) && length > 0))],
    variants: prepareVariantRequest({
      trackName: request.title,
      albumName: request.albumName,
      artists: asNames(request.artists || request.artist),
      artistAliases: asNames(request.artistAliases),
      secondaryTypes: asNames(request.secondaryTypes),
      releaseTracks: request.releaseTracks,
    }),
    titleKey: titleKey(request.title),
    performerKeys: requestedArtistKeys(requestPerformers(request)),
  };
}

// Every name around a request and a candidate can name a version: the
// title, the file name, the album, the artist, and the folders.
function variantContradictions(prepared, candidate, labels) {
  return checkVariantCompatibility(null, {
    title: candidate.versionTitle || candidate.title,
    filename: candidate.filename || candidate.fileNameTitle,
    album: candidate.album,
    artists: asNames(candidate.artists || candidate.artist),
    path: candidate.path,
    directoryPath: candidate.directoryPath,
  }, prepared.variants, labels).contradictions;
}

// The shared policy accepts an undeclared copy of a requested edit or mix
// and does not know a bare "(Edit)" or a radio, dance, single, or album mix.
const EDIT_VARIANTS = new Set(["edit", "remix"]);

function editContradiction(requestTitle, candidateTitle) {
  const requested = variants(requestTitle).filter((variant) => EDIT_VARIANTS.has(variant) || variant.endsWith("-mix"));
  const offered = variants(candidateTitle).filter((variant) => variant === "edit" || variant.endsWith("-mix"));
  return offered.find((variant) => !requested.includes(variant))
    || requested.find((variant) => !variant.endsWith("-mix") && !variants(candidateTitle).includes(variant))
    || null;
}

// `labels` remembers the names read for this request across the candidates
// of one search or one listing.
export function compareRecording(request, candidate, policy = MATCH_POLICY, prepared = prepareRecordingRequest(request),
  labels = new Map()) {
  const contradictions = [];
  if (nonLatinTitleContradiction(request.title, candidate.title)) contradictions.push("title");
  // MusicBrainz merges duplicate recordings, and files tagged before a merge
  // carry an ID that the recording keeps as an alias.
  const requestIds = [request.recordingMbid || request.recording_mbid, ...asNames(request.recordingMbidAliases)]
    .map(readRecordingMbid).filter(Boolean);
  const requestId = requestIds[0] || "";
  const candidateId = readRecordingMbid(candidate.recordingMbid || candidate.recording_mbid) || "";
  const sameRecording = Boolean(candidateId) && requestIds.includes(candidateId);
  if (requestId && candidateId && !sameRecording) contradictions.push("recording-mbid");
  const offeredTitle = [candidate.versionTitle || candidate.title, candidate.fileNameTitle].filter(Boolean).join(" ");
  const edit = offeredTitle && editContradiction(request.title, offeredTitle);
  if (edit) contradictions.push(edit);
  for (const contradiction of variantContradictions(prepared, candidate, labels)) {
    if (!contradictions.includes(contradiction)) contradictions.push(contradiction);
  }
  // A track's length on the release, or on another official pressing in the
  // same running order, since a rip of either is the same recording.
  const candidateDuration = Number(candidate.durationMs ?? candidate.duration_ms);
  const gap = prepared.durations.length && Number.isFinite(candidateDuration) && candidateDuration > 0
    ? Math.min(...prepared.durations.map((length) => Math.abs(length - candidateDuration))) : null;
  if (gap != null && gap > policy.maxDurationGapMs) contradictions.push("duration");
  if (implausibleBitrateKbps({ path: candidate.path || candidate.filename, sizeBytes: candidate.sizeBytes,
    durationMs: candidateDuration, trackTitle: request.title }) != null) contradictions.push("implausible-file");

  const title = keySimilarity(prepared.titleKey, titleKey(candidate.title));
  const artist = keyedArtistSimilarity(prepared.performerKeys, candidate.artists || candidate.artist);
  if (artist != null && artist < policy.minArtistNonConflictSimilarity) contradictions.push("artist");
  const evidence = [];
  if (sameRecording) evidence.push("recording-mbid");
  if (title >= policy.minTitleSimilarity) evidence.push("title");
  if (artist != null && artist >= policy.minArtistSimilarity) evidence.push("artist");
  if (gap != null && gap <= policy.maxDurationGapMs) evidence.push("duration");
  const score = Math.min(1,
    title * 0.55 + (artist ?? 0) * 0.2 + (gap == null ? 0 : Math.max(0, 1 - gap / policy.maxDurationGapMs)) * 0.25
    + (evidence.includes("recording-mbid") ? 0.2 : 0),
  );
  return { contradictions, evidence, score, titleSimilarity: title, artistSimilarity: artist, durationGapMs: gap };
}

export function decideRecording(request, candidates, policy = MATCH_POLICY) {
  const prepared = prepareRecordingRequest(request);
  const labels = new Map();
  const assessed = candidates.map((candidate, index) => ({
    index, candidate, ...compareRecording(request, candidate, policy, prepared, labels),
  }));
  const eligible = assessed.filter((item) => item.contradictions.length === 0
    && item.evidence.length >= 2 && item.evidence.includes("title"))
    .sort((left, right) => right.score - left.score || left.index - right.index);
  const best = eligible[0];
  const runnerUp = eligible[1];
  // A request credited only to "Various Artists" has no performer to check.
  const performerUnknown = requestPerformers(request).length === 0
    && asNames(request.artists || request.artist).length > 0;
  let decision = "skip";
  let selectedIndex = null;
  if (best) {
    const strongDuration = best.evidence.includes("recording-mbid")
      || (best.durationGapMs != null && best.durationGapMs <= policy.selectedDurationGapMs);
    const singleCandidateNeedsExactDuration = candidates.length === 1
      && !best.evidence.includes("recording-mbid") && best.durationGapMs !== 0;
    decision = strongDuration && !singleCandidateNeedsExactDuration
      && (!performerUnknown || best.evidence.includes("recording-mbid"))
      && best.score >= policy.selectableScore
      && (!runnerUp || best.score - runnerUp.score >= policy.runnerUpMargin)
      ? "selectable" : "uncertain";
    if (decision === "selectable") selectedIndex = best.index;
  }
  return { decision, selectedIndex, candidates: assessed, policyVersion: policy.version };
}

function maximumWeightColumns(weights) {
  const rowCount = weights.length;
  const columnCount = weights[0]?.length || 0;
  const rowPotential = new Array(rowCount + 1).fill(0);
  const columnPotential = new Array(columnCount + 1).fill(0);
  const rowForColumn = new Array(columnCount + 1).fill(0);
  const previousColumn = new Array(columnCount + 1).fill(0);
  for (let row = 1; row <= rowCount; row += 1) {
    rowForColumn[0] = row;
    let column = 0;
    const distance = new Array(columnCount + 1).fill(Infinity);
    const visited = new Array(columnCount + 1).fill(false);
    do {
      visited[column] = true;
      const currentRow = rowForColumn[column];
      let nextColumn = 0;
      let smallest = Infinity;
      for (let candidate = 1; candidate <= columnCount; candidate += 1) {
        if (visited[candidate]) continue;
        const reducedCost = -weights[currentRow - 1][candidate - 1]
          - rowPotential[currentRow] - columnPotential[candidate];
        if (reducedCost < distance[candidate]) {
          distance[candidate] = reducedCost;
          previousColumn[candidate] = column;
        }
        if (distance[candidate] < smallest) {
          smallest = distance[candidate];
          nextColumn = candidate;
        }
      }
      for (let candidate = 0; candidate <= columnCount; candidate += 1) {
        if (visited[candidate]) {
          rowPotential[rowForColumn[candidate]] += smallest;
          columnPotential[candidate] -= smallest;
        } else {
          distance[candidate] -= smallest;
        }
      }
      column = nextColumn;
    } while (rowForColumn[column] !== 0);
    do {
      const nextColumn = previousColumn[column];
      rowForColumn[column] = rowForColumn[nextColumn];
      column = nextColumn;
    } while (column !== 0);
  }
  const columns = new Array(rowCount).fill(-1);
  for (let column = 1; column <= columnCount; column += 1) {
    if (rowForColumn[column]) columns[rowForColumn[column] - 1] = column - 1;
  }
  return columns;
}

const positiveNumber = (value) => (Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : null);

// Where a file sits against a track: "same", "different", or "unknown". A
// file's disc, when known, must be the track's. Numbering restarts on each
// disc, runs on across discs when `runningNumber` gives the place on a
// complete, ordered tracklist, or counts discs in hundreds ("203" is disc 2,
// track 3).
export function comparePosition(track, file, runningNumber = null) {
  const fileTrack = positiveNumber(file.trackNumber);
  const trackNumber = positiveNumber(track.trackNumber);
  if (!fileTrack || !(trackNumber || runningNumber)) return "unknown";
  const fileDisc = positiveNumber(file.discNumber);
  const trackDisc = positiveNumber(track.discNumber);
  const discAgrees = !fileDisc || !trackDisc || fileDisc === trackDisc;
  if (discAgrees && (fileTrack === trackNumber || fileTrack === runningNumber)) return "same";
  if (discAgrees && trackDisc && fileTrack > 100 && Math.floor(fileTrack / 100) === trackDisc
    && fileTrack % 100 === trackNumber) return "same";
  return "different";
}

// One-to-one: each track takes at most one file and each file at most one
// track, with as many pairs as possible and then the highest total score.
// `edges[trackIndex]` lists the files that track may take.
export function pairTracksWithFiles(edges, fileCount) {
  const cardinalityBonus = edges.length + 1;
  const weights = edges.map((trackEdges) => {
    const row = new Array(fileCount + edges.length).fill(0);
    for (const edge of trackEdges) row[edge.fileIndex] = cardinalityBonus + edge.score;
    return row;
  });
  const assignedColumns = edges.length && fileCount ? maximumWeightColumns(weights) : [];
  const trackForFile = new Array(fileCount).fill(-1);
  const pairs = assignedColumns.flatMap((fileIndex, trackIndex) => {
    const edge = fileIndex < fileCount
      ? edges[trackIndex].find((item) => item.fileIndex === fileIndex) : null;
    if (!edge) return [];
    trackForFile[fileIndex] = trackIndex;
    return [{ ...edge, trackIndex, fileIndex }];
  });
  const paired = new Set(pairs.map((pair) => pair.trackIndex));
  return {
    pairs,
    unassignedTrackIndexes: edges.flatMap((_, index) => paired.has(index) ? [] : [index]),
    unassignedFileIndexes: trackForFile.flatMap((track, index) => track < 0 ? [index] : []),
  };
}

export function isSameAlbumTitle(requested, observed) {
  const left = normalizeMatchText(requested);
  return Boolean(left) && left === normalizeMatchText(observed);
}

// A file from the requested album whose position holds a different track is
// probably mislabeled. A file from a single, a compilation, or another
// edition has its own numbering, so its position says nothing, and so does
// a position on a later disc, which starts again at 1.
export function isSiblingTrackPosition(request, actualTrackNumber, actualDiscNumber = null) {
  const expected = Number(request.trackNumber || 0);
  const actual = Number(actualTrackNumber || 0);
  if (!(expected > 0 && actual > 0 && expected !== actual) || Number(actualDiscNumber) > 1) return false;
  const siblingTitle = request.albumTrackTitles?.[actual - 1];
  return Boolean(siblingTitle) && normalizeMatchText(siblingTitle) !== normalizeMatchText(request.title);
}

export function verifyDownloadedRecording(request, observed, policy = MATCH_POLICY) {
  const result = compareRecording(request, observed, policy);
  if (isSameAlbumTitle(request.albumName, observed.album)
    && isSiblingTrackPosition(request, observed.trackNumber, observed.discNumber)) {
    result.contradictions.push("sibling-track-index");
  }
  if (observed.fileNameTitle
    && (nonLatinTitleContradiction(request.title, observed.fileNameTitle)
      || result.titleSimilarity >= policy.minTitleSimilarity
        && normalizeMatchText(observed.fileNameTitle)
        && similarity(coreMatchTitle(request.title), coreMatchTitle(observed.fileNameTitle))
          < policy.minTitleSimilarity)) {
    result.contradictions.push("filename-title");
  }
  // Another song by the same artist with a similar length is not a near
  // match: without its title or recording ID, a file is a different song.
  if (!result.evidence.includes("recording-mbid") && !result.evidence.includes("title")
    && !result.contradictions.includes("title")) {
    result.contradictions.push("title");
  }
  let decision = "ambiguous";
  if (result.contradictions.length) decision = "no_match";
  else if (result.evidence.includes("recording-mbid")) decision = "matched";
  else if (result.evidence.includes("title") && result.evidence.includes("artist")
    && result.durationGapMs != null && result.durationGapMs <= policy.selectedDurationGapMs) decision = "matched";
  return { decision, ...result, policyVersion: policy.version };
}

// The comparable core of a title, without versions, guests, and promotion.
export function titleKey(title) {
  return normalizeMatchText(coreMatchTitle(title));
}

export function titleSimilarity(requested, offered) {
  return keySimilarity(titleKey(requested), titleKey(offered));
}

const spelledOut = (title) => String(title || "").replace(/&/gu, " and ");

const songWords = (title) => normalizeMatchText(spelledOut(title)
  .replace(/\s*[([][^)\]]*[)\]]/gu, " ")
  .split(/\s(?:-|–|—)\s|\s(?:feat\.?|ft\.?|featuring)\s/iu)[0]).split(" ").filter(Boolean);

const holdsWords = (outer, inner) => inner.length * 2 >= outer.length
  && outer.some((_, start) => inner.every((word, offset) => outer[start + offset] === word));

const withoutGuests = (title) => String(title || "")
  .replace(/\s*[([]\s*(?:feat\.?|ft\.?|featuring|with)\s[^)\]]*[)\]]/giu, " ")
  .replace(/\s(?:feat\.?|ft\.?|featuring)\s[^([\-–—]*/giu, " ");

// A guest's name, such as "feat. Live", says nothing about the version.
const isOtherVersion = (leftTitle, rightTitle) => {
  const [left, right] = [leftTitle, rightTitle].map(withoutGuests);
  const version = (title) => variants(title).filter((variant) => variant !== "cover").join("|");
  const contradicts = (expected, actual) => compareVariantProfiles(extractVariants(expected), extractVariants(actual))
    .contradictions.some((variant) => variant !== "cover" && !RELEASE_MIX_VARIANTS.has(variant));
  return version(left) !== version(right) || contradicts(left, right) || contradicts(right, left);
};

// At one place on an album, two titles name the same song when they differ
// only in spelling, such as "&" for "and" or a space between words, in a note
// in brackets or after a dash, or in words one adds, and neither is a live, sped-up, edited, or other version the other is
// not. A note that the artist covers the song changes nothing on their own
// album.
export function isSameSongAtPlace(left, right) {
  if (isOtherVersion(left, right)) return false;
  const [a, b] = [songWords(left), songWords(right)];
  if (!a.length || !b.length) return false;
  const [allA, allB] = [left, right].map((title) => normalizeMatchText(spelledOut(title)).split(" "));
  return a.join("") === b.join("") || holdsWords(allB, a) || holdsWords(allA, b)
    || similarity(a.join(" "), b.join(" ")) >= 0.8;
}

import { distance } from "fastest-levenshtein";
import {
  bestArtistSimilarity,
  comparePosition,
  compareRecording,
  keySimilarity,
  MATCH_POLICY,
  normalizeMatchText,
  pairTracksWithFiles,
  parseListingTitle,
  prepareRecordingRequest,
  readRecordingMbid,
  titleKey,
} from "./nativeMatcher.js";
import { labelContradictions, prepareVariantRequest, RELEASE_MIX_VARIANTS } from "./semanticPolicy.js";
import {
  coreAlbumTitle,
  hasNonLatinLetter,
  inOtherScript as otherScript,
  isReleaseNoiseWord,
  isVariousArtistsCredit,
  otherProductMarker,
} from "./titleText.js";
import { implausibleBitrateKbps } from "./candidateNormalizer.js";

const IDENTITY_BLOCKERS = new Set(["title", "recording-mbid", "artist", "duration", "position"]);
const PLACEHOLDER_TITLE = /^(?:audio\s*)?track\s*\d{1,3}$/u;

const names = (value) => (Array.isArray(value) ? value : [value]).map((name) => String(name || "").trim()).filter(Boolean);

function performerNames(manifest) {
  return [...new Set([
    ...manifest.artistNames,
    ...manifest.tracks.flatMap((track) => [...names(track.artists), ...names(track.artistAliases)]),
  ])].filter((name) => !isVariousArtistsCredit(name));
}

function containsWords(text, phrase) {
  const words = normalizeMatchText(phrase);
  return Boolean(words) && ` ${normalizeMatchText(text)} `.includes(` ${words} `);
}

function namesArtist(label, performers, threshold) {
  return performers.some((name) => containsWords(label, name))
    || (bestArtistSimilarity(performers, [label]) ?? 0) >= threshold;
}

// An artist label that names no one on the release claims another artist.
// "Various Artists" names no one.
function artistConflict(label, performers, policy) {
  if (!label || isVariousArtistsCredit(label) || performers.length === 0) return false;
  return !namesArtist(label, performers, policy.minArtistNonConflictSimilarity)
    && !performers.some((name) => otherScript(label, name));
}

function releaseName(manifest) {
  return normalizeMatchText(coreAlbumTitle(manifest.title));
}

// The parts of an album label that name an album: what is left after the
// artist, years, discs, formats, and bracketed notes.
function albumClaims(label, performers, policy) {
  return String(label || "")
    .replace(/[[({][^\])}]*[\])}]/gu, " - ")
    .split(/\s+[-–—]\s+|\s*[\\/|]\s*/u)
    .filter((segment) => !isVariousArtistsCredit(segment)
      && (bestArtistSimilarity(performers, [segment]) ?? 0) < policy.minArtistSimilarity)
    .map((segment) => normalizeMatchText(coreAlbumTitle(segment)).split(" "))
    .map((words) => {
      let start = 0;
      let end = words.length;
      while (start < end && isReleaseNoiseWord(words[start])) start += 1;
      while (end > start && isReleaseNoiseWord(words[end - 1])) end -= 1;
      return words.slice(start, end).join(" ");
    })
    .filter(Boolean);
}

function namesAlbum(claim, release, policy) {
  return otherScript(claim, release) || ` ${claim} `.includes(` ${release} `) || ` ${release} `.includes(` ${claim} `)
    || similarity(claim, release) >= policy.minTitleSimilarity;
}

function similarity(left, right) {
  const longest = Math.max(left.length, right.length);
  return longest ? 1 - distance(left, right) / longest : 0;
}

// An album label that names an album must name this one. A label of only an
// artist, a year, or a format claims nothing.
function albumConflict(label, manifest, performers, policy) {
  const release = releaseName(manifest);
  const claims = albumClaims(label, performers, policy);
  return Boolean(release) && claims.length > 0 && !claims.some((claim) => namesAlbum(claim, release, policy));
}

function labelVariants(prepared, listing) {
  return [...new Set([listing.albumLabel, listing.artistLabel].filter(Boolean)
    .flatMap((label) => labelContradictions(label, prepared)))];
}

function trackRequest(manifest, track) {
  const request = {
    title: track.title,
    artists: names(track.artists),
    artistAliases: names(track.artistAliases),
    durationMs: track.durationMs,
    pressingDurationsMs: track.pressingDurationsMs || [],
    recordingMbid: track.recordingMbid,
    recordingMbidAliases: names(track.recordingMbidAliases),
    albumName: manifest.title,
    secondaryTypes: names(manifest.secondaryTypes),
    releaseTracks: manifest.tracks,
  };
  return {
    track,
    request,
    prepared: prepareRecordingRequest(request),
    recordingIds: [track.recordingMbid, ...request.recordingMbidAliases].map(readRecordingMbid).filter(Boolean),
    title: titleFacts(track.title),
  };
}

// A search judges every folder against one manifest, so the request side is
// prepared once per manifest.
const preparedRequests = new WeakMap();

function preparedRequest(manifest) {
  let prepared = preparedRequests.get(manifest);
  if (!prepared) {
    prepared = {
      label: prepareVariantRequest({ albumName: manifest.title, artists: manifest.artistNames,
        secondaryTypes: manifest.secondaryTypes, releaseTracks: manifest.tracks }),
      tracks: manifest.tracks.map((track) => trackRequest(manifest, track)),
    };
    preparedRequests.set(manifest, prepared);
  }
  return prepared;
}

function titleFacts(title) {
  const text = normalizeMatchText(title);
  return { text, key: titleKey(title), placeholder: PLACEHOLDER_TITLE.test(text), nonLatin: hasNonLatinLetter(title) };
}

// A placeholder such as "Track 01", or a title in another script than the
// track's, says nothing about which track a file is.
function readsAsTitle(track, file) {
  return Boolean(file.text) && !(file.placeholder && !track.placeholder) && file.nonLatin === track.nonLatin;
}

function directoryOf(path) {
  const parts = String(path || "").split(/[\\/]/);
  return parts.length > 1 ? parts.slice(0, -1).join("/") : null;
}

function fileCandidate(listing, file, labelArtists) {
  const filename = file.filename || String(file.path || "").split(/[\\/]/).at(-1) || null;
  return {
    title: file.title,
    artists: names(file.artists).length ? names(file.artists) : labelArtists,
    durationMs: file.durationMs,
    recordingMbid: file.recordingMbid,
    album: [...new Set([file.album, listing.albumLabel].filter(Boolean))],
    filename: filename ? parseListingTitle(filename).title : null,
    directoryPath: directoryOf(file.path),
    trackNumber: file.trackNumber,
    discNumber: file.discNumber,
  };
}

// A release track and a file are the same place on the release when nothing
// contradicts them, a known length agrees within the selection window, and
// something names the recording: its ID, its title with its length or its
// place, or, for a file with no readable title from the release's artist,
// its place and length.
function judgePair(context, entry, trackIndex, file, fileIndex) {
  const { listing, policy, labelArtists, artistVouched, ordered, fileTitles, labels } = context;
  const { track } = entry;
  const blocked = (blockers, named, position) => ({ fileIndex, trackIndex, blockers, named, position,
    eligible: false, sameSong: false, score: 0 });
  const titled = readsAsTitle(entry.title, fileTitles[fileIndex]);
  const recordingId = readRecordingMbid(file.recordingMbid);
  const sameRecording = Boolean(recordingId) && entry.recordingIds.includes(recordingId);
  const similarTitle = titled && keySimilarity(entry.title.key, fileTitles[fileIndex].key) >= policy.minTitleSimilarity;
  if (titled && !similarTitle && !sameRecording) return blocked(["title"], false, null);
  const position = comparePosition(track, file, ordered ? trackIndex + 1 : null);
  if (position === "different") return blocked(["position"], similarTitle || sameRecording, position);
  const candidate = fileCandidate(listing, file, labelArtists);
  const comparison = compareRecording(entry.request,
    titled ? candidate : { ...candidate, title: null, versionTitle: file.title }, policy, entry.prepared, labels);
  const blockers = comparison.contradictions.filter((variant) => !RELEASE_MIX_VARIANTS.has(variant));
  const gap = comparison.durationGapMs;
  if (gap != null && gap > policy.selectedDurationGapMs && !blockers.includes("duration")) blockers.push("duration");
  const recording = comparison.evidence.includes("recording-mbid");
  const titleEvidence = comparison.evidence.includes("title");
  const exactTitle = comparison.titleSimilarity === 1;
  const placed = position === "same";
  const identity = recording
    || (titleEvidence && gap != null)
    || (exactTitle && placed)
    || (!titled && placed && gap != null && (artistVouched || comparison.evidence.includes("artist")));
  const implausible = implausibleBitrateKbps({ ...file, trackTitle: track.title }) != null;
  return {
    fileIndex,
    trackIndex,
    blockers,
    position,
    named: recording || titleEvidence,
    eligible: blockers.length === 0 && identity,
    sameSong: recording || exactTitle || (!titled && placed),
    implausible,
    score: implausible ? 0 : comparison.score + (placed ? 0.05 : 0),
    evidence: [...comparison.evidence, ...(placed ? ["position"] : [])],
    durationGapMs: gap,
    titleSimilarity: comparison.titleSimilarity,
  };
}

// A file that names a track at its place but missed the selection window, or
// has no length to check, is that track unverified rather than a song the
// release does not hold.
function failedPairing(edge, policy) {
  return Boolean(edge?.named) && edge.position !== "different"
    && edge.blockers.every((blocker) => blocker === "duration")
    && (edge.durationGapMs == null || edge.durationGapMs <= policy.maxDurationGapMs);
}

function variantMarkers(edges) {
  return edges.filter((edge) => edge.named && edge.blockers.length > 0
    && edge.blockers.every((blocker) => !IDENTITY_BLOCKERS.has(blocker)))
    .flatMap((edge) => edge.blockers);
}

function labelRejection(manifest, prepared, listing, performers, policy) {
  const product = listing.albumLabel
    ? otherProductMarker(listing.albumLabel, [manifest.title, ...manifest.artistNames], { album: true })
    : null;
  if (product) return { reason: "other-product", markers: [product] };
  if (artistConflict(listing.artistLabel, performers, policy)) return { reason: "artist-conflict", markers: [] };
  const variants = labelVariants(prepared, listing);
  if (variants.length) return { reason: "unrequested-variant", markers: variants };
  const albums = [listing.albumLabel, ...listing.files.map((file) => file.album)].filter(Boolean);
  if ([...new Set(albums)].some((album) => albumConflict(album, manifest, performers, policy))) {
    return { reason: "album-conflict", markers: [] };
  }
  return null;
}

// Judges whether a listing is exactly the requested release: every track of
// the complete tracklist at its own place, and no file left over that is
// not another copy of a track already there. A file the quality profile
// would refuse still counts, so a listing must include every audio file.
export function judgeRelease(manifest, listing, policy = MATCH_POLICY) {
  const files = listing.files || [];
  const performers = performerNames(manifest);
  const artistVouched = Boolean(listing.artistLabel) && !isVariousArtistsCredit(listing.artistLabel)
    && namesArtist(listing.artistLabel, performers, policy.minArtistSimilarity);
  const prepared = preparedRequest(manifest);
  const context = {
    listing: { ...listing, files },
    policy,
    labelArtists: artistVouched ? [listing.artistLabel] : [],
    artistVouched,
    ordered: manifest.tracks.every((track) => Number(track.trackNumber) > 0),
    fileTitles: files.map((file) => titleFacts(file.title)),
    labels: new Map(),
  };
  const judged = prepared.tracks.map((entry, trackIndex) =>
    files.map((file, fileIndex) => judgePair(context, entry, trackIndex, file, fileIndex)));
  const edges = judged.map((trackEdges) => trackEdges.filter((edge) => edge.eligible)
    .sort((left, right) => right.score - left.score || left.fileIndex - right.fileIndex));
  const assignment = pairTracksWithFiles(edges, files.length);
  const fileForTrack = manifest.tracks.map(() => null);
  for (const pair of assignment.pairs) fileForTrack[pair.trackIndex] = pair.fileIndex;

  const copiesForTrack = fileForTrack.map((fileIndex) => (fileIndex == null ? [] : [fileIndex]));
  const missing = assignment.unassignedTrackIndexes;
  const extras = [];
  for (const fileIndex of assignment.unassignedFileIndexes) {
    const copyOf = edges.flatMap((trackEdges) => trackEdges)
      .filter((edge) => edge.fileIndex === fileIndex && edge.sameSong)
      .map((edge) => edge.trackIndex);
    if (copyOf.length === 1) copiesForTrack[copyOf[0]].push(fileIndex);
    // A paired track's song whose length misses the window, such as a VBR
    // MP3 beside its FLAC, is another copy, though not one to download.
    const unverified = judged.some((trackEdges, trackIndex) => failedPairing(trackEdges[fileIndex], policy)
      && (missing.includes(trackIndex) || trackEdges[fileIndex].sameSong));
    if (copyOf.length === 0 && !unverified) extras.push(fileIndex);
  }
  const fit = assignment.pairs.length
    ? assignment.pairs.reduce((sum, pair) => sum + pair.score, 0) / assignment.pairs.length : 0;

  const label = labelRejection(manifest, prepared.label, context.listing, performers, policy);
  // A peer who shares generated silence at the release's lengths mixes it
  // with real files, so two such copies of release tracks condemn the folder.
  // One is a damaged or silent track, which the download check refuses alone.
  const implausible = new Set(edges.flatMap((trackEdges) => trackEdges.filter((edge) => edge.implausible)
    .map((edge) => edge.fileIndex))).size > 1;
  const unplaced = judged.flatMap((trackEdges, trackIndex) => trackEdges.filter((edge) =>
    missing.includes(trackIndex) || extras.includes(edge.fileIndex)));
  const markers = [...new Set([...(label?.markers || []), ...variantMarkers(unplaced)])];
  if (!label && !implausible && missing.length === 0 && extras.length === 0) {
    return { kind: "exact", fileForTrack, copiesForTrack, fit, assignment, policyVersion: policy.version };
  }
  const reason = label?.reason || (implausible ? "implausible-file" : null)
    || (markers.length ? "unrequested-variant" : extras.length ? "extra-tracks" : "missing-tracks");
  return {
    kind: "rejected", reason, missing, extras, fileForTrack, copiesForTrack, fit, assignment, markers,
    policyVersion: policy.version,
  };
}

// For a track search after the release search: the listing holds the
// requested place on this release, whole or with only other tracks absent or
// unverified.
export function releaseHolds(manifest, listing, index, policy = MATCH_POLICY) {
  const verdict = judgeRelease(manifest, listing, policy);
  if (verdict.kind !== "exact" && verdict.reason !== "missing-tracks") return false;
  return verdict.fileForTrack[index] != null;
}

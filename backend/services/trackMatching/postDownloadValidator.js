// Unified post-download validator.
//
// One provider-independent identity gate for every downloaded audio file.
// The file is parsed with music-metadata BEFORE Aurral repairs or overwrites
// any tag: the original embedded evidence is what gets validated, so a
// wrong download can never be laundered by writing expected metadata first.
//
// Post-download decisions:
//   VERIFIED   — the actual file is convincingly the requested recording
//   CONFLICTED — contradicted or untrustworthy; orchestrator retries the
//                next candidate/source (junk like karaoke tags never reaches
//                review)
//   AMBIGUOUS  — credible but conflicting evidence; orchestrator may hold
//                the file for review when alternatives are exhausted
//   FAILED     — file unusable (unreadable, quality-floor failure)
//
// Orchestrator compatibility: the result also carries legacy-shaped
// `valid`/`blocked` fields (VERIFIED→valid, AMBIGUOUS→blocked) so the
// existing review routing keeps working unchanged.

import path from "node:path";
import { stat } from "node:fs/promises";
import { parseFile } from "music-metadata";
import { buildTrackRequest, recordingRequest } from "./trackIdentity.js";
import {
  claimedTitle,
  getFileBaseName,
  getFileName,
  implausibleBitrateKbps,
  parseFilenameArtistTitle,
} from "./candidateNormalizer.js";
import {
  MATCH_POLICY,
  parseListingTitle,
  readRecordingMbid,
  titleSimilarity,
  verifyDownloadedRecording,
} from "./nativeMatcher.js";
import { judgeRelease } from "./releaseJudge.js";
import { manifestIndexFor } from "../releaseManifest.js";
import { isRequestedYoutubeAlbum, readYoutubeFile } from "./youtubeEvidence.js";
import { scoreTextMatch } from "../providers/brainzmashRanking.js";
import { validateParsedQuality } from "../qualityProfileService.js";
import { logger } from "../logger.js";

export const POST_DOWNLOAD_DECISIONS = {
  VERIFIED: "VERIFIED",
  CONFLICTED: "CONFLICTED",
  AMBIGUOUS: "AMBIGUOUS",
  FAILED: "FAILED",
};

const MANUAL_RELEASE_FILE_TITLE_THRESHOLD = 70;
const STRICT_DURATION_GAP_MS = 1000;
// Beyond this, a file with the requested title is a different edit, a
// hidden-track rip, or a different song, never something worth a review.
const REVIEW_MAX_DURATION_GAP_MS = 30000;

function readTagText(value) {
  return String(value || "").trim() || null;
}

function normalizeValidationRequest(request, context) {
  const source = request || context || {};
  return {
    ...buildTrackRequest(source),
    upgradeForJobId: source.upgradeForJobId || null,
    manualReplacementSearch: source.manualReplacementSearch === true,
  };
}

// "01 Correct Track" -> "Correct Track"; "07. Song" -> "Song". A bare space
// separator only counts when the remainder keeps more than one word, so
// numeric titles such as "99 Problems" survive.
function stripLeadingTrackNumber(baseName) {
  const raw = String(baseName || "").trim();
  const punctuated = /^\s*\d{1,3}\s*[-._)\]]\s*(.+)$/.exec(raw);
  if (punctuated && punctuated[1].trim()) return punctuated[1].trim();
  const spaced = /^\s*\d{1,3}\s+(\S.*)$/.exec(raw);
  if (spaced) {
    const remainder = spaced[1].trim();
    if (remainder && /\s/.test(remainder)) return remainder;
  }
  return raw || null;
}

export function readDurationMsFromParsed(parsed) {
  const seconds = Number(parsed?.format?.duration || 0);
  return seconds > 0 ? Math.round(seconds * 1000) : null;
}

// A downloaded file as the release judge reads a listing entry.
export function downloadedFileEvidence(filePath, parsed, { album = null } = {}) {
  const listing = parseListingTitle(filePath, { album });
  return {
    title: String(parsed?.common?.title || listing.title || "").trim(),
    artists: [parsed?.common?.artist].filter(Boolean),
    durationMs: readDurationMsFromParsed(parsed),
    trackNumber: parsed?.common?.track?.no || listing.trackNumber || null,
    discNumber: parsed?.common?.disc?.no || listing.discNumber || null,
    recordingMbid: readRecordingMbid(parsed?.common?.musicbrainz_recordingid),
    album: String(parsed?.common?.album || "").trim() || null,
    filename: path.basename(filePath),
    path: filePath,
  };
}

// Builds the canonical candidate representation from what the FILE itself
// claims (embedded tags first, filename as secondary evidence). This is the
// evidence that gets validated — never the values Aurral is about to write.
export function buildActualFileCandidate(parsed, filePath, source, preDownloadCandidate = null) {
  const common = parsed?.common || {};
  const artists = [...new Set(
    [common.artist, ...(Array.isArray(common.artists) ? common.artists : []), common.albumartist]
      .map((entry) => readTagText(entry))
      .filter(Boolean),
  )];
  const fileName = getFileName(filePath);
  const baseName = getFileBaseName(fileName);
  const trackNumber =
    common.track?.no != null && Number.isFinite(Number(common.track.no))
      ? Math.round(Number(common.track.no))
      : null;
  const discNumber =
    common.disc?.no != null && Number.isFinite(Number(common.disc.no))
      ? Math.round(Number(common.disc.no))
      : null;
  const taggedTitle = readTagText(common.title);
  const filenameTitle = taggedTitle ? null : stripLeadingTrackNumber(baseName);
  const title = taggedTitle || baseName;
  return {
    source,
    title,
    filenameTitle,
    cleanedTitle: claimedTitle(taggedTitle || filenameTitle || title),
    artists,
    album: readTagText(common.album),
    durationMs: readDurationMsFromParsed(parsed),
    year:
      common.year != null && Number.isFinite(Number(common.year))
        ? Math.round(Number(common.year))
        : null,
    trackNumber,
    discNumber,
    recordingMbid:
      readRecordingMbid(common.musicbrainz_recordingid) ||
      readRecordingMbid(common.musicbrainz_trackid) ||
      null,
    releaseMbid: readTagText(common.musicbrainz_albumid) || null,
    filename: fileName,
    path: filePath,
    quality: {
      format:
        readTagText(common.format) ||
        String(parsed?.format?.container || "").toLowerCase() ||
        null,
      bitrate: Number(parsed?.format?.bitrate) > 0 ? Math.round(Number(parsed.format.bitrate)) : null,
      bitDepth: Number(parsed?.format?.bitsPerSample) > 0 ? Math.round(Number(parsed.format.bitsPerSample)) : null,
      sampleRate: Number(parsed?.format?.sampleRate) > 0 ? Math.round(Number(parsed.format.sampleRate)) : null,
    },
    provider: {
      id: preDownloadCandidate?.provider?.id || null,
      uploader: preDownloadCandidate?.provider?.uploader || preDownloadCandidate?.raw?.channel || preDownloadCandidate?.raw?.uploader || null,
    },
    raw: preDownloadCandidate?.raw || {},
  };
}

function joinPhrases(phrases) {
  return phrases.length > 1
    ? `${phrases.slice(0, -1).join(", ")} and ${phrases.at(-1)}`
    : phrases[0];
}

function describeReviewReason({ verification, titleAgrees, artists, actualDurationMs, requestedDurationMs, maxDurationGapMs }) {
  const issues = [];
  const gap = verification.durationGapMs;
  if (gap == null) {
    issues.push("has no comparable length");
  } else if (gap > maxDurationGapMs) {
    const seconds = (Math.ceil(gap / 100) / 10).toFixed(1);
    issues.push(`is ${seconds}s ${actualDurationMs > requestedDurationMs ? "longer" : "shorter"} than the requested track`);
  }
  if (!verification.evidence.includes("title") || !titleAgrees) {
    issues.push("has a title that only partly matches the requested track");
  }
  if (!verification.evidence.includes("artist")) {
    issues.push(artists.length
      ? "has an artist tag that only partly matches the requested artist"
      : "has no artist tag");
  }
  return `downloaded file ${joinPhrases(issues)}`;
}

export async function validateDownloadedTrackFile({
  request,
  context,
  candidate,
  filePath,
  source,
  options = {},
} = {}) {
  const trackRequest = normalizeValidationRequest(request, context);
  const strict = options.strict === true;
  const parseFn = options.parseFile || parseFile;

  let parsed = null;
  try {
    parsed = await parseFn(filePath, { duration: true });
  } catch {
    return {
      decision: POST_DOWNLOAD_DECISIONS.FAILED,
      valid: false,
      blocked: false,
      reason: "downloaded file is not readable audio",
      filePath,
      parsedTags: null,
    };
  }

  const actual = buildActualFileCandidate(parsed, filePath, source, candidate);
  const actualDurationMs = actual.durationMs;

  const kbps = implausibleBitrateKbps({
    path: filePath,
    lossless: typeof parsed?.format?.lossless === "boolean" ? parsed.format.lossless : null,
    sizeBytes: (await stat(filePath).catch(() => null))?.size,
    durationMs: actualDurationMs,
    trackTitle: trackRequest.trackName,
  });
  if (kbps != null) {
    return {
      decision: POST_DOWNLOAD_DECISIONS.FAILED,
      valid: false,
      blocked: false,
      reason: `downloaded file is ${kbps.toFixed(1)} kbit/s, too small for its length to hold music`,
      filePath,
      actual: { tags: actual, durationMs: actualDurationMs },
      actualDurationMs,
      parsedTags: actual,
    };
  }

  const quality = validateParsedQuality(parsed, filePath, {
    upgradeForJobId: trackRequest.upgradeForJobId || null,
    manualReplacementSearch: trackRequest.manualReplacementSearch,
    manualSelection: options.manualSelection === true,
  });
  if (!quality.valid) {
    return {
      decision: POST_DOWNLOAD_DECISIONS.FAILED,
      valid: false,
      blocked: false,
      reason: quality.reason || "downloaded file failed the quality profile",
      filePath,
      quality: quality.quality,
      actual: { tags: actual, durationMs: actualDurationMs },
      actualDurationMs,
      parsedTags: actual,
    };
  }

  // A manual search is an explicit identity decision by the user. Keep the
  // technical audio checks above, but do not let automatic title, artist,
  // album, duration, variant, or matcher policy overrule that choice.
  if (options.manualSelection === true) {
    return {
      decision: POST_DOWNLOAD_DECISIONS.VERIFIED,
      valid: true,
      blocked: false,
      reason: null,
      filePath,
      source,
      actualDurationMs,
      quality: quality.quality,
      strict: false,
      actual: { tags: actual, durationMs: actualDurationMs },
      parsedTags: actual,
      manualSelection: true,
    };
  }

  const listedTitle = parseListingTitle(actual.filename).title;
  // "Artist [Album] 08 - Title" names more than the artist before the title,
  // so the last part counts when it is closer to the requested title.
  const filenameTitle = parseFilenameArtistTitle(listedTitle,
    [trackRequest.artistName, ...(trackRequest.artistAliases || [])].filter(Boolean)).title
    || [listedTitle, claimedTitle(listedTitle)].filter(Boolean).reduce((kept, option) =>
      titleSimilarity(trackRequest.trackName, option) > titleSimilarity(trackRequest.trackName, kept) ? option : kept);
  const hasYtdlpIdFilename = source === "ytdlp"
    && getFileBaseName(actual.filename) === readTagText(actual.provider.id);
  const requestedArtists = [trackRequest.artistName, ...(trackRequest.artistAliases || [])].filter(Boolean);
  // A YouTube Music song is tagged with its own track, artists, and album, so
  // its tags are read as any other file's.
  const youtube = source === "ytdlp" && actual.raw?.song !== true
    ? readYoutubeFile({
      tagTitle: actual.title,
      tagArtists: actual.artists,
      videoTitle: actual.raw?.title,
      channel: actual.provider.uploader,
    }, requestedArtists, trackRequest.trackName)
    : null;
  const importedRelease = options.albumImport === true ? options.release : null;
  const verification = verifyDownloadedRecording(recordingRequest(trackRequest, importedRelease), {
    title: youtube ? youtube.title : actual.title,
    versionTitle: youtube?.versionTitle,
    fileNameTitle: !hasYtdlpIdFilename && (
      /\s[-–—]\s|\b(?:live|remix|karaoke|instrumental|acoustic|demo|edit|cover|nightcore)\b/iu.test(actual.filename)
      || /(?!\p{Script=Latin})\p{L}/u.test(`${trackRequest.trackName} ${filenameTitle}`))
      ? filenameTitle : null,
    artists: youtube ? youtube.artists : actual.artists,
    durationMs: actualDurationMs,
    recordingMbid: actual.recordingMbid,
    album: actual.album,
    path: actual.path,
    filename: hasYtdlpIdFilename ? null : actual.filename,
    trackNumber: actual.trackNumber,
    discNumber: actual.discNumber,
  }, options.release ? { ...MATCH_POLICY, maxDurationGapMs: MATCH_POLICY.selectedDurationGapMs } : MATCH_POLICY);
  const hasOriginalIdentityTags = Boolean(readTagText(parsed?.common?.title)
    || readTagText(parsed?.common?.artist));
  const contradictions = verification.contradictions.map((entry) => {
    if (entry === "recording-mbid") return "recording-mbid-conflict";
    if (entry === "variant" || entry === "filename-variant") {
      const namedVariant = ["karaoke", "live", "remix", "acoustic", "instrumental", "demo", "edit", "cover", "nightcore"]
        .find((name) => new RegExp(`\\b${name}\\b`, "iu").test(`${actual.title} ${actual.filename}`));
      return namedVariant || entry;
    }
    return entry;
  });
  const durationOnlyConflict = hasOriginalIdentityTags
    && verification.contradictions.length === 1
    && verification.contradictions[0] === "duration"
    && verification.durationGapMs <= REVIEW_MAX_DURATION_GAP_MS
    && verification.evidence.includes("title")
    && verification.evidence.includes("artist");
  const tagsConfirmIdentity = Boolean(readTagText(parsed?.common?.title))
    && verification.evidence.includes("title")
    && verification.evidence.includes("artist");
  // Editions of one recording differ by a few seconds of mastering, fade, or
  // silence, so an exact title and artist allow the matcher's full duration
  // window, as Lidarr does. A YouTube upload needs to be the artist's own
  // audio upload too: re-uploads are often re-timed. A YouTube Music song on
  // another album may be another mix or a live take of the same title.
  const releaseAudio = youtube ? youtube.officialAudio
    : source !== "ytdlp" || isRequestedYoutubeAlbum(trackRequest, actual.album || actual.raw?.album);
  const exactIdentity = tagsConfirmIdentity && verification.titleSimilarity === 1 && releaseAudio;
  const maxDurationGapMs = options.release
    ? MATCH_POLICY.selectedDurationGapMs
    : exactIdentity
    ? MATCH_POLICY.maxDurationGapMs
    : strict && !tagsConfirmIdentity
      ? STRICT_DURATION_GAP_MS
      : MATCH_POLICY.selectedDurationGapMs;
  const durationUncertain = verification.durationGapMs != null
    && verification.durationGapMs > maxDurationGapMs && !verification.evidence.includes("recording-mbid");
  // Uploaders add words such as "Concept" or "Reworked" that no version rule
  // knows, so a YouTube title must match exactly.
  const titleAgrees = source !== "ytdlp" || verification.titleSimilarity === 1;
  const matched = titleAgrees && (verification.decision === "matched"
    || (exactIdentity && verification.contradictions.length === 0 && verification.durationGapMs != null));
  const reviewable = durationOnlyConflict
    || (verification.decision !== "no_match" && hasOriginalIdentityTags);
  // The Library already has a copy, so an automatic upgrade that is not
  // verified is dropped instead of asking anyone to review it.
  const automaticUpgrade = Boolean(trackRequest.upgradeForJobId) && !trackRequest.manualReplacementSearch;
  const decision = matched && !durationUncertain
    ? POST_DOWNLOAD_DECISIONS.VERIFIED
    : reviewable && !automaticUpgrade
      ? POST_DOWNLOAD_DECISIONS.AMBIGUOUS
      : POST_DOWNLOAD_DECISIONS.CONFLICTED;
  const reviewReason = decision !== POST_DOWNLOAD_DECISIONS.VERIFIED && reviewable
    ? describeReviewReason({
      verification,
      titleAgrees,
      artists: youtube ? youtube.artists : actual.artists,
      actualDurationMs,
      requestedDurationMs: trackRequest.durationMs,
      maxDurationGapMs,
    })
    : null;
  const reason = decision === POST_DOWNLOAD_DECISIONS.VERIFIED
    ? null
    : reviewReason
      ? reviewReason
      : contradictions.length
        ? `downloaded file contradicts the requested recording: ${contradictions.join(", ")}`
        : "downloaded file has no original identity tags";
  logger.debug("matcher", "post-download validation", {
    source, stage: "post-download", decision,
    durationDiffMs: verification.durationGapMs,
    policyVersion: verification.policyVersion,
  });
  return {
    decision,
    valid: decision === POST_DOWNLOAD_DECISIONS.VERIFIED,
    blocked: decision === POST_DOWNLOAD_DECISIONS.AMBIGUOUS,
    reason,
    contradictions,
    filePath,
    source,
    distance: 1 - verification.score,
    recommendation: decision === POST_DOWNLOAD_DECISIONS.VERIFIED ? "strong" : "none",
    native: verification,
    actualDurationMs,
    quality: quality.quality,
    strict,
    actual: { tags: actual, durationMs: actualDurationMs },
    parsedTags: actual,
  };
}

// Selects the best matching audio file from a downloaded release folder.
// With the release the track is on, the release judge places each file, so
// only the files at the track's place are its candidates and a file placed
// at another track never is, even with the same title on another disc.
// Otherwise every file is validated individually and the strongest VERIFIED
// result wins.
export async function selectVerifiedDownloadedFile({
  request,
  context,
  filePaths = [],
  candidate = null,
  source,
  options = {},
} = {}) {
  const trackRequest = normalizeValidationRequest(request, context);
  const parseFn = options.parseFile || parseFile;
  if (!Array.isArray(filePaths) || filePaths.length === 0) {
    return { filePath: null, validation: null };
  }

  const parsedFiles = [];
  for (const filePath of filePaths) {
    try {
      parsedFiles.push({
        filePath,
        parsed: await parseFn(filePath, { duration: true }),
      });
    } catch {
      // Unreadable files simply do not become assignment candidates.
    }
  }

  const { release, ...fileOptions } = options;
  const releaseIndex = release && options.manualSelection !== true ? manifestIndexFor(release, trackRequest) : null;
  let pool = parsedFiles;
  let poolOptions = fileOptions;
  if (releaseIndex != null && parsedFiles.length > 0) {
    const verdict = judgeRelease(release, {
      files: parsedFiles.map(({ filePath, parsed }) => downloadedFileEvidence(filePath, parsed, { album: release.title })),
    });
    const copies = verdict.copiesForTrack[releaseIndex];
    const placed = new Set(verdict.assignment.pairs.map((pair) => pair.fileIndex));
    pool = copies.length > 0
      ? copies.map((index) => parsedFiles[index])
      : parsedFiles.filter((_, index) => !placed.has(index));
    poolOptions = options;
  }

  if (options.manualSelection === true && parsedFiles.length > 1) {
    const expectedTrackNumber = Number(trackRequest.trackNumber || 0);
    const selected = parsedFiles
      .map((entry, index) => {
        const taggedTitle = readTagText(entry.parsed?.common?.title);
        const filename = getFileBaseName(entry.filePath);
        const actualTrackNumber = Number(entry.parsed?.common?.track?.no || 0);
        const titleScore = Math.max(
          scoreTextMatch(taggedTitle, trackRequest.trackName),
          scoreTextMatch(filename, trackRequest.trackName),
        );
        const trackNumberMatches =
          expectedTrackNumber > 0 && actualTrackNumber === expectedTrackNumber;
        return { entry, index, titleScore, trackNumberMatches };
      })
      .sort((left, right) =>
        right.titleScore - left.titleScore ||
        Number(right.trackNumberMatches) - Number(left.trackNumberMatches) ||
        left.index - right.index)[0];
    if (selected?.entry && selected.titleScore >= MANUAL_RELEASE_FILE_TITLE_THRESHOLD) {
      const validation = await validateDownloadedTrackFile({
        request: trackRequest,
        candidate,
        filePath: selected.entry.filePath,
        source,
        options,
      });
      if (validation.valid) return { filePath: selected.entry.filePath, validation };
    }
    return {
      filePath: null,
      validation: {
        decision: POST_DOWNLOAD_DECISIONS.FAILED,
        valid: false,
        blocked: false,
        reason: "selected release does not contain a file matching the requested track",
      },
    };
  }

  let best = null;
  let strongestRejected = null;
  for (const { filePath } of pool) {
    const validation = await validateDownloadedTrackFile({
      request: trackRequest,
      candidate,
      filePath,
      source,
      options: poolOptions,
    });
    // Conflicted files are never import candidates: only verified files and
    // genuinely ambiguous ones (review-worthy) come back from here.
    if (
      validation.decision !== POST_DOWNLOAD_DECISIONS.VERIFIED &&
      validation.decision !== POST_DOWNLOAD_DECISIONS.AMBIGUOUS
    ) {
      const hasError = Boolean(validation.error);
      const hasStrongerEvidence =
        !strongestRejected ||
        (hasError && !strongestRejected.error) ||
        (hasError === Boolean(strongestRejected.error) &&
          (validation.distance ?? Infinity) < (strongestRejected.distance ?? Infinity));
      if (hasStrongerEvidence) strongestRejected = validation;
      continue;
    }
    const rank = validation.decision === POST_DOWNLOAD_DECISIONS.VERIFIED ? 0 : 1;
    const better =
      !best ||
      rank < best.rank ||
      (rank === best.rank && (validation.distance ?? Infinity) < (best.validation.distance ?? Infinity));
    if (better) best = { filePath, validation, rank };
  }
  if (!best) return { filePath: null, validation: strongestRejected };
  return { filePath: best.filePath, validation: best.validation };
}

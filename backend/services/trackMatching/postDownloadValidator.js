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

import { parseFile } from "music-metadata";
import { buildTrackRequest } from "./trackIdentity.js";
import { getFileName, getFileBaseName, claimedTitle } from "./candidateNormalizer.js";
import { checkVariantCompatibility, detectNoise, getCoreTitle, extractVariants } from "./semanticPolicy.js";
import { runMatcherOperation } from "./beetsClient.js";
import {
  toProtocolRequest,
  recommendationFromDistance,
  isWithinBaseDurationTolerance,
  MATCHER_UNAVAILABLE_MESSAGE,
} from "./decisionEngine.js";
import { getNormalizedText, scoreTextMatch } from "../providers/brainzmashRanking.js";
import { validateParsedQuality } from "../qualityProfileService.js";
import { logger } from "../logger.js";

export const POST_DOWNLOAD_DECISIONS = {
  VERIFIED: "VERIFIED",
  CONFLICTED: "CONFLICTED",
  AMBIGUOUS: "AMBIGUOUS",
  FAILED: "FAILED",
};

function readTagText(value) {
  return String(value || "").trim() || null;
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
    artists: artists.length > 0 ? artists : preDownloadCandidate?.artists || [],
    album: readTagText(common.album),
    durationMs: readDurationMsFromParsed(parsed),
    year:
      common.year != null && Number.isFinite(Number(common.year))
        ? Math.round(Number(common.year))
        : null,
    trackNumber,
    discNumber,
    recordingMbid:
      readTagText(common.musicbrainz_recordingid) ||
      readTagText(common.musicbrainz_trackid) ||
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

function parsedFileTitleEvidence(request, actual) {
  const ownScore = scoreTextMatch(actual.title, request.trackName);
  const targetKey = getNormalizedText(getCoreTitle(request.trackName));
  const bestSibling = (request.albumTrackTitles || [])
    .filter((title) => getNormalizedText(getCoreTitle(title)) !== targetKey)
    .reduce((best, title) => Math.max(best, scoreTextMatch(actual.title, title)), 0);
  return { ownScore, bestSibling };
}

// Recording-MBID comparison, post-download. Entity discipline: only the
// expected `recordingMbid` and the embedded `musicbrainz_recordingid` tag
// enter this comparison; `musicbrainz_albumid` (release entity) is captured
// as release evidence and never compared against a recording ID.
function readIdentifierPair(request, actual) {
  const expected = String(request.recordingMbid || "").trim() || null;
  const candidate = String(actual.recordingMbid || "").trim() || null;
  if (!expected || !candidate) return { present: false, conflict: false, match: false };
  const match = expected.toLowerCase() === candidate.toLowerCase();
  return { present: true, conflict: !match, match };
}

export async function validateDownloadedTrackFile({
  request,
  context,
  candidate,
  filePath,
  source,
  options = {},
} = {}) {
  const trackRequest = request || buildTrackRequest(context);
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
  const expectedDurationMs = Number(trackRequest.durationMs || 0);
  const actualDurationMs = actual.durationMs;
  const durationDiffMs =
    expectedDurationMs > 0 && actualDurationMs != null
      ? Math.abs(actualDurationMs - expectedDurationMs)
      : null;

  const quality = validateParsedQuality(parsed, filePath, {
    upgradeForJobId: trackRequest.upgradeForJobId || null,
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

  // Semantic contradictions on the ORIGINAL tags. Junk ("Karaoke Version"
  // burned into the tags) is auto-rejected; it is never review material.
  const variantCheck = checkVariantCompatibility(trackRequest, {
    ...actual,
    variants: {
      ...extractVariants([actual.title, actual.filename].filter(Boolean).join(" ")),
      ...(candidate?.variants && typeof candidate.variants === "object" ? candidate.variants : {}),
    },
  });
  if (variantCheck.contradictions.length > 0) {
    logger.debug("matcher", "post-download contradiction", {
      source,
      contradictions: variantCheck.contradictions,
    });
    return {
      decision: POST_DOWNLOAD_DECISIONS.CONFLICTED,
      valid: false,
      blocked: false,
      reason: `downloaded file contradicts the requested version: ${variantCheck.contradictions.join(", ")}`,
      contradictions: variantCheck.contradictions,
      filePath,
      actualDurationMs,
      quality: quality.quality,
      actual: { tags: actual, durationMs: actualDurationMs },
      parsedTags: actual,
    };
  }

  const noise = detectNoise([actual.title, actual.filename].filter(Boolean).join(" "));
  if (noise.length > 0) {
    return {
      decision: POST_DOWNLOAD_DECISIONS.CONFLICTED,
      valid: false,
      blocked: false,
      reason: `downloaded file looks like noise: ${noise.join(", ")}`,
      noise,
      filePath,
      actualDurationMs,
      quality: quality.quality,
      actual: { tags: actual, durationMs: actualDurationMs },
      parsedTags: actual,
    };
  }

  const identifier = readIdentifierPair(trackRequest, actual);
  if (identifier.conflict) {
    return {
      decision: POST_DOWNLOAD_DECISIONS.CONFLICTED,
      valid: false,
      blocked: false,
      reason: "embedded recording MBID conflicts with the requested recording",
      contradictions: ["recording-mbid-conflict"],
      filePath,
      actualDurationMs,
      quality: quality.quality,
      actual: { tags: actual, durationMs: actualDurationMs },
      parsedTags: actual,
    };
  }

  // One beets track_distance call with the actual-file candidate against the
  // requested track. The expected recording MBID only competes when the file
  // embeds one (identifier conflicts are decided above).
  const matcherOutcome = await runMatcherOperation(
    "track_distance",
    {
      expected: toProtocolRequest(trackRequest),
      candidates: [
        {
          source,
          title: actual.cleanedTitle || actual.title,
          artist: actual.artists[0],
          artists: actual.artists,
          album: actual.album,
          durationMs: actualDurationMs,
          year: actual.year,
          trackNumber: actual.trackNumber,
          discNumber: actual.discNumber,
          recordingMbid: identifier.present ? actual.recordingMbid : null,
        },
      ],
    },
    { timeoutMs: options.timeoutMs, pythonPath: options.pythonPath, scriptPath: options.scriptPath },
  );

  if (!matcherOutcome.ok) {
    logger.warn("matcher", "post-download matcher unavailable", {
      source,
      code: matcherOutcome.error?.code,
    });
    // No silent fallback: the file is not verified and not accepted. The
    // orchestrator treats this like a conflicted download and surfaces the
    // diagnostic through the normal retry/failure path.
    return {
      decision: POST_DOWNLOAD_DECISIONS.CONFLICTED,
      valid: false,
      blocked: false,
      reason: MATCHER_UNAVAILABLE_MESSAGE,
      error: matcherOutcome.error,
      filePath,
      actualDurationMs,
      quality: quality.quality,
      actual: { tags: actual, durationMs: actualDurationMs },
      parsedTags: actual,
    };
  }

  const match = matcherOutcome.result?.matches?.[0] || null;
  const thresholds = matcherOutcome.result?.thresholds || {
    strongRecThresh: 0.04,
    mediumRecThresh: 0.25,
    recGapThresh: 0.25,
  };
  const distance = match?.distance ?? null;
  const recommendation = recommendationFromDistance(distance, thresholds);

  const titleEvidence = parsedFileTitleEvidence(trackRequest, actual);
  const durationOk =
    durationDiffMs == null
      ? true
      : strict
        ? isWithinBaseDurationTolerance(durationDiffMs, expectedDurationMs)
        : isWithinBaseDurationTolerance(durationDiffMs, expectedDurationMs) ||
          durationDiffMs <= Math.max(60000, expectedDurationMs * 0.45);

  const beetsEvidence = {
    distance,
    penalties: match?.penalties || {},
    maxDistance: match?.maxDistance ?? null,
    rawDistance: match?.rawDistance ?? null,
    recommendation,
    thresholds,
  };
  const aurralEvidence = {
    duration: {
      expectedMs: expectedDurationMs || null,
      actualMs: actualDurationMs,
      diffMs: durationDiffMs,
      withinBaseTolerance: durationDiffMs == null ? true : isWithinBaseDurationTolerance(durationDiffMs, expectedDurationMs),
    },
    titleEvidence,
    recordingMbid: identifier.present ? { match: identifier.match, mbid: actual.recordingMbid } : null,
    album: actual.album ? scoreTextMatch(actual.album, trackRequest.albumName || "", { extended: true }) : null,
    trackNumber: {
      expected: trackRequest.trackNumber || null,
      actual: actual.trackNumber,
      mismatch:
        Number.isFinite(Number(trackRequest.trackNumber)) &&
        Number(trackRequest.trackNumber) > 0 &&
        actual.trackNumber != null &&
        actual.trackNumber !== Number(trackRequest.trackNumber),
    },
    tags: {
      title: actual.title,
      artists: actual.artists,
      album: actual.album,
      year: actual.year,
    },
  };

  let decision;
  let reason = null;
  // Near-exact identity tags: the file claims to be the requested recording.
  // beets omits zero penalties from its evidence, so absence means "matched".
  const tagsMatchStrongly =
    Number(beetsEvidence.penalties.track_title ?? 0) < 0.05 &&
    Number(beetsEvidence.penalties.track_artist ?? 0) < 0.05;
  const shapeAgrees = durationOk && !aurralEvidence.trackNumber.mismatch;
  if (identifier.match) {
    decision = durationOk ? POST_DOWNLOAD_DECISIONS.VERIFIED : POST_DOWNLOAD_DECISIONS.AMBIGUOUS;
    reason = durationOk ? null : "recording MBID matches but the duration conflicts";
  } else if (tagsMatchStrongly && shapeAgrees) {
    decision = POST_DOWNLOAD_DECISIONS.VERIFIED;
  } else if (tagsMatchStrongly) {
    // Tags claim the right track but the audio shape disagrees — credible
    // conflicting evidence, not junk.
    decision = POST_DOWNLOAD_DECISIONS.AMBIGUOUS;
    reason = !durationOk
      ? `duration mismatch: expected ${expectedDurationMs}ms, actual ${actualDurationMs}ms`
      : `track number mismatch: expected ${trackRequest.trackNumber}, actual ${actual.trackNumber}`;
  } else if (recommendation === "medium" && shapeAgrees) {
    decision = POST_DOWNLOAD_DECISIONS.AMBIGUOUS;
    reason = `moderate identity match (distance ${distance})`;
  } else {
    decision = POST_DOWNLOAD_DECISIONS.CONFLICTED;
    reason = `downloaded file does not match the requested track (distance ${distance})`;
  }

  if (decision === POST_DOWNLOAD_DECISIONS.VERIFIED && titleEvidence.bestSibling >= 95 && titleEvidence.bestSibling > titleEvidence.ownScore + 20) {
    decision = POST_DOWNLOAD_DECISIONS.CONFLICTED;
    reason = "embedded title names a sibling track from the requested release";
  }

  const verified = decision === POST_DOWNLOAD_DECISIONS.VERIFIED;
  logger.debug("matcher", "post-download validation", {
    source,
    stage: "post-download",
    decision,
    distance,
    recommendation,
    durationDiffMs,
  });

  return {
    decision,
    valid: verified,
    // AMBIGUOUS is review-worthy; CONFLICTED is not (junk is auto-rejected).
    blocked: decision === POST_DOWNLOAD_DECISIONS.AMBIGUOUS,
    reason,
    contradictions: variantCheck.contradictions,
    filePath,
    source,
    distance,
    recommendation,
    beets: beetsEvidence,
    aurralEvidence,
    actualDurationMs,
    quality: quality.quality,
    strict,
    actual: { tags: actual, durationMs: actualDurationMs },
    parsedTags: actual,
  };
}

// Selects the best matching audio file from a downloaded release folder.
// Uses beets' assign_items when the request carries a
// tracklist so the right file is picked even among same-looking names;
// otherwise every file is validated individually and the strongest VERIFIED
// result wins.
export async function selectVerifiedDownloadedFile({
  request,
  context,
  filePaths = [],
  candidate = null,
  source,
  options = {},
} = {}) {
  const trackRequest = request || buildTrackRequest(context);
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

  const tracklist = Array.isArray(trackRequest.albumTrackTitles)
    ? trackRequest.albumTrackTitles
    : [];
  if (tracklist.length >= 2 && parsedFiles.length >= 2) {
    const targetKey = getNormalizedText(getCoreTitle(trackRequest.trackName));
    let targetIndex = tracklist.findIndex(
      (title) => getNormalizedText(getCoreTitle(title)) === targetKey,
    );
    if (targetIndex === -1) targetIndex = 0;
    const outcome = await runMatcherOperation(
      "assign_items",
      {
        files: parsedFiles.map(({ parsed, filePath }) => ({
          title: readTagText(parsed?.common?.title) || getFileName(filePath),
          artist: parsed?.common?.artist || undefined,
          durationMs: readDurationMsFromParsed(parsed) || undefined,
          trackNumber: parsed?.common?.track?.no || undefined,
          discNumber: parsed?.common?.disc?.no || undefined,
        })),
        releaseTracks: tracklist.map((title, index) => ({
          title,
          trackNumber: index + 1,
        })),
      },
      { timeoutMs: options.timeoutMs, pythonPath: options.pythonPath, scriptPath: options.scriptPath },
    );
    if (outcome.ok) {
      const assignment = (outcome.result?.assignments || []).find(
        (entry) => entry.releaseTrackIndex === targetIndex,
      );
      if (assignment) {
        const assigned = parsedFiles[assignment.fileIndex];
        if (assigned) {
          const validation = await validateDownloadedTrackFile({
            request: trackRequest,
            candidate,
            filePath: assigned.filePath,
            source,
            options,
          });
          if (validation.decision === POST_DOWNLOAD_DECISIONS.VERIFIED) {
            return { filePath: assigned.filePath, validation };
          }
        }
      }
    }
  }

  let best = null;
  for (const { filePath } of parsedFiles) {
    const validation = await validateDownloadedTrackFile({
      request: trackRequest,
      candidate,
      filePath,
      source,
      options,
    });
    // Conflicted files are never import candidates: only verified files and
    // genuinely ambiguous ones (review-worthy) come back from here.
    if (
      validation.decision !== POST_DOWNLOAD_DECISIONS.VERIFIED &&
      validation.decision !== POST_DOWNLOAD_DECISIONS.AMBIGUOUS
    ) {
      continue;
    }
    const rank = validation.decision === POST_DOWNLOAD_DECISIONS.VERIFIED ? 0 : 1;
    const better =
      !best ||
      rank < best.rank ||
      (rank === best.rank && (validation.distance ?? Infinity) < (best.validation.distance ?? Infinity));
    if (better) best = { filePath, validation, rank };
  }
  if (!best) return { filePath: null, validation: null };
  return { filePath: best.filePath, validation: best.validation };
}

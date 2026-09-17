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
import { getCoreTitle, extractVariants } from "./semanticPolicy.js";
import { runMatcherOperation } from "./beetsClient.js";
import {
  toProtocolRequest,
} from "./decisionEngine.js";
import { getNormalizedText } from "../providers/brainzmashRanking.js";
import {
  DEFAULT_MATCH_THRESHOLDS,
  MATCHER_UNAVAILABLE_MESSAGE,
  evaluateTrackIdentity,
} from "./identityPolicy.js";
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
  const actualDurationMs = actual.durationMs;

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

  // Validate semantic and identifier evidence on the ORIGINAL tags. Junk
  // ("Karaoke Version" burned into the tags) is auto-rejected; it is never
  // review material.
  const identityCandidate = {
    ...actual,
    variants: {
      ...extractVariants([actual.title, actual.filename].filter(Boolean).join(" ")),
      ...(candidate?.variants && typeof candidate.variants === "object" ? candidate.variants : {}),
    },
  };
  const hardIdentity = evaluateTrackIdentity({
    request: trackRequest,
    candidate: identityCandidate,
    source,
    phase: "post",
    strict,
  });
  if (hardIdentity.rejected) {
    const reason = hardIdentity.reason === "contradiction"
      ? `downloaded file contradicts the requested version: ${hardIdentity.contradictions.join(", ")}`
      : hardIdentity.reason === "noise"
        ? `downloaded file looks like noise: ${hardIdentity.noise.join(", ")}`
        : hardIdentity.reasons?.[0] || hardIdentity.reason;
    return {
      decision: hardIdentity.decision,
      valid: false,
      blocked: false,
      reason,
      contradictions: hardIdentity.contradictions,
      noise: hardIdentity.noise,
      filePath,
      source,
      actualDurationMs,
      quality: quality.quality,
      actual: { tags: actual, durationMs: actualDurationMs },
      parsedTags: actual,
    };
  }

  // One beets track_distance call with the actual-file candidate against the
  // requested track. Identifier conflicts were already decided above.
  const matcherOutcome = await runMatcherOperation(
    "track_distance",
    {
      expected: toProtocolRequest(trackRequest),
      candidates: [
        {
          source,
          title: identityCandidate.cleanedTitle || identityCandidate.title,
          artist: identityCandidate.artists[0],
          artists: identityCandidate.artists,
          album: identityCandidate.album,
          durationMs: actualDurationMs,
          year: identityCandidate.year,
          trackNumber: identityCandidate.trackNumber,
          discNumber: identityCandidate.discNumber,
          recordingMbid: identityCandidate.recordingMbid,
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
  if (!match || match.skipped) {
    return {
      decision: POST_DOWNLOAD_DECISIONS.CONFLICTED,
      valid: false,
      blocked: false,
      reason: match?.reason || "downloaded file has no usable title",
      filePath,
      source,
      actualDurationMs,
      quality: quality.quality,
      actual: { tags: actual, durationMs: actualDurationMs },
      parsedTags: actual,
    };
  }
  const thresholds = matcherOutcome.result?.thresholds || DEFAULT_MATCH_THRESHOLDS;
  const identity = evaluateTrackIdentity({
    request: trackRequest,
    candidate: identityCandidate,
    source,
    match,
    thresholds,
    strict,
    phase: "post",
  });
  const decision = identity.decision;
  const reason = identity.reason;
  const beetsEvidence = {
    distance: identity.distance,
    penalties: identity.penalties,
    maxDistance: identity.maxDistance,
    rawDistance: identity.rawDistance,
    recommendation: identity.recommendation,
    thresholds,
  };

  const verified = decision === POST_DOWNLOAD_DECISIONS.VERIFIED;
  logger.debug("matcher", "post-download validation", {
    source,
    stage: "post-download",
    decision,
    distance: identity.distance,
    recommendation: identity.recommendation,
    durationDiffMs: identity.aurralEvidence.duration?.diffMs ?? null,
  });

  return {
    decision,
    valid: verified,
    // AMBIGUOUS is review-worthy; CONFLICTED is not (junk is auto-rejected).
    blocked: decision === POST_DOWNLOAD_DECISIONS.AMBIGUOUS,
    reason,
    contradictions: identity.contradictions,
    noise: identity.noise,
    filePath,
    source,
    distance: identity.distance,
    recommendation: identity.recommendation,
    beets: beetsEvidence,
    aurralEvidence: identity.aurralEvidence,
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
  let strongestRejected = null;
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

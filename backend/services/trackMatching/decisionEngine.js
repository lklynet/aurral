// Decision engine: turns normalized candidates into explicit, explainable
// pre-download decisions.
//
// Division of labor: beets computes the music-record distance (title, artist,
// duration, track index, recording MBID); Aurral owns every final decision —
// semantic contradictions, identifier conflicts, sibling-track conflicts,
// album/year evidence, best-vs-runner-up separation, and the accept/verify/
// review/reject mapping. No private beets internals are involved: the
// recommendation policy below is derived from the public distance plus the
// configured thresholds the Python matcher echoes back.
//
// Pipeline:
//   canonical request
//     → Aurral pre-filter (contradictions, MBID conflicts, noise: no Python)
//     → one beets rank_tracks call for all survivors
//     → Aurral decision policy per candidate
//
// Decision states:
//   accept  — strong distance AND clear separation from the runner-up; safe
//             to download with normal post-download validation
//   verify  — plausible but ambiguous (near-tie, medium distance, weak album
//             or conflicting year evidence); download only with strict
//             post-download validation
//   review  — weakly supported; orchestrators may hold it for review after
//             alternatives are exhausted
//   reject  — contradiction, conflict, or unusable candidate
//
// Matcher failures never throw and never fall back to weaker matching: the
// result carries decision "error" so the orchestrator fails the attempt with
// a clear diagnostic.

import { buildTrackRequest } from "./trackIdentity.js";
import { normalizeCandidate } from "./candidateNormalizer.js";
import {
  checkVariantCompatibility,
  detectNoise,
  getCoreTitle,
} from "./semanticPolicy.js";
import { getCapabilities } from "./sourceCapabilities.js";
import { runMatcherOperation } from "./beetsClient.js";
import { getNormalizedText, scoreTextMatch } from "../providers/brainzmashRanking.js";
import { logger } from "../logger.js";

const DECISION_RANK = { accept: 0, verify: 1, review: 2, reject: 3, error: 4 };
const DEFAULT_MATCH_TIMEOUT_MS = 8000;
// A strong best candidate counts as separated once it leads the runner-up by
// this much. A 0.03 vs 0.04 finish is a near-tie; 0.03 vs 0.35 is decisive.
const ACCEPT_GAP_THRESHOLD = 0.1;
// Runner-up distances above this are not "decent" competitors, so the gap to
// them says nothing about ambiguity.
const COMPETITIVE_RUNNER_UP_DISTANCE = 0.25;
// With both sides carrying a recording MBID, beets penalizes a mismatch
// heavily, but the conflict is decided here, explicitly, before scoring.
const MBID_MATCH_DISTANCE_OVERRIDE = 0;
// Base duration tolerance: a fixed 25s window, widened to 18% of the
// expected duration for longer tracks (the same gate the previous per-source
// matchers applied to advertised lengths).
const DURATION_BASE_TOLERANCE_MS = 25000;
// Coarse Node-only title floor used by the search early-exit and the
// pre-beets gate. beets makes the real call; this keeps obviously unrelated
// results from ending a search early.
const TITLE_PLAUSIBILITY_FLOOR = 40;

function isWithinBaseDurationTolerance(durationDiffMs, expectedDurationMs) {
  return (
    durationDiffMs <= DURATION_BASE_TOLERANCE_MS ||
    durationDiffMs <= Math.max(12000, expectedDurationMs * 0.18)
  );
}

// Cheap title plausibility check: does this candidate even claim to be the
// requested track? Runs on the best available title claim and the raw
// string, so "Artist - Track" file names and structured titles both pass.
function titlePlausibilityScore(request, candidate) {
  const scores = [
    scoreTextMatch(candidate.filenameTitle || candidate.title, request.trackName),
    scoreTextMatch(candidate.title, request.trackName),
    scoreTextMatch(getCoreTitle(candidate.title || ""), request.trackName),
  ];
  if (request.artistName) {
    scores.push(
      scoreTextMatch(candidate.title || "", `${request.artistName} ${request.trackName}`),
    );
  }
  return Math.max(...scores);
}

function checkTitlePlausibility(request, candidate) {
  // A matching recording MBID overrides any text gate.
  const expectedMbid = String(request.recordingMbid || "").trim();
  const candidateMbid = String(candidate.recordingMbid || "").trim();
  if (expectedMbid && candidateMbid && expectedMbid.toLowerCase() === candidateMbid.toLowerCase()) {
    return { plausible: true };
  }
  const score = titlePlausibilityScore(request, candidate);
  return { plausible: score >= TITLE_PLAUSIBILITY_FLOOR, score };
}

export const MATCHER_UNAVAILABLE_MESSAGE =
  "Track matcher (bundled beets runtime) is unavailable. Verify the Aurral image installation; matching cannot fall back to a weaker algorithm.";

export function recommendationFromDistance(distance, thresholds) {
  if (!Number.isFinite(distance)) return "none";
  if (distance < thresholds.strongRecThresh) return "strong";
  if (distance <= thresholds.mediumRecThresh) return "medium";
  return "low";
}

function proposalRecommendation(sortedDistances, thresholds) {
  if (sortedDistances.length === 0) return "none";
  const best = sortedDistances[0];
  if (best < thresholds.strongRecThresh) return "strong";
  if (best <= thresholds.mediumRecThresh) return "medium";
  if (
    sortedDistances.length === 1 ||
    sortedDistances[1] - best >= thresholds.recGapThresh
  ) {
    return "low";
  }
  return "none";
}

function checkRecordingMbid(request, candidate) {
  const expected = String(request.recordingMbid || "").trim() || null;
  const actual = String(candidate.recordingMbid || "").trim() || null;
  if (!expected || !actual) return { conflict: false, match: false };
  const conflict = expected.toLowerCase() !== actual.toLowerCase();
  return { conflict, match: !conflict };
}

// A sibling track from the same release whose title beats the requested one
// in the candidate's own title means the candidate is probably that other
// track (e.g. "01 Hole in the Sheet" vs requested "Hole in the Sheet" when
// the folder holds both).
function checkSiblingTrackConflict(request, candidate) {
  const titles = Array.isArray(request.albumTrackTitles)
    ? request.albumTrackTitles
    : [];
  if (titles.length === 0) return { conflict: false, bestOther: 0 };
  const candidateText = candidate.filenameTitle || candidate.title || "";
  const targetKey = getNormalizedText(getCoreTitle(request.trackName));
  const bestOther = titles
    .filter((title) => getNormalizedText(getCoreTitle(title)) !== targetKey)
    .reduce((best, title) => Math.max(best, scoreTextMatch(candidateText, title)), 0);
  const ownScore = scoreTextMatch(candidateText, request.trackName);
  return {
    conflict: bestOther >= 90 && bestOther >= ownScore + 25,
    nearConflict: bestOther >= 82 && bestOther >= ownScore + 15,
    bestOther,
    ownScore,
  };
}

function checkTrackNumberMismatch(request, candidate) {
  const expected = Number(request.trackNumber);
  if (!Number.isFinite(expected) || expected <= 0) return false;
  const actual = Number(candidate.trackNumber);
  return (
    Number.isFinite(actual) &&
    actual > 0 &&
    expected !== actual
  );
}

function albumEvidence(request, candidate) {
  if (!request.albumName || !candidate.album) return null;
  return scoreTextMatch(candidate.album, request.albumName, { extended: true });
}

function yearEvidence(request, candidate, folderEvidence = null) {
  const expected = request.releaseYear ? String(request.releaseYear) : null;
  if (!expected) return { conflicting: false, matched: false };
  const years = new Set();
  if (candidate.year) years.add(String(candidate.year));
  if (Array.isArray(folderEvidence?.years)) {
    for (const year of folderEvidence.years) years.add(String(year));
  }
  if (years.size === 0) return { conflicting: false, matched: false };
  return {
    conflicting: !years.has(expected),
    matched: years.has(expected),
  };
}

function compareEvaluations(left, right) {
  const rankDiff = DECISION_RANK[left.decision] - DECISION_RANK[right.decision];
  if (rankDiff !== 0) return rankDiff;
  if (left.decision === "reject" || left.decision === "error") return 0;
  const distanceDiff = (left.distance ?? Infinity) - (right.distance ?? Infinity);
  if (distanceDiff !== 0) return distanceDiff;
  return (right.variantScore ?? 0) - (left.variantScore ?? 0);
}

function normalizeSourceCandidates(source, candidates, capabilities, request) {
  const normalized = [];
  const knownArtistNames = [request.artistName, ...(request.artistAliases || [])].filter(
    Boolean,
  );
  for (const entry of candidates) {
    const candidate = entry?.source
      ? entry
      : normalizeCandidate(source, entry, {
          capabilities,
          parseFilename: Boolean(capabilities.filename && !entry?.title),
          knownArtistNames,
        });
    if (candidate) normalized.push(candidate);
  }
  return normalized;
}

export function prefilterCandidates({ request, source, candidates = [] } = {}) {
  const trackRequest = request || buildTrackRequest({});
  const capabilities = getCapabilities(source);
  const normalized = normalizeSourceCandidates(source, candidates, capabilities, trackRequest);
  return normalized.map((candidate, index) => {
    const base = { candidateIndex: index, candidate };
    if (candidate.provider?.locked) {
      return { ...base, rejected: true, reason: "locked" };
    }
    const mbid = checkRecordingMbid(trackRequest, candidate);
    if (mbid.conflict) {
      return {
        ...base,
        rejected: true,
        reason: "recording-mbid-conflict",
        contradictions: ["recording-mbid-conflict"],
      };
    }
    const variantCheck = checkVariantCompatibility(trackRequest, candidate);
    if (variantCheck.contradictions.length > 0) {
      return {
        ...base,
        rejected: true,
        reason: "contradiction",
        contradictions: variantCheck.contradictions,
        variantScore: variantCheck.variantScore,
      };
    }
    const plausibility = checkTitlePlausibility(trackRequest, candidate);
    if (!plausibility.plausible) {
      return { ...base, rejected: true, reason: "weak-title-match" };
    }
    const noise = detectNoise([candidate.title, candidate.filename].filter(Boolean).join(" "));
    if (noise.length > 0) {
      return { ...base, rejected: true, reason: "noise", noise };
    }
    return { ...base, rejected: false, noise, variantScore: variantCheck.variantScore, mbidMatch: mbid.match };
  });
}

function buildRejectEvaluation(candidate, index, reason, details = {}) {
  return {
    candidateIndex: index,
    candidate,
    decision: "reject",
    reason,
    contradictions: details.contradictions || [],
    noise: details.noise || [],
    reasons: details.reasons || [],
    ...details,
  };
}

export async function evaluateTrackCandidates({
  request,
  context,
  source,
  candidates = [],
  options = {},
  providerEvidence = null,
} = {}) {
  const trackRequest = request || buildTrackRequest(context);
  if (!trackRequest.trackName) {
    throw new Error("evaluateTrackCandidates requires a trackName");
  }
  const timeoutMs = options.timeoutMs || DEFAULT_MATCH_TIMEOUT_MS;
  const capabilities = getCapabilities(source);

  const normalized = normalizeSourceCandidates(source, candidates, capabilities, trackRequest);
  const readProviderEvidence = (candidate, index) =>
    typeof providerEvidence === "function"
      ? providerEvidence(candidate, index)
      : (providerEvidence && providerEvidence[index]) || null;

  const evaluations = [];
  const rankableCandidates = [];
  const rankableIndexes = [];
  const rankableMbidMatches = [];
  const rankableSibling = [];

  normalized.forEach((candidate, index) => {
    const evidence = readProviderEvidence(candidate, index) || {};
    if (candidate.provider?.locked) {
      evaluations.push(
        buildRejectEvaluation(candidate, index, "locked", {
          reasons: ["candidate is locked on the provider"],
        }),
      );
      return;
    }
    // Provider artist evidence: a filename that confidently names a
    // different artist (with no folder to vouch for it) is a contradiction.
    if (evidence.folder?.artistContradicted || evidence.folder?.ambiguousTitleAlbumArtist) {
      evaluations.push(
        buildRejectEvaluation(candidate, index, evidence.folder.artistContradicted ? "artist-mismatch" : "ambiguous-title-album-artist", {
          contradictions: [evidence.folder.artistContradicted ? "artist-mismatch" : "ambiguous-title-album-artist"],
          reasons: evidence.folder.artistContradicted
            ? [`filename names a different artist (${evidence.folder.filenameArtist})`]
            : ["same-titled single offered by a folder that names no requested artist"],
        }),
      );
      return;
    }
    // Semantic contradictions are the identity statement — check them before
    // mechanical gates so rejection reasons stay informative.
    const variantCheck = checkVariantCompatibility(trackRequest, candidate);
    if (variantCheck.contradictions.length > 0) {
      evaluations.push(
        buildRejectEvaluation(candidate, index, "contradiction", {
          contradictions: variantCheck.contradictions,
          variantScore: variantCheck.variantScore,
          reasons: variantCheck.contradictions.map(
            (label) => `semantic contradiction: ${label}`,
          ),
        }),
      );
      return;
    }
    const plausibility = checkTitlePlausibility(trackRequest, candidate);
    if (!plausibility.plausible) {
      evaluations.push(
        buildRejectEvaluation(candidate, index, "weak-title-match", {
          reasons: [
            `candidate title does not plausibly name the requested track (score ${plausibility.score})`,
          ],
        }),
      );
      return;
    }
    // Advertised-duration gate (Aurral policy): when the provider states a
    // length and it sits outside the base tolerance window, the file is a
    // different version — beets' soft duration penalty is not the place to
    // enforce this hard boundary.
    const expectedDurationMs = Number(trackRequest.durationMs || 0);
    const advertisedDurationMs = Number(evidence.advertisedDurationMs ?? candidate.durationMs ?? 0);
    if (
      expectedDurationMs > 0 &&
      advertisedDurationMs > 0 &&
      !isWithinBaseDurationTolerance(Math.abs(advertisedDurationMs - expectedDurationMs), expectedDurationMs)
    ) {
      evaluations.push(
        buildRejectEvaluation(candidate, index, "advertised-duration-mismatch", {
          reasons: [
            `advertised duration ${advertisedDurationMs}ms is outside tolerance for ${expectedDurationMs}ms`,
          ],
        }),
      );
      return;
    }
    const mbid = checkRecordingMbid(trackRequest, candidate);
    if (mbid.conflict) {
      evaluations.push(
        buildRejectEvaluation(candidate, index, "recording-mbid-conflict", {
          contradictions: ["recording-mbid-conflict"],
          aurralEvidence: { recordingMbid: { expected: trackRequest.recordingMbid, candidate: candidate.recordingMbid } },
          reasons: ["candidate recording MBID conflicts with the requested recording"],
        }),
      );
      return;
    }
    const noise = detectNoise([candidate.title, candidate.filename].filter(Boolean).join(" "));
    if (noise.length > 0 && !options.allowNoisyCandidates) {
      evaluations.push(
        buildRejectEvaluation(candidate, index, "noise", {
          noise,
          variantScore: variantCheck.variantScore,
          reasons: noise.map((label) => `noise: ${label}`),
        }),
      );
      return;
    }
    evaluations.push({
      candidateIndex: index,
      candidate,
      pending: true,
      variantScore: variantCheck.variantScore,
      noise,
      mbidMatch: mbid.match,
      providerEvidence: evidence,
    });
    rankableCandidates.push(candidate);
    rankableIndexes.push(index);
    rankableMbidMatches.push(mbid.match);
    rankableSibling.push(checkSiblingTrackConflict(trackRequest, candidate));
  });

  const matcherOutcome = await runMatcherOperation(
    "rank_tracks",
    {
      expected: toProtocolRequest(trackRequest),
      candidates: rankableCandidates.map(toProtocolCandidate),
    },
    { timeoutMs, pythonPath: options.pythonPath, scriptPath: options.scriptPath },
  );

  if (!matcherOutcome.ok) {
    logger.warn("matcher", "unified matcher unavailable", {
      source,
      code: matcherOutcome.error?.code,
    });
    for (const evaluation of evaluations) {
      if (evaluation.pending) {
        evaluation.decision = "error";
        evaluation.reason = matcherOutcome.error?.code || "matcher_error";
        evaluation.reasons = [MATCHER_UNAVAILABLE_MESSAGE];
        delete evaluation.pending;
      }
    }
    return {
      decision: "error",
      error: matcherOutcome.error,
      request: trackRequest,
      candidates: normalized,
      evaluations: evaluations.sort(compareEvaluations),
      summary: { decision: "error", recommendation: null, gap: null, bestCandidateIndex: null, runnerUpCandidateIndex: null },
    };
  }

  const thresholds = matcherOutcome.result?.thresholds || {
    strongRecThresh: 0.04,
    mediumRecThresh: 0.25,
    recGapThresh: 0.25,
  };
  const matchByIndex = new Map(
    (matcherOutcome.result?.matches || []).map((match) => [match.candidateIndex, match]),
  );

  rankableIndexes.forEach((candidateIndex, position) => {
    const evaluation = evaluations[candidateIndex];
    const match = matchByIndex.get(position);
    const sibling = rankableSibling[position];
    const evidence = evaluation.providerEvidence || {};
    delete evaluation.pending;
    if (!match || match.skipped) {
      evaluation.decision = "reject";
      evaluation.reason = match?.reason || "missing-title";
      return;
    }
    const distance = match.distance;
    const album = albumEvidence(trackRequest, evaluation.candidate);
    const year = yearEvidence(trackRequest, evaluation.candidate, evidence.folder);
    const mbidMatch = rankableMbidMatches[position];
    const recommendation = recommendationFromDistance(distance, thresholds);
    const reasons = [`beets distance ${distance}`, `recommendation ${recommendation}`];
    const aurralEvidence = {
      album,
      year: {
        expected: trackRequest.releaseYear || null,
        candidate: evaluation.candidate.year || null,
        ...year,
      },
      trackNumber: {
        expected: trackRequest.trackNumber || null,
        candidate: evaluation.candidate.trackNumber || null,
        mismatch: checkTrackNumberMismatch(trackRequest, evaluation.candidate),
      },
      recordingMbid: mbidMatch
        ? { match: true, mbid: evaluation.candidate.recordingMbid }
        : null,
      folder: evidence.folder || null,
    };

    // A matched recording MBID is decisive positive evidence: the provider
    // asserts the exact recording Aurral asked for.
    if (mbidMatch) {
      evaluation.decision = "accept";
      evaluation.distance = MBID_MATCH_DISTANCE_OVERRIDE;
      evaluation.recommendation = "strong";
      evaluation.reasons = [
        "recording MBID matches the requested recording",
        ...reasons,
      ];
      Object.assign(evaluation, {
        penalties: match.penalties || {},
        maxDistance: match.maxDistance,
        rawDistance: match.rawDistance,
        albumScore: album,
        aurralEvidence,
      });
      return;
    }

    let decision;
    if (recommendation === "strong") {
      decision = "accept";
      reasons.push("strong metadata match");
    } else if (recommendation === "medium") {
      decision = "verify";
      reasons.push("moderate metadata match, post-download verification required");
    } else {
      decision = "review";
      reasons.push("weak metadata evidence");
    }
    if (sibling.conflict) {
      decision = "reject";
      evaluation.reason = "sibling-track-conflict";
      reasons.push("candidate title names a sibling track from the same release");
    } else if (sibling.nearConflict && decision === "accept") {
      decision = "verify";
      reasons.push("candidate title is close to a sibling track from the same release");
    }
    // Nobody involved names the requested artist: the file may still be
    // right (sloppy rips), but it downloads under strict validation only.
    if (decision === "accept" && evidence.folder?.artistMissing) {
      decision = "verify";
      reasons.push("no source names the requested artist; downgraded accept to verify");
    }
    // Structured provider artist clearly conflicts with the request: the
    // same title sung by someone else is a different recording, not a
    // plausible version of it.
    if (
      capabilities.structuredArtist &&
      Number(match.penalties.track_artist ?? 0) >= 0.15 &&
      decision !== "reject"
    ) {
      decision = "reject";
      evaluation.reason = "artist-mismatch";
      reasons.push("provider artist conflicts with the requested artist");
    }
    // Album and year are supporting evidence for track identity: the same
    // recording legitimately appears on singles, compilations, and reissues.
    // Weak album evidence or a conflicting year downgrades an accept but
    // never upgrades anything.
    if (decision === "accept" && album != null && album < 35) {
      decision = "verify";
      reasons.push(`weak album evidence (${album}) downgraded accept to verify`);
    }
    if (decision === "accept" && year.conflicting) {
      decision = "verify";
      reasons.push("conflicting year evidence downgraded accept to verify");
    }
    // A wrong track number with a title that does not near-exactly match the
    // request means the candidate is probably a neighboring track from the
    // release. beets already penalizes the index conflict; only a
    // near-exact title rescues the candidate (it is probably the right
    // recording at the wrong position).
    const titlePenalty = Number(match.penalties?.track_title ?? 0);
    if (
      decision !== "reject" &&
      aurralEvidence.trackNumber.mismatch &&
      titlePenalty >= 0.05
    ) {
      decision = "reject";
      evaluation.reason = "track-number-mismatch";
      reasons.push("track number mismatch with imperfect title evidence");
    }

    evaluation.decision = decision;
    evaluation.distance = distance;
    evaluation.penalties = match.penalties || {};
    evaluation.maxDistance = match.maxDistance;
    evaluation.rawDistance = match.rawDistance;
    evaluation.recommendation = recommendation;
    evaluation.albumScore = album;
    evaluation.aurralEvidence = aurralEvidence;
    evaluation.reasons = reasons;
  });

  const scored = evaluations
    .filter((evaluation) => evaluation.pending !== true && Number.isFinite(evaluation.distance))
    .sort((left, right) => left.distance - right.distance);
  const gap = matcherOutcome.result?.gap ?? null;
  const proposal = proposalRecommendation(
    scored.map((evaluation) => evaluation.distance),
    thresholds,
  );

  // Best-vs-runner-up separation is mandatory for acceptance: a strong best
  // candidate that barely beats a competitive runner-up is a near-tie, and
  // near-ties download under strict validation instead of acceptance. An
  // exact tie (gap 0) is a duplicated upload of the same recording — the
  // absolute distance decides there, not the separation.
  const best = scored[0] || null;
  const runnerUp = scored[1] || null;
  const isNearTie =
    best &&
    runnerUp &&
    best.decision === "accept" &&
    gap != null &&
    gap > 0 &&
    gap < ACCEPT_GAP_THRESHOLD &&
    runnerUp.distance <= COMPETITIVE_RUNNER_UP_DISTANCE;
  if (isNearTie) {
    best.decision = "verify";
    best.reasons.push(
      `near-tie with runner-up (gap ${gap}) downgraded accept to verify`,
    );
  }

  const orderedEvaluations = evaluations.sort(compareEvaluations);
  const rankableBest = best
    ? orderedEvaluations.find((evaluation) => evaluation === best) || null
    : null;
  const summary = {
    decision: rankableBest?.decision || "reject",
    recommendation: proposal,
    gap,
    thresholds,
    bestCandidateIndex: rankableBest?.candidateIndex ?? null,
    runnerUpCandidateIndex: runnerUp?.candidateIndex ?? null,
  };

  logger.debug("matcher", "candidate evaluation complete", {
    source,
    candidateCount: normalized.length,
    decision: summary.decision,
    recommendation: summary.recommendation,
    bestDistance: best?.distance ?? null,
    gap,
    contradictions: orderedEvaluations.flatMap(
      (evaluation) => evaluation.contradictions || [],
    ),
  });

  return {
    decision: summary.decision,
    recommendation: proposal,
    gap,
    thresholds,
    request: trackRequest,
    candidates: normalized,
    evaluations: orderedEvaluations,
    summary,
  };
}

export function toProtocolRequest(request) {
  return {
    artistName: request.artistName || null,
    artistAliases: request.artistAliases || [],
    // Variant descriptors are judged by the semantic policy; identity scoring
    // compares core titles so "(Live at Wembley)" vs "(Live)" still matches.
    trackName: getCoreTitle(request.trackName),
    albumName: request.albumName || null,
    releaseYear: request.releaseYear || null,
    trackNumber: request.trackNumber || null,
    discNumber: request.discNumber || null,
    durationMs: request.durationMs || null,
    recordingMbid: request.recordingMbid || null,
  };
}

function toProtocolCandidate(candidate) {
  const scoringTitle = candidate.filenameTitle || candidate.cleanedTitle || candidate.title;
  return {
    source: candidate.source || null,
    title: getCoreTitle(scoringTitle),
    artists: candidate.artists?.length ? candidate.artists : undefined,
    artist: candidate.artists?.[0],
    album: candidate.album || undefined,
    durationMs: candidate.durationMs || undefined,
    year: candidate.year || undefined,
    trackNumber: candidate.trackNumber || undefined,
    discNumber: candidate.discNumber || undefined,
    recordingMbid: candidate.recordingMbid || undefined,
  };
}

// Decision engine: turns normalized candidates into explicit, explainable
// pre-download decisions.
//
// Division of labor: beets computes the music-record distance (title, artist,
// duration, track index, recording MBID); Aurral owns every final decision —
// semantic contradictions, identifier conflicts, sibling-track conflicts,
// album/year evidence, best-vs-runner-up separation, and the accept/verify/
// review/reject mapping. No private beets internals are involved: the
// recommendation policy below is derived from the public distance plus the
// thresholds owned by the shared identity evaluator.
//
// Pipeline:
//   canonical request
//     → Aurral pre-filter (contradictions, MBID conflicts, noise: no Python)
//     → one beets track_distance call for all survivors
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
import { getCapabilities, normalizeCandidate } from "./candidateNormalizer.js";
import { getCoreTitle } from "./semanticPolicy.js";
import { runMatcherOperation } from "./beetsClient.js";
import { getNormalizedText } from "../providers/brainzmashRanking.js";
import {
  DEFAULT_MATCH_THRESHOLDS,
  MATCHER_UNAVAILABLE_MESSAGE,
  evaluateTrackIdentity,
} from "./identityPolicy.js";
import { logger } from "../logger.js";

const DECISION_RANK = { accept: 0, verify: 1, review: 2, reject: 3, error: 4 };
const DEFAULT_MATCH_TIMEOUT_MS = 8000;
// A strong best candidate counts as separated once it leads the runner-up by
// this much. A 0.03 vs 0.04 finish is a near-tie; 0.03 vs 0.35 is decisive.
const ACCEPT_GAP_THRESHOLD = 0.1;
// Runner-up distances above this are not "decent" competitors, so the gap to
// them says nothing about ambiguity.
const COMPETITIVE_RUNNER_UP_DISTANCE = 0.25;
// A semantic duplicate of the best candidate: same normalized core title,
// same primary artist, same duration to the second. Only true duplicates
// share a key — they neither create nor relieve runner-up ambiguity.
function semanticIdentityKey(evaluation) {
  const candidate = evaluation.candidate || {};
  return [
    getNormalizedText(
      getCoreTitle(candidate.filenameTitle || candidate.cleanedTitle || candidate.title || ""),
    ),
    getNormalizedText(candidate.artists?.[0] || ""),
    candidate.durationMs != null && Number.isFinite(Number(candidate.durationMs))
      ? Math.round(Number(candidate.durationMs) / 1000)
      : "unknown",
  ].join("\0");
}

function round6(value) {
  return Number.isFinite(value) ? Math.round(value * 1e6) / 1e6 : null;
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
    const policy = evaluateTrackIdentity({
      request: trackRequest,
      candidate,
      source,
      phase: "prefilter",
    });
    if (policy.rejected) {
      return {
        ...base,
        rejected: true,
        reason: policy.reason,
        contradictions: policy.contradictions,
        noise: policy.noise,
        reasons: policy.reasons,
      };
    }
    return {
      ...base,
      rejected: false,
      noise: policy.noise,
      variantScore: policy.variant.variantScore,
      mbidMatch: policy.identifier.match,
    };
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

  normalized.forEach((candidate, index) => {
    const evidence = readProviderEvidence(candidate, index) || {};
    const policy = evaluateTrackIdentity({
      request: trackRequest,
      candidate,
      source,
      providerEvidence: evidence,
      phase: "pre",
      allowNoisyCandidates: options.allowNoisyCandidates === true,
    });
    if (policy.rejected) {
      evaluations.push(
        buildRejectEvaluation(candidate, index, policy.reason, {
          contradictions: policy.contradictions,
          noise: policy.noise,
          variantScore: policy.variant.variantScore,
          reasons: policy.reasons,
        }),
      );
      return;
    }
    evaluations.push({
      candidateIndex: index,
      candidate,
      pending: true,
      variantScore: policy.variant.variantScore,
      noise: policy.noise,
      mbidMatch: policy.identifier.match,
      providerEvidence: evidence,
    });
    rankableCandidates.push(candidate);
    rankableIndexes.push(index);
  });

  const matcherOutcome = await runMatcherOperation(
    "track_distance",
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

  const thresholds = matcherOutcome.result?.thresholds || DEFAULT_MATCH_THRESHOLDS;
  const matchByIndex = new Map(
    (matcherOutcome.result?.matches || []).map((match) => [match.candidateIndex, match]),
  );

  rankableIndexes.forEach((candidateIndex, position) => {
    const evaluation = evaluations[candidateIndex];
    const match = matchByIndex.get(position);
    const evidence = evaluation.providerEvidence || {};
    delete evaluation.pending;
    if (!match || match.skipped) {
      evaluation.decision = "reject";
      evaluation.reason = match?.reason || "missing-title";
      return;
    }
    const policy = evaluateTrackIdentity({
      request: trackRequest,
      candidate: evaluation.candidate,
      source,
      providerEvidence: evidence,
      match,
      thresholds,
      phase: "pre",
      allowNoisyCandidates: options.allowNoisyCandidates === true,
    });
    Object.assign(evaluation, {
      decision: policy.decision,
      reason: policy.reason,
      contradictions: policy.contradictions,
      noise: policy.noise,
      distance: policy.distance,
      penalties: policy.penalties,
      maxDistance: policy.maxDistance,
      rawDistance: policy.rawDistance,
      recommendation: policy.recommendation,
      albumScore: policy.aurralEvidence.album,
      aurralEvidence: {
        ...policy.aurralEvidence,
        year: {
          expected: trackRequest.releaseYear || null,
          ...policy.aurralEvidence.year,
        },
      },
      reasons: policy.reasons,
    });
  });

  const scored = evaluations
    .filter((evaluation) => evaluation.pending !== true && Number.isFinite(evaluation.distance))
    .sort((left, right) => left.distance - right.distance);
  const proposal = proposalRecommendation(
    scored.map((evaluation) => evaluation.distance),
    thresholds,
  );

  // Best-vs-runner-up separation is mandatory for acceptance. The runner-up
  // that matters is the first one that is NOT a semantic duplicate of the
  // best (same normalized title, artist, and duration): duplicated uploads of
  // the same recording neither create ambiguity nor rescue it. An exact tie
  // between distinct identities must therefore never bypass the check — only
  // a true duplicate absence does.
  const best = scored[0] || null;
  const bestKey = best ? semanticIdentityKey(best) : null;
  let runnerUp = null;
  for (let index = 1; index < scored.length; index += 1) {
    if (semanticIdentityKey(scored[index]) === bestKey) {
      scored[index].duplicateOfBest = true;
      continue;
    }
    runnerUp = scored[index];
    break;
  }
  const gap =
    best && runnerUp ? round6(runnerUp.distance - best.distance) : null;
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

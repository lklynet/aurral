// Source-search integration glue.
//
// Every download source routes its raw search results through here:
//   raw results → provider adapter (evidence + canonical candidates)
//     → semantic pre-filter
//     → native release and recording decisions
//     → per-candidate decisions
//
// `hasUsableSearchCandidates` is the cheap early-exit used while queries are
// still running. `buildSourceCandidates` evaluates the complete search pool.

import { buildTrackRequest, type SearchTrackRequest } from "./trackIdentity.ts";
import {
  prefilterCandidates,
  evaluateTrackCandidates,
  type CandidateEvaluation,
  type SearchResult,
  type TrackEvaluation,
} from "./decisionEngine.ts";
import { buildSoulseekCandidates } from "./providers/soulseekProvider.ts";

export async function buildSourceCandidates({
  source,
  results,
  candidates,
  request,
  context,
  options = {},
}: {
  source?: string;
  results?: SearchResult[];
  candidates?: SearchResult[];
  request?: SearchTrackRequest;
  context?: Parameters<typeof buildTrackRequest>[0];
  options?: Parameters<typeof buildSoulseekCandidates>[2];
} = {}) {
  const trackRequest = request || buildTrackRequest(context);
  const rawResults = results ?? candidates ?? [];
  if (source === "soulseek") {
    const built = buildSoulseekCandidates(rawResults, trackRequest, options);
    return evaluateTrackCandidates({
      request: trackRequest,
      source,
      candidates: built.candidates,
      providerEvidence: built.providerEvidence,
    });
  }
  return evaluateTrackCandidates({
    request: trackRequest,
    source,
    candidates: rawResults,
  });
}

// Node-only pre-filter used for early-exit checks while searches run.
// Applies the same contradictions, identifier conflicts, noise, and lock
// gates as the full evaluation so early exits agree with final decisions.
export function hasUsableSearchCandidates({
  source,
  results = [],
  request,
  context,
}: {
  source?: string;
  results?: SearchResult[];
  request?: SearchTrackRequest;
  context?: Parameters<typeof buildTrackRequest>[0];
} = {}) {
  const trackRequest = request || buildTrackRequest(context);
  if (!trackRequest.trackName) return false;
  return prefilterCandidates({ request: trackRequest, source, candidates: results }).some(
    (entry) => !entry.rejected,
  );
}

// Payload shape the download orchestrators carry between phases.
export function toPipelineCandidate(evaluation: CandidateEvaluation) {
  return {
    raw: evaluation.candidate.raw,
    candidate: evaluation.candidate,
    resolvedAlbumName: evaluation.candidate.album || null,
    evaluation: {
      decision: evaluation.decision,
      distance: evaluation.distance ?? null,
      recommendation: evaluation.recommendation || null,
      gap: null,
      reasons: evaluation.reasons || [],
      penalties: {},
      aurralEvidence: evaluation.aurralEvidence || null,
      contradictions: evaluation.contradictions || [],
    },
  };
}

// Candidates the orchestrator may attempt, in decision order.
export function usableEvaluationEntries(evaluation: TrackEvaluation | null | undefined) {
  // Review-tier candidates are usable as a last resort: the orchestrator
  // tries them after every accept/verify candidate, under strict
  // post-download validation, before failing the source.
  return (evaluation?.evaluations || []).filter((entry) =>
    ["accept", "verify", "review"].includes(entry.decision),
  );
}

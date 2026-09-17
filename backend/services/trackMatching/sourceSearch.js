// Source-search integration glue.
//
// Every download source routes its raw search results through here:
//   raw results → provider adapter (evidence + canonical candidates)
//     → semantic pre-filter (Node-only, no Python)
//     → ONE beets rank_tracks call for the whole result set
//     → per-candidate decisions
//
// `hasUsableSearchCandidates` is the cheap Node-only early-exit used while
// queries are still running; it never spawns Python. `buildSourceCandidates`
// performs the single full evaluation once the search pool is complete.

import { buildTrackRequest } from "./trackIdentity.js";
import { prefilterCandidates, evaluateTrackCandidates } from "./decisionEngine.js";
import { getCapabilities } from "./sourceCapabilities.js";
import { normalizeCandidate } from "./candidateNormalizer.js";
import { buildSoulseekCandidates } from "./providers/soulseekProvider.js";
import { logger } from "../logger.js";

function soulseekOptions(options = {}) {
  return {
    isUserBlacklisted:
      typeof options.isUserBlacklisted === "function" ? options.isUserBlacklisted : () => false,
    getUserQueuePenalty:
      typeof options.getUserQueuePenalty === "function" ? options.getUserQueuePenalty : () => 0,
  };
}

export async function buildSourceCandidates({
  source,
  results,
  candidates,
  request,
  context,
  options = {},
} = {}) {
  const trackRequest = request || buildTrackRequest(context);
  const rawResults = results ?? candidates ?? [];
  if (source === "soulseek") {
    const built = buildSoulseekCandidates(rawResults, trackRequest, soulseekOptions(options));
    return evaluateTrackCandidates({
      request: trackRequest,
      source,
      candidates: built.candidates,
      options,
      providerEvidence: built.providerEvidence,
    });
  }
  return evaluateTrackCandidates({
    request: trackRequest,
    source,
    candidates: rawResults,
    options,
  });
}

// Node-only pre-filter used for early-exit checks while searches run.
// Applies the same contradictions, identifier conflicts, noise, and lock
// gates as the full evaluation so early exits agree with final decisions.
export function hasUsableSearchCandidates({ source, results = [], request, context } = {}) {
  const trackRequest = request || buildTrackRequest(context);
  if (!trackRequest.trackName) return false;
  const capabilities = getCapabilities(source);
  const usable = results.some((entry) => {
    const candidate = entry?.source
      ? entry
      : normalizeCandidate(source, entry, {
          capabilities,
          parseFilename: Boolean(capabilities.filename && !entry?.title),
          knownArtistNames: [trackRequest.artistName, ...(trackRequest.artistAliases || [])].filter(
            Boolean,
          ),
        });
    if (!candidate) return false;
    const prefiltered = prefilterCandidates({
      request: trackRequest,
      source,
      candidates: [candidate],
    })[0];
    return prefiltered ? !prefiltered.rejected : false;
  });
  return usable;
}

// Payload shape the download orchestrators carry between phases.
export function toPipelineCandidate(evaluation) {
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
      penalties: evaluation.penalties || {},
      aurralEvidence: evaluation.aurralEvidence || null,
      contradictions: evaluation.contradictions || [],
    },
  };
}

// Candidates the orchestrator may attempt, in decision order.
export function usableEvaluationEntries(evaluation) {
  // Review-tier candidates are usable as a last resort: the orchestrator
  // tries them after every accept/verify candidate, under strict
  // post-download validation, before failing the source.
  return (evaluation?.evaluations || []).filter((entry) =>
    ["accept", "verify", "review"].includes(entry.decision),
  );
}

export function logSearchOutcome(source, evaluation, details = {}) {
  logger.debug("matcher", "search ranking complete", {
    source,
    stage: "pre-download",
    decision: evaluation?.decision,
    recommendation: evaluation?.recommendation,
    candidateCount: evaluation?.candidates?.length ?? 0,
    bestDistance: evaluation?.evaluations?.find((entry) => Number.isFinite(entry.distance))
      ?.distance ?? null,
    gap: evaluation?.gap ?? null,
    ...details,
  });
}

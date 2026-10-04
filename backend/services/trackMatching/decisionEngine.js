import { buildTrackRequest } from "./trackIdentity.js";
import { getCapabilities, normalizeCandidate } from "./candidateNormalizer.js";
import {
  decideRecording,
  isSameAlbumTitle,
  isSiblingTrackPosition,
  MATCH_POLICY,
  normalizeMatchText,
  parseListingTitle,
} from "./nativeMatcher.js";

const DECISION_RANK = { accept: 0, verify: 1, review: 2, reject: 3 };

function normalizeSourceCandidates(source, candidates, request) {
  const capabilities = getCapabilities(source);
  const knownArtistNames = [request.artistName, ...(request.artistAliases || [])].filter(Boolean);
  return candidates.map((entry) => entry?.source ? entry : normalizeCandidate(source, entry, {
    capabilities,
    parseFilename: Boolean(capabilities.filename && !entry?.title),
    knownArtistNames,
  })).filter(Boolean);
}

function matcherRequest(request) {
  return {
    title: request.trackName,
    artists: request.artistName ? [request.artistName] : [],
    artistAliases: request.artistAliases || [],
    durationMs: request.durationMs,
    recordingMbid: request.recordingMbid,
  };
}

function matcherCandidate(candidate, request, evidence) {
  const parsed = candidate.path ? parseListingTitle(candidate.path) : null;
  const uploaderIsArtist = candidate.source === "ytdlp" && request.artistName
    && normalizeMatchText(candidate.provider?.uploader) === normalizeMatchText(request.artistName);
  return {
    title: candidate.filenameTitle || parsed?.title || candidate.cleanedTitle || candidate.title,
    artists: candidate.artists?.length ? candidate.artists
      : evidence?.folder?.artistScore >= 92 || uploaderIsArtist
        ? [request.artistName].filter(Boolean) : [],
    durationMs: candidate.durationMs,
    recordingMbid: candidate.recordingMbid,
  };
}

function evaluate(request, normalized, providerEvidence) {
  const evidenceFor = (candidate, index) => typeof providerEvidence === "function"
    ? providerEvidence(candidate, index) : providerEvidence?.[index] || null;
  const assessed = decideRecording(matcherRequest(request), normalized.map((candidate, index) =>
    matcherCandidate(candidate, request, evidenceFor(candidate, index))));
  const evaluations = assessed.candidates.map((match, index) => {
    const candidate = normalized[index];
    const evidence = evidenceFor(candidate, index);
    const locked = candidate.provider?.locked === true;
    const expectedTrackNumber = Number(request.trackNumber || 0);
    const actualTrackNumber = Number(candidate.trackNumber || 0);
    const trackNumberMismatch = expectedTrackNumber > 0 && actualTrackNumber > 0
      && expectedTrackNumber !== actualTrackNumber;
    const fromRequestedAlbum = evidence?.folder
      ? evidence.folder.albumScore >= 92
      : isSameAlbumTitle(request.albumName, candidate.album);
    const siblingConflict = fromRequestedAlbum && isSiblingTrackPosition({
      title: request.trackName,
      trackNumber: request.trackNumber,
      albumTrackTitles: request.albumTrackTitles,
    }, actualTrackNumber);
    const contradiction = match.contradictions.length > 0
      || evidence?.folder?.artistContradicted === true
      || evidence?.folder?.ambiguousTitleAlbumArtist === true
      || siblingConflict;
    const strongFolder = evidence?.folder?.artistScore >= 92
      && evidence?.folder?.albumScore >= 92
      && match.titleSimilarity === 1;
    const decision = locked || contradiction || match.titleSimilarity < MATCH_POLICY.minTitleSimilarity
      ? "reject"
      : assessed.selectedIndex === index && !evidence?.folder?.yearConflicting
        ? "accept"
        : match.score >= MATCH_POLICY.selectableScore && match.evidence.length >= 2 || strongFolder
          ? "verify" : "review";
    return {
      candidateIndex: index,
      candidate,
      decision,
      reason: locked ? "locked" : contradiction ? "contradiction" : null,
      reasons: [...match.contradictions,
        ...(!candidate.artists?.length && !evidence?.folder?.artistScore ? ["requested artist missing"] : [])],
      contradictions: [...match.contradictions,
        ...(evidence?.folder?.artistContradicted ? ["artist"] : []),
        ...(evidence?.folder?.ambiguousTitleAlbumArtist ? ["ambiguous-artist"] : []),
        ...(siblingConflict ? ["sibling-track-index"] : [])],
      distance: 1 - match.score,
      rawDistance: 1 - match.score,
      recommendation: decision === "accept" ? "strong" : decision === "verify" ? "medium" : "none",
      aurralEvidence: {
        recordingMbid: match.evidence.includes("recording-mbid") ? true : null,
        duration: match.durationGapMs == null ? null : { diffMs: match.durationGapMs },
        folder: evidence?.folder || null,
        year: evidence?.folder?.yearConflicting == null ? null
          : { conflicting: evidence.folder.yearConflicting },
        trackNumber: { mismatch: trackNumberMismatch },
      },
      folderScore: Number(evidence?.folder?.tracklistScore || 0)
        + Number(evidence?.folder?.albumScore || 0) / 10,
      policyVersion: MATCH_POLICY.version,
    };
  }).sort((left, right) => DECISION_RANK[left.decision] - DECISION_RANK[right.decision]
    || left.distance - right.distance || right.folderScore - left.folderScore
    || left.candidateIndex - right.candidateIndex);
  const best = evaluations[0] || null;
  return {
    decision: best?.decision || "reject",
    recommendation: best?.recommendation || "none",
    gap: null,
    thresholds: MATCH_POLICY,
    request,
    candidates: normalized,
    evaluations,
    policyVersion: MATCH_POLICY.version,
    summary: {
      decision: best?.decision || "reject",
      recommendation: best?.recommendation || "none",
      gap: null,
      thresholds: MATCH_POLICY,
      bestCandidateIndex: best?.candidateIndex ?? null,
      runnerUpCandidateIndex: evaluations[1]?.candidateIndex ?? null,
    },
  };
}

export function prefilterCandidates({ request, source, candidates = [] } = {}) {
  const trackRequest = request || buildTrackRequest({});
  const normalized = normalizeSourceCandidates(source, candidates, trackRequest);
  const assessment = decideRecording(matcherRequest(trackRequest), normalized.map((candidate) =>
    matcherCandidate(candidate, trackRequest, null)));
  return normalized.map((candidate, index) => {
    const contradictions = assessment.candidates[index].contradictions;
    const rejected = candidate.provider?.locked === true || contradictions.length > 0
      || assessment.candidates[index].titleSimilarity < MATCH_POLICY.minTitleSimilarity;
    return {
      candidateIndex: index,
      candidate,
      rejected,
      reason: rejected ? candidate.provider?.locked ? "locked" : "contradiction" : null,
      contradictions,
      reasons: contradictions,
    };
  });
}

export async function evaluateTrackCandidates({ request, context, source, candidates = [], providerEvidence = null } = {}) {
  const trackRequest = request || buildTrackRequest(context);
  if (!trackRequest.trackName) throw new Error("evaluateTrackCandidates requires a trackName");
  return evaluate(trackRequest, normalizeSourceCandidates(source, candidates, trackRequest), providerEvidence);
}

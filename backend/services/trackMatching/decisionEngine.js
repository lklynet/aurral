import { buildTrackRequest, recordingRequest } from "./trackIdentity.js";
import { getCapabilities, normalizeCandidate } from "./candidateNormalizer.js";
import {
  decideRecording,
  isSameAlbumTitle,
  isSiblingTrackPosition,
  MATCH_POLICY,
  parseListingTitle,
} from "./nativeMatcher.js";
import { isRequestedYoutubeAlbum, parseYoutubeTitle, readYoutubeUpload } from "./youtubeEvidence.js";

const DECISION_RANK = { accept: 0, verify: 1, review: 2, reject: 3 };

// A YouTube Music song names its artists, album, and length the way a store
// does, unlike a video, whose artist and title have to be read from its title.
function isYoutubeSong(candidate) {
  return candidate.source === "ytdlp" && candidate.raw?.song === true;
}

function normalizeSourceCandidates(source, candidates, request) {
  const capabilities = getCapabilities(source);
  const knownArtistNames = [request.artistName, ...(request.artistAliases || [])].filter(Boolean);
  return candidates.map((entry) => entry?.source ? entry : normalizeCandidate(source, entry, {
    capabilities: entry?.song === true ? { ...capabilities, structuredArtist: true } : capabilities,
    parseFilename: Boolean(capabilities.filename && !entry?.title),
    knownArtistNames,
  })).filter(Boolean);
}

function requestArtistNames(request) {
  return [request.artistName, ...(request.artistAliases || [])].filter(Boolean);
}

function youtubeMatcherCandidate(candidate, request) {
  const names = requestArtistNames(request);
  const claim = parseYoutubeTitle(candidate.title, names, request.trackName);
  const upload = readYoutubeUpload(candidate.title, candidate.provider?.uploader, names);
  return {
    ...candidate,
    title: claim.title,
    versionTitle: claim.versionTitle,
    artists: [claim.artist, upload.channelArtist].filter(Boolean),
    durationMs: candidate.durationMs,
    recordingMbid: candidate.recordingMbid,
  };
}

function matcherCandidate(candidate, request, evidence) {
  if (candidate.source === "ytdlp" && !isYoutubeSong(candidate)) return youtubeMatcherCandidate(candidate, request);
  const parsed = candidate.path ? parseListingTitle(candidate.path) : null;
  return {
    ...candidate,
    title: candidate.filenameTitle || parsed?.title || candidate.cleanedTitle || candidate.title,
    artists: candidate.artists?.length ? candidate.artists
      : evidence?.folder?.artistScore >= 92 ? [request.artistName].filter(Boolean) : [],
    durationMs: candidate.durationMs,
    recordingMbid: candidate.recordingMbid,
  };
}

function isOfficialYoutubeAudio(candidate, request) {
  return candidate.source === "ytdlp"
    && readYoutubeUpload(candidate.title, candidate.provider?.uploader, requestArtistNames(request)).officialAudio;
}

function evaluate(request, normalized, providerEvidence) {
  const evidenceFor = (candidate, index) => typeof providerEvidence === "function"
    ? providerEvidence(candidate, index) : providerEvidence?.[index] || null;
  const assessed = decideRecording(recordingRequest(request), normalized.map((candidate, index) =>
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
    }, actualTrackNumber, candidate.discNumber);
    const contradiction = match.contradictions.length > 0
      || evidence?.folder?.artistContradicted === true
      || evidence?.folder?.ambiguousTitleAlbumArtist === true
      || siblingConflict;
    const strongFolder = evidence?.folder?.artistScore >= 92
      && evidence?.folder?.albumScore >= 92
      && match.titleSimilarity === 1;
    // A song with the requested artist, title, and length is the recording.
    // On the requested album it leaves nothing to choose between, even
    // beside another copy of it. On another album it may be another mix or
    // a live take with the same title, so it is checked after download like
    // any upload. Any other song must be on the requested album.
    const song = isYoutubeSong(candidate);
    const songOnRequestedAlbum = song && isRequestedYoutubeAlbum(request, candidate.album);
    const exactSong = song && match.contradictions.length === 0 && match.titleSimilarity === 1
      && match.artistSimilarity >= MATCH_POLICY.minArtistSimilarity
      && match.durationGapMs != null && match.durationGapMs <= MATCH_POLICY.selectedDurationGapMs;
    const songOffAlbum = song && !songOnRequestedAlbum;
    const decision = locked || contradiction || songOffAlbum && !exactSong
      || match.titleSimilarity < MATCH_POLICY.minTitleSimilarity
      ? "reject"
      : exactSong && songOnRequestedAlbum
        ? "accept"
        : exactSong
          ? "verify"
          : assessed.selectedIndex === index && !evidence?.folder?.yearConflicting
            ? "accept"
            : match.score >= MATCH_POLICY.selectableScore && match.evidence.length >= 2 || strongFolder
              ? "verify" : "review";
    return {
      candidateIndex: index,
      candidate,
      decision,
      reason: locked ? "locked" : contradiction ? "contradiction" : songOffAlbum && !exactSong ? "other-album" : null,
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
      officialAudio: isOfficialYoutubeAudio(candidate, request),
      songOnRequestedAlbum,
      policyVersion: MATCH_POLICY.version,
    };
  }).sort((left, right) => DECISION_RANK[left.decision] - DECISION_RANK[right.decision]
    || Number(right.songOnRequestedAlbum) - Number(left.songOnRequestedAlbum)
    || Number(right.officialAudio) - Number(left.officialAudio)
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
  const assessment = decideRecording(recordingRequest(trackRequest), normalized.map((candidate) =>
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

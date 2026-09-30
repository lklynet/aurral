import { checkVariantCompatibility } from "./semanticPolicy.js";
import { foldDiacritics } from "../providers/brainzmashRanking.js";

export const MATCH_POLICY = Object.freeze({
  version: "aurral-native-2",
  maxDurationGapMs: 10000,
  selectedDurationGapMs: 2000,
  minTitleSimilarity: 0.7,
  minArtistSimilarity: 0.9,
  minArtistNonConflictSimilarity: 0.4,
  selectableScore: 0.78,
  runnerUpMargin: 0.05,
  releaseMinCoverage: 0.8,
  releaseFitFloor: 0.8,
  releaseRunnerUpMargin: 0.05,
});

export function getMatcherStatus() {
  return { available: true, checked: true, policyVersion: MATCH_POLICY.version, error: null };
}

export function normalizeMatchText(value) {
  return foldDiacritics(String(value || "").normalize("NFKD"))
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function parseListingTitle(path) {
  const base = String(path || "").split(/[\\/]/).at(-1).replace(/\.[^.]+$/, "").trim();
  if (/^\d{1,3}$/u.test(base)) return { title: null, trackNumber: Number(base) };
  const patterns = [
    /^(\d{1,2})-(\d{1,3})(?:\s*[-.]\s*|\s+)(.+)$/u,
    /^.+?\s+-\s+CD(\d{1,2})\s+-\s+(\d{1,3})\s+(.+)$/iu,
    /^\[(\d{1,2})\.(\d{1,3})\]\s*(.+)$/u,
    /^.+?\s+-\s+(\d{1,3})\s+-\s+(.+)$/u,
    /^(\d{1,3})[. -]+(.+)$/u,
    /^(.+?)\s+\((\d{1,3})\)$/u,
  ];
  for (const [index, pattern] of patterns.entries()) {
    const match = pattern.exec(base);
    if (!match) continue;
    const title = index === 5 ? match[1] : match.at(-1);
    const trackNumber = Number(index < 3 ? match[2] : index === 5 ? match[2] : match[1]);
    return { title: title.trim(), trackNumber: Number.isFinite(trackNumber) ? trackNumber : null };
  }
  return { title: base, trackNumber: null };
}

function similarity(left, right) {
  const a = normalizeMatchText(left);
  const b = normalizeMatchText(right);
  if (!a || !b) return 0;
  if (a.length > 512 || b.length > 512) return 0;
  if (a === b) return 1;
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const old = previous[j];
      previous[j] = Math.min(
        previous[j] + 1,
        previous[j - 1] + 1,
        diagonal + Number(a[i - 1] !== b[j - 1]),
      );
      diagonal = old;
    }
  }
  return 1 - previous[b.length] / Math.max(a.length, b.length);
}

const VARIANTS = ["live", "remix", "acoustic", "instrumental", "demo", "edit", "karaoke", "cover", "nightcore"];

function variants(title) {
  const normalized = normalizeMatchText(title);
  const found = VARIANTS.filter((variant) => new RegExp(`\\b${variant}\\b`, "u").test(normalized));
  const mix = /\b(extended|radio|club|dance|single|album) mix\b/u.exec(normalized);
  if (mix) found.push(`${mix[1]}-mix`);
  return found;
}

function coreMatchTitle(title) {
  return String(title || "")
    .replace(/\s*[[(][^\])]*\b(?:live|remix|acoustic|instrumental|demo|edit|karaoke|cover|nightcore|mix|remaster(?:ed)?|feat\.?|ft\.?|featuring|official audio|official video|visualizer|lyrics)\b[^\])]*[\])]/giu, "")
    .replace(/\s+[-–—]\s+(?:(?:radio|extended|club|dance|single|album)\s+)?(?:edit|mix|live|remix|acoustic|instrumental|demo|karaoke|remaster(?:ed)?)\b.*$/iu, "")
    .replace(/\s+\b(?:feat\.?|ft\.?|featuring)\s+.+$/iu, "")
    .trim();
}

function coreArtist(name) {
  return String(name || "").replace(/\s+\b(?:feat\.?|ft\.?|featuring)\s+.+$/iu, "").trim();
}

function nonLatinTitleContradiction(left, right) {
  const a = normalizeMatchText(coreMatchTitle(left));
  const b = normalizeMatchText(coreMatchTitle(right));
  return Boolean(a && b && a !== b && /(?!\p{Script=Latin})\p{L}/u.test(`${a} ${b}`));
}

function asNames(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  return value ? [value] : [];
}

function compareRecording(request, candidate, policy) {
  const contradictions = [];
  if (nonLatinTitleContradiction(request.title, candidate.title)) contradictions.push("title");
  const requestId = String(request.recordingMbid || request.recording_mbid || "").toLowerCase();
  const candidateId = String(candidate.recordingMbid || candidate.recording_mbid || "").toLowerCase();
  if (requestId && candidateId && requestId !== candidateId) contradictions.push("recording-mbid");
  const requestVariants = variants(request.title);
  const candidateVariants = variants(candidate.title);
  const extraVariant = candidateVariants.find((variant) => !requestVariants.includes(variant));
  const missingVariant = requestVariants.find((variant) =>
    !variant.endsWith("-mix") && !candidateVariants.includes(variant));
  if (candidate.title && (extraVariant || missingVariant)) {
    contradictions.push(extraVariant || missingVariant);
  }
  const semanticVariants = checkVariantCompatibility(
    { trackName: request.title }, { title: candidate.title });
  for (const contradiction of semanticVariants.contradictions || []) {
    if (!contradictions.includes(contradiction)) contradictions.push(contradiction);
  }
  const requestDuration = Number(request.durationMs ?? request.duration_ms);
  const candidateDuration = Number(candidate.durationMs ?? candidate.duration_ms);
  const hasDuration = Number.isFinite(requestDuration) && requestDuration > 0
    && Number.isFinite(candidateDuration) && candidateDuration > 0;
  const gap = hasDuration ? Math.abs(requestDuration - candidateDuration) : null;
  if (gap != null && gap > policy.maxDurationGapMs) contradictions.push("duration");

  const title = similarity(coreMatchTitle(request.title), coreMatchTitle(candidate.title));
  const requestArtists = [...asNames(request.artists || request.artist), ...asNames(request.artistAliases)];
  const candidateArtists = asNames(candidate.artists || candidate.artist);
  const artist = requestArtists.length && candidateArtists.length
    ? Math.max(...requestArtists.flatMap((left) => candidateArtists.map((right) =>
      similarity(coreArtist(left), coreArtist(right)))))
    : null;
  if (artist != null && artist < policy.minArtistNonConflictSimilarity) contradictions.push("artist");
  const evidence = [];
  if (requestId && candidateId && requestId === candidateId) evidence.push("recording-mbid");
  if (title >= policy.minTitleSimilarity) evidence.push("title");
  if (artist != null && artist >= policy.minArtistSimilarity) evidence.push("artist");
  if (gap != null && gap <= policy.maxDurationGapMs) evidence.push("duration");
  const score = Math.min(1,
    title * 0.55 + (artist ?? 0) * 0.2 + (gap == null ? 0 : Math.max(0, 1 - gap / policy.maxDurationGapMs)) * 0.25
    + (evidence.includes("recording-mbid") ? 0.2 : 0),
  );
  return { contradictions, evidence, score, titleSimilarity: title, artistSimilarity: artist, durationGapMs: gap };
}

export function decideRecording(request, candidates, policy = MATCH_POLICY) {
  const assessed = candidates.map((candidate, index) => ({
    index, candidate, ...compareRecording(request, candidate, policy),
  }));
  const eligible = assessed.filter((item) => item.contradictions.length === 0
    && item.evidence.length >= 2 && item.evidence.includes("title"))
    .sort((left, right) => right.score - left.score || left.index - right.index);
  const best = eligible[0];
  const runnerUp = eligible[1];
  let decision = "skip";
  let selectedIndex = null;
  if (best) {
    const strongDuration = best.evidence.includes("recording-mbid")
      || (best.durationGapMs != null && best.durationGapMs <= policy.selectedDurationGapMs);
    const singleCandidateNeedsExactDuration = candidates.length === 1
      && !best.evidence.includes("recording-mbid") && best.durationGapMs !== 0;
    decision = strongDuration && !singleCandidateNeedsExactDuration
      && best.score >= policy.selectableScore
      && (!runnerUp || best.score - runnerUp.score >= policy.runnerUpMargin)
      ? "selectable" : "uncertain";
    if (decision === "selectable") selectedIndex = best.index;
  }
  return { decision, selectedIndex, candidates: assessed, policyVersion: policy.version };
}

function maximumWeightColumns(weights) {
  const rowCount = weights.length;
  const columnCount = weights[0]?.length || 0;
  const rowPotential = new Array(rowCount + 1).fill(0);
  const columnPotential = new Array(columnCount + 1).fill(0);
  const rowForColumn = new Array(columnCount + 1).fill(0);
  const previousColumn = new Array(columnCount + 1).fill(0);
  for (let row = 1; row <= rowCount; row += 1) {
    rowForColumn[0] = row;
    let column = 0;
    const distance = new Array(columnCount + 1).fill(Infinity);
    const visited = new Array(columnCount + 1).fill(false);
    do {
      visited[column] = true;
      const currentRow = rowForColumn[column];
      let nextColumn = 0;
      let smallest = Infinity;
      for (let candidate = 1; candidate <= columnCount; candidate += 1) {
        if (visited[candidate]) continue;
        const reducedCost = -weights[currentRow - 1][candidate - 1]
          - rowPotential[currentRow] - columnPotential[candidate];
        if (reducedCost < distance[candidate]) {
          distance[candidate] = reducedCost;
          previousColumn[candidate] = column;
        }
        if (distance[candidate] < smallest) {
          smallest = distance[candidate];
          nextColumn = candidate;
        }
      }
      for (let candidate = 0; candidate <= columnCount; candidate += 1) {
        if (visited[candidate]) {
          rowPotential[rowForColumn[candidate]] += smallest;
          columnPotential[candidate] -= smallest;
        } else {
          distance[candidate] -= smallest;
        }
      }
      column = nextColumn;
    } while (rowForColumn[column] !== 0);
    do {
      const nextColumn = previousColumn[column];
      rowForColumn[column] = rowForColumn[nextColumn];
      column = nextColumn;
    } while (column !== 0);
  }
  const columns = new Array(rowCount).fill(-1);
  for (let column = 1; column <= columnCount; column += 1) {
    if (rowForColumn[column]) columns[rowForColumn[column] - 1] = column - 1;
  }
  return columns;
}

export function assignReleaseFiles(tracks, files, policy = MATCH_POLICY) {
  const titleCounts = new Map();
  for (const track of tracks) {
    const key = normalizeMatchText(track.title);
    if (key) titleCounts.set(key, (titleCounts.get(key) || 0) + 1);
  }
  const edges = tracks.map((track) => files.map((file, fileIndex) => {
    const comparison = compareRecording(track, file, policy);
    const repeatedTitle = (titleCounts.get(normalizeMatchText(track.title)) || 0) > 1;
    if (repeatedTitle && Number(track.trackNumber) > 0 && Number(file.trackNumber) > 0
      && Number(track.trackNumber) !== Number(file.trackNumber)) {
      comparison.contradictions.push("duplicate-title-position");
    }
    const positionOnly = !normalizeMatchText(file.title)
      && Number(track.trackNumber) > 0
      && Number(track.trackNumber) === Number(file.trackNumber)
      && comparison.durationGapMs != null
      && comparison.durationGapMs <= policy.selectedDurationGapMs;
    return {
      fileIndex,
      ...comparison,
      score: positionOnly ? Math.max(comparison.score, policy.releaseFitFloor) : comparison.score,
      evidence: positionOnly ? [...comparison.evidence, "position"] : comparison.evidence,
    };
  }).filter((edge) => edge.contradictions.length === 0
    && (edge.evidence.includes("title") || edge.evidence.includes("position"))
    && edge.score >= policy.selectableScore)
    .sort((left, right) => right.score - left.score || left.fileIndex - right.fileIndex));
  const cardinalityBonus = tracks.length + 1;
  const weights = edges.map((trackEdges) => {
    const row = new Array(files.length + tracks.length).fill(0);
    for (const edge of trackEdges) row[edge.fileIndex] = cardinalityBonus + edge.score;
    return row;
  });
  const assignedColumns = maximumWeightColumns(weights);
  const trackForFile = new Array(files.length).fill(-1);
  const pairs = assignedColumns.flatMap((fileIndex, trackIndex) => {
    const edge = fileIndex < files.length
      ? edges[trackIndex].find((item) => item.fileIndex === fileIndex) : null;
    if (!edge) return [];
    trackForFile[fileIndex] = trackIndex;
    return [{ trackIndex, fileIndex, score: edge.score }];
  });
  return {
    pairs,
    unassignedTrackIndexes: tracks.flatMap((_, index) => pairs.some((pair) => pair.trackIndex === index) ? [] : [index]),
    unassignedFileIndexes: files.flatMap((_, index) => trackForFile[index] < 0 ? [index] : []),
    policyVersion: policy.version,
  };
}

export function assessRelease(release, folder, policy = MATCH_POLICY) {
  const tracks = release.tracks || [];
  const files = folder.files || [];
  const assignment = assignReleaseFiles(tracks, files, policy);
  const coverage = tracks.length ? assignment.pairs.length / tracks.length : 0;
  const fit = assignment.pairs.length
    ? assignment.pairs.reduce((sum, pair) => sum + pair.score, 0) / assignment.pairs.length
    : 0;
  const decision = coverage + 1e-9 >= policy.releaseMinCoverage && fit + 1e-9 >= policy.releaseFitFloor
    ? "selectable" : assignment.pairs.length ? "uncertain" : "skip";
  return { decision, coverage, fit, assignment, policyVersion: policy.version };
}

export function selectReleaseSession({ releases = [], folders = [], requestedRecordingMbid = null }, policy = MATCH_POLICY) {
  const options = [];
  for (const [folderIndex, folder] of folders.entries()) {
    for (const [releaseIndex, release] of releases.entries()) {
      const assessment = assessRelease(release, folder, policy);
      if (assessment.decision !== "selectable") continue;
      let requestedFileIndex = null;
      if (requestedRecordingMbid) {
        const trackIndex = (release.tracks || []).findIndex((track) =>
          (track.recordingMbid || track.recording_mbid) === requestedRecordingMbid);
        const pair = assessment.assignment.pairs.find((entry) => entry.trackIndex === trackIndex);
        if (!pair) continue;
        requestedFileIndex = pair.fileIndex;
      }
      options.push({ folder, release, folderIndex, releaseIndex, assessment, requestedFileIndex });
    }
  }
  options.sort((left, right) => right.assessment.fit - left.assessment.fit
    || right.assessment.coverage - left.assessment.coverage
    || left.folderIndex - right.folderIndex || left.releaseIndex - right.releaseIndex);
  const best = options[0] || null;
  const runnerUp = options[1] || null;
  const decision = !best ? "skip" : runnerUp
    && best.assessment.fit - runnerUp.assessment.fit < policy.releaseRunnerUpMargin
    ? "uncertain" : "selectable";
  return { decision, selected: decision === "selectable" ? best : null, options, policyVersion: policy.version };
}

export function verifyDownloadedRecording(request, observed, policy = MATCH_POLICY) {
  const result = compareRecording(request, observed, policy);
  const expectedTrackNumber = Number(request.trackNumber || 0);
  const actualTrackNumber = Number(observed.trackNumber || 0);
  const siblingTitle = expectedTrackNumber > 0 && actualTrackNumber > 0
    && expectedTrackNumber !== actualTrackNumber
    ? request.albumTrackTitles?.[actualTrackNumber - 1] : null;
  if (siblingTitle && normalizeMatchText(siblingTitle) !== normalizeMatchText(request.title)) {
    result.contradictions.push("sibling-track-index");
  }
  if (observed.fileNameTitle
    && (nonLatinTitleContradiction(request.title, observed.fileNameTitle)
      || result.titleSimilarity >= policy.minTitleSimilarity
        && normalizeMatchText(observed.fileNameTitle)
        && similarity(coreMatchTitle(request.title), coreMatchTitle(observed.fileNameTitle))
          < policy.minTitleSimilarity)) {
    result.contradictions.push("filename-title");
  }
  if (observed.fileNameTitle
    && variants(request.title).join("|") !== variants(observed.fileNameTitle).join("|")) {
    result.contradictions.push("filename-variant");
  }
  let decision = "ambiguous";
  if (result.contradictions.length) decision = "no_match";
  else if (result.evidence.includes("recording-mbid")) decision = "matched";
  else if (result.evidence.includes("title") && result.evidence.includes("artist")
    && result.durationGapMs != null && result.durationGapMs <= policy.selectedDurationGapMs) decision = "matched";
  return { decision, ...result, policyVersion: policy.version };
}

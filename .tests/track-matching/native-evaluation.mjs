import { readFileSync } from "node:fs";
import {
  assessRelease,
  decideRecording,
  parseListingTitle,
  verifyDownloadedRecording,
} from "../../backend/services/trackMatching/nativeMatcher.js";
import { loadFixtureSet, measureFixtureDecisions } from "./fixture-corpus.js";

const releases = readFileSync(new URL("./fixtures/source-releases.jsonl", import.meta.url), "utf8")
  .trim().split("\n").map((line) => JSON.parse(line));
const byRelease = new Map(releases.map((release) => [release.release_mbid, release]));
const byRecording = new Map();
const diagnostics = { noRequest: 0, noFolder: 0, folderTie: 0, noRequestedFile: 0, examples: [] };
for (const release of releases) {
  for (const track of release.tracks) {
    if (!byRecording.has(track.recording_mbid)) byRecording.set(track.recording_mbid, { release, track });
  }
}

function requestFor(item) {
  const raw = item.input;
  if (raw.expected) {
    const metadata = raw.expected.metadata;
    return { title: metadata.title, artists: [metadata.artist], durationMs: metadata.duration_ms,
      recordingMbid: metadata.recording_mbid || null };
  }
  const release = byRelease.get(raw.release_mbids?.[0]);
  const track = release?.tracks.find((entry) => entry.recording_mbid === raw.target_recording_mbid);
  const found = track ? { release, track } : byRecording.get(raw.target_recording_mbid);
  return found ? {
    title: found.track.title,
    artists: [found.track.artist_credit || found.release.artist_credit],
    durationMs: found.track.duration_ms,
    recordingMbid: raw.target_recording_mbid,
  } : null;
}

function fileCandidate(raw) {
  return { key: raw.key, ...parseListingTitle(raw.path), durationMs: raw.duration_ms };
}

function releaseCandidate(raw) {
  return { tracks: raw.tracks.map((track) => ({
    title: track.title,
    artists: [track.artist_credit || raw.artist_credit],
    durationMs: track.duration_ms,
    recordingMbid: track.recording_mbid,
    trackNumber: track.position,
  })) };
}

function decide(item) {
  const raw = item.input;
  const request = requestFor(item);
  if (!request) { diagnostics.noRequest += 1; return null; }
  if (item.flow === "post-download") {
    const observed = raw.observed;
    const result = verifyDownloadedRecording(request, {
      title: observed.title,
      artists: observed.artists,
      durationMs: observed.duration_ms,
      recordingMbid: observed.recording_mbid,
    });
    return result.decision === "matched" ? "accept" : null;
  }
  if (raw.folders) {
    const candidateReleases = raw.release_mbids.map((id) => byRelease.get(id)).filter(Boolean);
    const selectable = raw.folders.flatMap((folder) => {
      const fits = candidateReleases.map((release) => ({
        release,
        fit: assessRelease(releaseCandidate(release), { files: folder.files.map(fileCandidate) }),
      })).filter(({ fit }) => fit.decision === "selectable")
        .sort((left, right) => right.fit.fit - left.fit.fit);
      return fits[0] ? [{ folder, ...fits[0] }] : [];
    })
      .sort((left, right) => right.fit.fit - left.fit.fit || left.folder.key.localeCompare(right.folder.key));
    if (!selectable.length) { diagnostics.noFolder += 1; return null; }
    if (selectable[1] && selectable[0].fit.fit - selectable[1].fit.fit < 0.05) {
      diagnostics.folderTie += 1;
      return null;
    }
    const chosen = selectable[0];
    if (item.flow === "track-with-release") {
      const trackIndex = chosen.release.tracks.findIndex(
        (track) => track.recording_mbid === raw.target_recording_mbid,
      );
      const pair = chosen.fit.assignment.pairs.find((entry) => entry.trackIndex === trackIndex);
      const selected = pair && chosen.folder.files[pair.fileIndex];
      const evidence = selected && fileCandidate(selected);
      const safeSelection = evidence && (
        evidence.title
          ? decideRecording(request, [evidence]).decision === "selectable"
          : evidence.trackNumber === chosen.release.tracks[trackIndex]?.position
            && Math.abs(evidence.durationMs - request.durationMs) <= 2000
      );
      if (!safeSelection) {
        diagnostics.noRequestedFile += 1;
        if (item.actionable && diagnostics.examples.length < 8) diagnostics.examples.push({
          id: item.id, request: request.title, folder: chosen.folder.key,
          paths: chosen.folder.files.map((file) => file.path).slice(0, 8),
        });
        return null;
      }
    }
    return chosen.folder.key;
  }
  const candidates = raw.candidates.map((candidate) => candidate.metadata
    ? { key: candidate.key, title: candidate.metadata.title, artists: [candidate.metadata.artist],
        durationMs: candidate.metadata.duration_ms,
        recordingMbid: candidate.metadata.recording_mbid || null }
    : fileCandidate(candidate));
  const result = decideRecording(request, candidates);
  return result.selectedIndex == null ? null : candidates[result.selectedIndex].key;
}

const split = process.argv[2] || "development";
const fixtures = loadFixtureSet(split);
const decisions = new Map(fixtures.map((item) => [item.id, decide(item)]));
const report = measureFixtureDecisions(fixtures, (item) => decisions.get(item.id));
process.stdout.write(`${JSON.stringify({ split, matcher: "aurral-native-1", cases: fixtures.length, report }, null, 2)}\n`);
if (process.env.DEBUG_NATIVE) {
  diagnostics.wrong = fixtures.filter((item) => {
    const selected = decisions.get(item.id);
    return selected != null && !item.correctIds.includes(selected);
  }).map((item) => ({ id: item.id, selected: decisions.get(item.id), flow: item.flow }));
  process.stderr.write(`${JSON.stringify(diagnostics)}\n`);
}

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  MATCH_POLICY,
  decideRecording,
  parseListingTitle,
  verifyDownloadedRecording,
} from "../../backend/services/trackMatching/nativeMatcher.ts";
import { judgeRelease } from "../../backend/services/trackMatching/releaseJudge.ts";
import {
  loadFixtureSet,
  measureFixtureDecisions,
  type Fixture,
  type FixtureFile,
} from "./fixture-corpus.ts";

type SourceRelease = {
  release_mbid: string;
  title: string;
  artist_credit: string;
  secondary_types: string[];
  tracks: {
    recording_mbid: string;
    title: string;
    artist_credit: string;
    artist_aliases: string[];
    duration_ms: number;
    position: number;
    disc: number;
  }[];
};

const releases = readFileSync(new URL("./fixtures/source-releases.jsonl", import.meta.url), "utf8")
  .trim()
  .split("\n")
  .map((line): SourceRelease => JSON.parse(line));
const byRelease = new Map(releases.map((release) => [release.release_mbid, release]));
const byRecording = new Map<
  string,
  { release: SourceRelease; track: SourceRelease["tracks"][number] }
>();
const diagnostics = {
  noRequest: 0,
  noFolder: 0,
  noRequestedFile: 0,
  examples: [] as { id: string; request: string; folder: string; paths: string[] }[],
};
for (const release of releases) {
  for (const track of release.tracks) {
    if (!byRecording.has(track.recording_mbid))
      byRecording.set(track.recording_mbid, { release, track });
  }
}

function requestFor(item: Fixture) {
  const raw = item.input;
  if (raw.expected) {
    const metadata = raw.expected.metadata;
    return {
      title: metadata.title,
      artists: [metadata.artist],
      durationMs: metadata.duration_ms,
      recordingMbid: metadata.recording_mbid || null,
    };
  }
  const release = raw.release_mbids?.[0] ? byRelease.get(raw.release_mbids[0]) : undefined;
  const track = release?.tracks.find((entry) => entry.recording_mbid === raw.target_recording_mbid);
  const found = track
    ? { release, track }
    : raw.target_recording_mbid
      ? byRecording.get(raw.target_recording_mbid)
      : undefined;
  return found?.release
    ? {
        title: found.track.title,
        artists: [found.track.artist_credit || found.release.artist_credit],
        durationMs: found.track.duration_ms,
        recordingMbid: raw.target_recording_mbid,
      }
    : null;
}

function fileCandidate(raw: FixtureFile) {
  return {
    key: raw.key,
    path: raw.path,
    ...parseListingTitle(raw.path),
    durationMs: raw.duration_ms,
  };
}

function releaseManifest(raw: SourceRelease) {
  return {
    releaseMbid: raw.release_mbid,
    title: raw.title,
    artistNames: [raw.artist_credit],
    secondaryTypes: raw.secondary_types,
    tracks: raw.tracks.map((track) => ({
      title: track.title,
      artists: [track.artist_credit || raw.artist_credit],
      artistAliases: track.artist_aliases || [],
      durationMs: track.duration_ms || null,
      trackNumber: track.position,
      discNumber: track.disc || 1,
      recordingMbid: track.recording_mbid,
      recordingMbidAliases: [],
      pressingDurationsMs: [],
    })),
  };
}

function decide(item: Fixture) {
  const raw = item.input;
  const request = requestFor(item);
  if (!request) {
    diagnostics.noRequest += 1;
    return null;
  }
  if (item.flow === "post-download") {
    const observed = raw.observed;
    assert.ok(observed);
    const result = verifyDownloadedRecording(request, {
      title: observed.title,
      artists: observed.artists,
      durationMs: observed.duration_ms,
      recordingMbid: observed.recording_mbid,
    });
    return result.decision === "matched" ? "accept" : null;
  }
  if (raw.folders) {
    assert.ok(raw.release_mbids);
    const candidateReleases = raw.release_mbids
      .map((id) => byRelease.get(id))
      .filter((release) => release != null);
    const selectable = raw.folders
      .flatMap((folder) => {
        const fits = candidateReleases
          .map((release) => ({
            release,
            fit: judgeRelease(releaseManifest(release), { files: folder.files.map(fileCandidate) }),
          }))
          .filter(({ fit }) => fit.kind === "exact")
          .sort((left, right) => right.fit.fit - left.fit.fit);
        return fits[0] ? [{ folder, ...fits[0] }] : [];
      })
      .sort(
        (left, right) =>
          right.fit.fit - left.fit.fit || left.folder.key.localeCompare(right.folder.key),
      );
    if (!selectable.length) {
      diagnostics.noFolder += 1;
      return null;
    }
    const chosen = selectable[0];
    if (item.flow === "track-with-release") {
      const trackIndex = chosen.release.tracks.findIndex(
        (track) => track.recording_mbid === raw.target_recording_mbid,
      );
      const fileIndex = chosen.fit.fileForTrack[trackIndex];
      const selected = fileIndex != null && chosen.folder.files[fileIndex];
      const evidence = selected && fileCandidate(selected);
      const safeSelection =
        evidence &&
        (evidence.title
          ? decideRecording(request, [evidence]).decision === "selectable"
          : evidence.trackNumber === chosen.release.tracks[trackIndex]?.position &&
            Math.abs(evidence.durationMs - request.durationMs) <= 2000);
      if (!safeSelection) {
        diagnostics.noRequestedFile += 1;
        if (item.actionable && diagnostics.examples.length < 8)
          diagnostics.examples.push({
            id: item.id,
            request: request.title,
            folder: chosen.folder.key,
            paths: chosen.folder.files.map((file) => file.path).slice(0, 8),
          });
        return null;
      }
    }
    return chosen.folder.key;
  }
  assert.ok(raw.candidates);
  const candidates = raw.candidates.map((candidate) =>
    "metadata" in candidate
      ? {
          key: candidate.key,
          title: candidate.metadata.title,
          artists: [candidate.metadata.artist],
          durationMs: candidate.metadata.duration_ms,
          recordingMbid: candidate.metadata.recording_mbid || null,
        }
      : fileCandidate(candidate),
  );
  const result = decideRecording(request, candidates);
  return result.selectedIndex == null ? null : candidates[result.selectedIndex].key;
}

const split = process.argv[2] || "development";
const fixtures = loadFixtureSet(split);
const decisions = new Map(fixtures.map((item) => [item.id, decide(item)]));
const report = measureFixtureDecisions(fixtures, (item) => decisions.get(item.id));
process.stdout.write(
  `${JSON.stringify({ split, matcher: MATCH_POLICY.version, cases: fixtures.length, report }, null, 2)}\n`,
);
if (process.env.DEBUG_NATIVE) {
  const wrong = fixtures
    .filter((item) => {
      const selected = decisions.get(item.id);
      return selected != null && !item.correctIds.includes(selected);
    })
    .map((item) => ({ id: item.id, selected: decisions.get(item.id), flow: item.flow }));
  process.stderr.write(`${JSON.stringify({ ...diagnostics, wrong })}\n`);
}

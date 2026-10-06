import path from "node:path";
import fs from "node:fs/promises";
import { parseFile } from "music-metadata";
import { assignReleaseFiles, parseListingTitle, readRecordingMbid } from "./trackMatching/nativeMatcher.js";
import { validateDownloadedTrackFile } from "./trackMatching/postDownloadValidator.js";
import { buildResolvedJobTrack } from "./downloadUtils.js";
import { candidateReleasesForJobs } from "./albumReleases.js";

function positiveDurationMs(parsed) {
  const seconds = Number(parsed?.format?.duration);
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null;
}

function fileEvidence(filePath, parsed) {
  const listing = parseListingTitle(filePath);
  return {
    title: String(parsed?.common?.title || listing.title || "").trim(),
    artists: [parsed?.common?.artist].filter(Boolean),
    durationMs: positiveDurationMs(parsed),
    trackNumber: parsed?.common?.track?.no || listing.trackNumber || null,
    recordingMbid: readRecordingMbid(parsed?.common?.musicbrainz_recordingid),
  };
}

function rankAssignment(release, files) {
  const assignment = assignReleaseFiles(release.tracks, files);
  const filled = new Set(assignment.pairs.map((pair) => pair.trackIndex));
  return {
    release,
    assignment,
    pairs: assignment.pairs.length,
    positions: assignment.pairs.filter((pair) => Number(release.tracks[pair.trackIndex].trackNumber) > 0
      && Number(release.tracks[pair.trackIndex].trackNumber) === Number(files[pair.fileIndex].trackNumber)).length,
    unfilled: release.tracks.filter((track, index) => track.onRelease && !filled.has(index)).length,
    score: assignment.pairs.reduce((sum, pair) => sum + pair.score, 0),
  };
}

// Like an import in Lidarr, the files decide which edition arrived: the
// release that assigns the most files, with the most matching positions,
// leaving the fewest of its own tracks unfilled, most closely, wins.
function assignBestRelease(jobs, files, releases) {
  return candidateReleasesForJobs(jobs, releases)
    .map((release) => rankAssignment(release, files))
    .reduce((best, entry) => (entry.pairs - best.pairs
      || entry.positions - best.positions
      || best.unfilled - entry.unfilled
      || entry.score - best.score) > 0 ? entry : best);
}

function requestForRelease(job, release, track) {
  const request = { ...buildResolvedJobTrack(job), recordingMbidAliases: track.recordingMbidAliases };
  if (!release.titles) return request;
  return {
    ...request,
    durationMs: track.durationMs || request.durationMs,
    trackNumber: track.trackNumber,
    albumTrackTitles: release.titles,
  };
}

export async function assignDownloadedAlbumFiles({
  jobs,
  filePaths,
  source,
  releases = [],
  parseAudio = parseFile,
}) {
  const readable = [];
  const seen = new Set();
  for (const filePath of filePaths || []) {
    const resolved = path.resolve(String(filePath || ""));
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    const stat = await fs.stat(resolved).catch(() => null);
    if (!stat?.isFile()) continue;
    try {
      const parsed = await parseAudio(resolved, { duration: true });
      readable.push({ filePath: resolved, evidence: fileEvidence(resolved, parsed) });
    } catch {
      // An unreadable file cannot be imported.
    }
  }
  const { release, assignment } = assignBestRelease(
    jobs,
    readable.map((entry) => entry.evidence),
    releases,
  );
  const accepted = [];
  const rejected = [];
  const unassignedJobIds = new Set(jobs.map((job) => job.id));
  for (const pair of assignment.pairs) {
    const job = jobs[pair.trackIndex];
    const entry = readable[pair.fileIndex];
    const validation = await validateDownloadedTrackFile({
      request: requestForRelease(job, release, release.tracks[pair.trackIndex]),
      filePath: entry.filePath,
      source,
      options: { parseFile: parseAudio, strict: true },
    });
    if (validation.valid) {
      const trackNumber = release.tracks[pair.trackIndex].trackNumber || null;
      accepted.push({ jobId: job.id, filePath: entry.filePath, trackNumber, validation });
      unassignedJobIds.delete(job.id);
    } else {
      rejected.push({ jobId: job.id, reason: validation.reason || "no match" });
    }
  }
  return {
    accepted,
    rejected,
    unassignedJobIds: [...unassignedJobIds],
    unreadableCount: (filePaths || []).length - readable.length,
    releaseId: release.id,
    edition: release.id && release.requestedAll ? {
      id: release.id,
      jobIds: jobs.filter((job, index) => release.tracks[index].onRelease).map((job) => job.id),
    } : null,
    policyVersion: assignment.policyVersion,
  };
}

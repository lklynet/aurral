import path from "node:path";
import fs from "node:fs/promises";
import { parseFile } from "music-metadata";
import { assignReleaseFiles, parseListingTitle } from "./trackMatching/nativeMatcher.js";
import { validateDownloadedTrackFile } from "./trackMatching/postDownloadValidator.js";
import { buildResolvedPlaylistTrack } from "./playlistDownloadUtils.js";

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
    recordingMbid: parsed?.common?.musicbrainz_recordingid || null,
  };
}

function trackEvidence(job) {
  return {
    title: job.trackName,
    artists: [job.artistName].filter(Boolean),
    artistAliases: job.artistAliases || [],
    durationMs: job.durationMs,
    trackNumber: job.trackNumber,
    recordingMbid: job.trackMbid,
  };
}

export async function assignDownloadedAlbumFiles({ jobs, filePaths, source, parseAudio = parseFile }) {
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
  const assignment = assignReleaseFiles(jobs.map(trackEvidence), readable.map((entry) => entry.evidence));
  const accepted = [];
  const rejected = [];
  const unassignedJobIds = new Set(jobs.map((job) => job.id));
  for (const pair of assignment.pairs) {
    const job = jobs[pair.trackIndex];
    const entry = readable[pair.fileIndex];
    const validation = await validateDownloadedTrackFile({
      request: buildResolvedPlaylistTrack(job),
      filePath: entry.filePath,
      source,
      options: { parseFile: parseAudio, strict: true },
    });
    if (validation.valid) {
      accepted.push({ jobId: job.id, filePath: entry.filePath, validation });
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
    policyVersion: assignment.policyVersion,
  };
}

import path from "node:path";
import fs from "node:fs/promises";
import { parseFile } from "music-metadata";
import { downloadedFileEvidence, validateDownloadedTrackFile } from "./trackMatching/postDownloadValidator.js";
import { mapRequest, trackRequestFor } from "./releaseManifest.js";
import { judgeRelease } from "./trackMatching/releaseJudge.js";

export async function assignDownloadedAlbumFiles({
  jobs,
  filePaths,
  source,
  manifest,
  verified = false,
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
      readable.push({ filePath: resolved, evidence: downloadedFileEvidence(resolved, parsed, { album: manifest.title }) });
    } catch {
      // An unreadable file cannot be imported.
    }
  }
  const unreadableCount = (filePaths || []).length - readable.length;
  const failedRelease = (reason) => ({
    accepted: [], rejected: jobs.map((job) => ({ jobId: job.id, reason })), unreadableCount,
  });
  const verdict = judgeRelease(manifest, { files: readable.map((entry) => entry.evidence) });
  if (!verified && (unreadableCount || verdict.kind !== "exact")) {
    return failedRelease(unreadableCount ? "The album contains unreadable audio" : verdict.reason);
  }
  const { wanted } = mapRequest(manifest, jobs);
  const accepted = [];
  const rejected = [];
  for (const pair of verdict.assignment.pairs) {
    const job = jobs.find((entry) => entry.id === wanted.get(pair.trackIndex));
    if (!job) continue;
    const entry = readable[pair.fileIndex];
    const validation = await validateDownloadedTrackFile({
      request: { ...trackRequestFor(job, manifest, pair.trackIndex), upgradeForJobId: job.upgradeForJobId },
      filePath: entry.filePath,
      source,
      options: { parseFile: parseAudio, strict: true, release: manifest, albumImport: true },
    });
    if (validation.valid) {
      const { trackNumber, discNumber } = manifest.tracks[pair.trackIndex];
      accepted.push({ jobId: job.id, filePath: entry.filePath, trackNumber, discNumber, validation });
    } else {
      rejected.push({ jobId: job.id, reason: validation.reason || "no match" });
    }
  }
  return { accepted, rejected, unreadableCount };
}

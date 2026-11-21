import path from "node:path";
import fs from "node:fs/promises";
import { parseFile } from "music-metadata";
import {
  downloadedFileEvidence,
  validateDownloadedTrackFile,
} from "./trackMatching/postDownloadValidator.ts";
import { mapRequest, trackRequestFor, type ReleaseManifest } from "./releaseManifest.ts";
import { judgeRelease } from "./trackMatching/releaseJudge.ts";

type ManifestJob = Parameters<typeof mapRequest>[1][number];
type AlbumJob = ManifestJob & { upgradeForJobId?: string | null };

export async function assignDownloadedAlbumFiles({
  jobs,
  filePaths,
  source,
  manifest,
  verified = false,
  parseAudio = parseFile,
}: {
  jobs: AlbumJob[];
  filePaths?: string[] | null;
  source: string;
  manifest: ReleaseManifest;
  verified?: boolean;
  parseAudio?: typeof parseFile;
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
      readable.push({
        filePath: resolved,
        evidence: downloadedFileEvidence(resolved, parsed, { album: manifest.title }),
      });
    } catch {
      // An unreadable file cannot be imported.
    }
  }
  const unreadableCount = (filePaths || []).length - readable.length;
  const failedRelease = (reason: string) => ({
    accepted: [],
    rejected: jobs.map((job) => ({ jobId: job.id, reason })),
    unreadableCount,
  });
  const verdict = judgeRelease(manifest, { files: readable.map((entry) => entry.evidence) });
  if (!verified && unreadableCount) return failedRelease("The album contains unreadable audio");
  const singleUpgrade = jobs.length === 1 && Boolean(jobs[0]?.upgradeForJobId);
  // A bonus track changes the edition, but a single upgrade can use a copy
  // placed at the requested track if that file verifies on its own.
  const releaseVerified = verified || verdict.kind === "exact";
  if (
    !verified &&
    verdict.kind !== "exact" &&
    !(singleUpgrade && verdict.reason === "extra-tracks")
  )
    return failedRelease(verdict.reason);
  const { wanted } = mapRequest(manifest, jobs);
  const accepted = [];
  const rejected = [];
  for (const pair of verdict.assignment.pairs) {
    const job = jobs.find((entry) => entry.id === wanted.get(pair.trackIndex));
    if (!job) continue;
    const track = manifest.tracks[pair.trackIndex];
    if (!track) continue;
    const copies = singleUpgrade ? verdict.copiesForTrack[pair.trackIndex] : [pair.fileIndex];
    const request = {
      ...trackRequestFor(job, manifest, pair.trackIndex),
      upgradeForJobId: job.upgradeForJobId,
    };
    let rejection: string | null = "no match";
    for (const index of copies || []) {
      const entry = readable[index];
      if (!entry) continue;
      const validation = await validateDownloadedTrackFile({
        request,
        filePath: entry.filePath,
        source,
        options: {
          parseFile: parseAudio,
          strict: true,
          release: manifest,
          albumImport: releaseVerified,
        },
      });
      if (validation.valid) {
        accepted.push({
          jobId: job.id,
          filePath: entry.filePath,
          trackNumber: track.trackNumber,
          discNumber: track.discNumber,
          validation,
        });
        rejection = null;
        break;
      }
      rejection = validation.reason || "no match";
    }
    if (rejection) rejected.push({ jobId: job.id, reason: rejection });
  }
  return { accepted, rejected, unreadableCount };
}

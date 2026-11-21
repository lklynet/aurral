import path from "node:path";
import fs from "node:fs/promises";
import { parseFile } from "music-metadata";
import {
  downloadedFileEvidence,
  validateDownloadedTrackFile,
} from "./trackMatching/postDownloadValidator.ts";
import { mapRequest, trackRequestFor, type ReleaseManifest } from "./releaseManifest.ts";
import { judgeRelease } from "./trackMatching/releaseJudge.ts";
import { matchLargerEdition } from "./releaseResolver.ts";

type ManifestJob = Parameters<typeof mapRequest>[1][number];
type AlbumJob = ManifestJob & { upgradeForJobId?: string | null };

export async function assignDownloadedAlbumFiles({
  jobs,
  filePaths,
  source,
  manifest,
  verified = false,
  allowLargerEdition = false,
  parseAudio = parseFile,
}: {
  jobs: AlbumJob[];
  filePaths?: string[] | null;
  source: string;
  manifest: ReleaseManifest;
  verified?: boolean;
  allowLargerEdition?: boolean;
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
        groupId: parsed.common.musicbrainz_releasegroupid?.trim().toLowerCase(),
        evidence: downloadedFileEvidence(resolved, parsed, { album: manifest.title }),
      });
    } catch {
      // An unreadable file cannot be imported.
    }
  }
  const unreadableCount = (filePaths || []).length - readable.length;
  const failedRelease = (reason: string) => ({
    accepted: [],
    bonusFiles: [],
    otherEdition: null,
    rejected: jobs.map((job) => ({ jobId: job.id, reason })),
    unreadableCount,
  });
  const files = readable.map((entry) => entry.evidence);
  let verdict = judgeRelease(manifest, { files });
  if (!verified && unreadableCount) return failedRelease("The album contains unreadable audio");
  const otherEdition =
    allowLargerEdition &&
    !verified &&
    verdict.kind !== "exact" &&
    readable.every(
      (entry) => !entry.groupId || entry.groupId === manifest.releaseGroupMbid?.toLowerCase(),
    )
      ? await matchLargerEdition(manifest, files)
      : null;
  if (otherEdition) {
    manifest = otherEdition.manifest;
    verdict = otherEdition.verdict;
  }
  if (!verified && verdict.kind !== "exact") return failedRelease(verdict.reason);
  const { wanted, offManifest } = mapRequest(manifest, jobs);
  if (otherEdition && offManifest.length) return failedRelease("requested recording missing");
  const bonusFiles = [];
  const accepted = [];
  const rejected = [];
  for (const pair of verdict.assignment.pairs) {
    const job = jobs.find((entry) => entry.id === wanted.get(pair.trackIndex));
    if (!job && (!otherEdition || otherEdition.standardPlaces.has(pair.trackIndex))) continue;
    const track = manifest.tracks[pair.trackIndex];
    if (!track) continue;
    const copies = otherEdition ? verdict.copiesForTrack[pair.trackIndex] : [pair.fileIndex];
    const bonus = {
      artistName: track.artists[0] ?? manifest.artistNames[0],
      trackName: track.title,
      trackMbid: track.recordingMbid,
      albumName: jobs[0]?.albumName,
      albumMbid: manifest.releaseGroupMbid,
      releaseMbid: manifest.releaseMbid,
      trackNumber: track.trackNumber,
      discNumber: track.discNumber,
      durationMs: track.durationMs,
      artistAliases: track.artistAliases,
    };
    const request = {
      ...trackRequestFor(job ?? bonus, manifest, pair.trackIndex),
      upgradeForJobId: job?.upgradeForJobId,
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
          albumImport: true,
        },
      });
      if (validation.valid) {
        if (!job)
          bonusFiles.push({ track: bonus, filePath: entry.filePath, quality: validation.quality });
        else
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
    if (rejection && otherEdition) return failedRelease(rejection);
    if (rejection && job) rejected.push({ jobId: job.id, reason: rejection });
  }
  return { accepted, rejected, unreadableCount, otherEdition, bonusFiles };
}

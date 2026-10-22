import { logger } from "./logger.ts";
import type { DownloadJob, DownloadTracker } from "./downloadJobs/downloadTracker.ts";
import type { classifyAudioQuality } from "./qualityProfileModel.ts";
import type { finalizeQualityUpgradeSuccess } from "./qualityProfileService.ts";
import type { HistoryJob } from "./aurralHistoryService.ts";

// Fields of a search in progress; a new search or a download clears them.
export const SEARCH_RESET = Object.freeze({
  searchQueries: null,
  searchQueryIndex: 0,
  activeSearch: null,
});
type CandidatePayload<Candidate> = {
  candidateIndex?: unknown;
  candidate?: Candidate | null;
  candidates?: Candidate[] | null;
};

export function getPayloadCandidate<Candidate>(
  payload: CandidatePayload<Candidate> | null | undefined,
) {
  const candidateIndex = Number(payload?.candidateIndex || 0);
  return (
    payload?.candidate ||
    (Array.isArray(payload?.candidates) ? payload.candidates[candidateIndex] : null)
  );
}

export function hasNextCandidate(
  payload: { candidateIndex?: unknown; candidates?: unknown } | null | undefined,
) {
  return (
    Number(payload?.candidateIndex || 0) + 1 <
    (Array.isArray(payload?.candidates) ? payload.candidates.length : 0)
  );
}

export function buildNextCandidatePayload<Payload extends object>(
  payload: Payload,
): Payload & NextCandidateFields;
export function buildNextCandidatePayload<Payload extends object, ResetFields extends object>(
  payload: Payload,
  sourceResetFields: ResetFields,
): Payload & NextCandidateFields & ResetFields;
export function buildNextCandidatePayload(
  payload: { candidateIndex?: unknown },
  sourceResetFields: object = {},
) {
  return {
    ...payload,
    phase: "download" as const,
    candidate: null,
    candidateIndex: Number(payload?.candidateIndex || 0) + 1,
    pollAttempts: 0,
    ...sourceResetFields,
  };
}

type NextCandidateFields = {
  phase: "download";
  candidate: null;
  candidateIndex: number;
  pollAttempts: number;
};

export function mergeSearchResults<T, K>(
  aggregated: T[],
  seen: Set<K>,
  items: T[],
  buildKey: (item: T) => K,
) {
  for (const item of items) {
    const key = buildKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    aggregated.push(item);
  }
}

const HELD_METADATA_KEYS = [
  "downloadSource",
  "downloadClient",
  "downloadClientId",
  "releaseGuid",
  "releaseTitle",
  "indexerId",
  "indexerName",
  "remoteUsername",
  "remoteFilename",
] as const;

// A file that needs review waits while the other candidates and sources are
// tried. It keeps the job's source details so a denial blocks that file.
export function holdForReview<
  Held extends { source: string; sourcePath: string | null | undefined; reason?: string | null },
>(
  job: Partial<Record<(typeof HELD_METADATA_KEYS)[number], unknown>> | null | undefined,
  held: Held,
) {
  const { source, sourcePath, reason, ...details } = held;
  return {
    ...details,
    source,
    sourcePath,
    reason: reason || "Blocked for review",
    metadata: Object.fromEntries(HELD_METADATA_KEYS.map((key) => [key, job?.[key] ?? null])),
  };
}

export function blockPipelineJobForReview({
  downloadTracker,
  job,
  validation,
  sourcePath,
}: {
  downloadTracker: DownloadTracker;
  job: HistoryJob;
  validation: { blocked?: boolean; reason?: string | null } | null | undefined;
  sourcePath: string | null | undefined;
}) {
  const stagingPath = String(sourcePath || "").trim();
  if (!validation?.blocked || !stagingPath) return false;
  const reason = validation.reason || "Blocked for review";
  if (!downloadTracker.setBlocked(job.id, reason, stagingPath)) return false;
  import("./aurralHistoryService.ts")
    .then(({ recordTrackJobBlocked }) => recordTrackJobBlocked(job, reason))
    .catch((error) => {
      logger.warn("history", "Could not record blocked download job", {
        jobId: job.id,
        reason: error?.message || String(error),
      });
    });
  return true;
}

export async function finalizePipelineJobSuccess(options: PipelineJobSuccessOptions) {
  if (await recordPipelineJobSuccess(options)) {
    await refreshCompletedPipelinePlaylist(options.job);
  }
  return null;
}

export type PipelineSuccessJob = Parameters<typeof finalizeQualityUpgradeSuccess>[0] &
  Pick<DownloadJob, "albumName" | "managedBy">;

type PipelineJobSuccessOptions = {
  downloadTracker: DownloadTracker;
  job: PipelineSuccessJob;
  committedFinalPath: string;
  album?: string | null;
  quality?: ReturnType<typeof classifyAudioQuality> | null;
  onSuccess?: () => unknown;
};

export async function recordPipelineJobSuccess({
  downloadTracker,
  job,
  committedFinalPath,
  album,
  quality,
  onSuccess,
}: PipelineJobSuccessOptions) {
  if (job.upgradeForJobId) {
    const { finalizeQualityUpgradeSuccess } = await import("./qualityProfileService.ts");
    if (onSuccess) await onSuccess();
    await finalizeQualityUpgradeSuccess(job, committedFinalPath, quality);
    return false;
  }
  if (downloadTracker.setDone(job.id, committedFinalPath, job.albumName || album) === false)
    return false;
  if (quality) downloadTracker.updateQuality(job.id, quality);

  if (job.managedBy !== "lidarr" && committedFinalPath) {
    const { scheduleLibraryScan } = await import("./libraryScanWorker.ts");
    scheduleLibraryScan({
      includeLidarr: false,
      changedPaths: [committedFinalPath],
    });
  }

  if (onSuccess) await onSuccess();

  import("./aurralHistoryService.ts")
    .then(({ recordTrackJobCompleted }) => recordTrackJobCompleted(job))
    .catch((error) => {
      logger.warn("history", "Could not record completed download job", {
        jobId: job.id,
        reason: error?.message || String(error),
      });
    });
  return true;
}

export async function refreshCompletedPipelinePlaylist(
  job: Pick<DownloadJob, "playlistId" | "playlistType">,
) {
  const playlistType = job.playlistId || job.playlistType;
  const { playlistManager } = await import("./playlists/playlistManager.ts");
  playlistManager.requestPlaylistSync([playlistType]);
  const { downloadWorker } = await import("./downloadJobs/downloadWorker.ts");
  downloadWorker.wake(0);
  await downloadWorker.checkPlaylistComplete(playlistType);
}

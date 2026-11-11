import { flowPlaylistConfig } from "./playlists/flowPlaylistConfig.ts";
import type { DownloadJob, DownloadTracker } from "./downloadJobs/downloadTracker.ts";
import type { classifyAudioQuality } from "./qualityProfileModel.ts";
import { finalizeQualityUpgradeSuccess } from "./qualityUpgradeOutcome.ts";
import {
  recordTrackJobBlocked,
  recordTrackJobCompleted,
  type HistoryJob,
} from "./aurralHistoryService.ts";
import { recordRequestGroupDownloaded } from "./aurralHistoryRequests.ts";
import { emitPluginEvent } from "./plugins/pluginEvents.ts";
import { scheduleLibraryScan } from "./libraryScanWorker.ts";
import { playlistManager } from "./playlists/playlistManager.ts";

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
  if (flowPlaylistConfig.getFlow(job.playlistId || job.playlistType)) return false;
  const reason = validation.reason || "Blocked for review";
  if (!downloadTracker.setBlocked(job.id, reason, stagingPath)) return false;
  recordTrackJobBlocked(job, reason);
  return true;
}

export async function finalizePipelineJobSuccess(options: PipelineJobSuccessOptions) {
  if (await recordPipelineJobSuccess(options)) {
    await refreshCompletedPipelinePlaylist(options.job);
  }
  return null;
}

export type PipelineSuccessJob = Parameters<typeof finalizeQualityUpgradeSuccess>[0] &
  Pick<DownloadJob, "albumName"> &
  Partial<
    Pick<
      DownloadJob,
      "trackName" | "artistName" | "trackMbid" | "downloadSource" | "requestGroupId"
    >
  >;

type PipelineJobSuccessOptions = {
  downloadTracker: DownloadTracker;
  job: PipelineSuccessJob;
  committedFinalPath: string;
  inPlace?: boolean;
  album?: string | null;
  quality?: ReturnType<typeof classifyAudioQuality> | null;
  onSuccess?: () => unknown;
};

export async function recordPipelineJobSuccess({
  downloadTracker,
  job,
  committedFinalPath,
  inPlace = false,
  album,
  quality,
  onSuccess,
}: PipelineJobSuccessOptions) {
  if (job.upgradeForJobId) {
    if (onSuccess) await onSuccess();
    await finalizeQualityUpgradeSuccess(job, committedFinalPath, quality);
    return false;
  }
  if (
    downloadTracker.setDone(
      job.id,
      committedFinalPath,
      job.albumName || album,
      inPlace ? committedFinalPath : null,
    ) === false
  )
    return false;
  if (quality) downloadTracker.updateQuality(job.id, quality);

  if (committedFinalPath) {
    scheduleLibraryScan({
      includeReadOnly: false,
      changedPaths: [committedFinalPath],
    });
  }

  if (onSuccess) await onSuccess();
  emitPluginEvent("download.finished", {
    track: {
      title: job.trackName ?? null,
      artist: job.artistName ?? null,
      album: job.albumName || album || null,
      mbid: job.trackMbid ?? null,
      path: committedFinalPath,
    },
    source: job.downloadSource ?? null,
  });

  if (committedFinalPath) {
    const { notifyTrackAdded } = await import("./notificationService.ts");
    notifyTrackAdded({
      trackName: job.trackName,
      artistName: job.artistName,
      albumName: job.albumName || album,
      filePath: committedFinalPath,
    });
  }

  recordTrackJobCompleted(job);
  if (job.requestGroupId && committedFinalPath)
    await recordRequestGroupDownloaded(job.requestGroupId, committedFinalPath);
  return true;
}

export async function refreshCompletedPipelinePlaylist(
  job: Pick<DownloadJob, "id" | "playlistId" | "playlistType">,
) {
  const playlistType = job.playlistId || job.playlistType;
  playlistManager.requestPlaylistSync([
    playlistType,
    ...flowPlaylistConfig.getStaticPlaylistIdsUsingJobs([job.id]),
  ]);
  const { downloadWorker } = await import("./downloadJobs/downloadWorker.ts");
  downloadWorker.wake(0);
  await downloadWorker.checkPlaylistComplete(playlistType);
}

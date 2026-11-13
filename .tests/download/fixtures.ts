import assert from "node:assert/strict";
import { onTestFinished } from "vite-plus/test";
import type { DownloadTracker } from "../../backend/services/downloadJobs/downloadTracker.ts";
import type { PipelinePayload } from "../../backend/services/downloadPipeline.ts";
import type { getDownloadClient } from "../../backend/services/download/downloadClientSettings.ts";

export function createTrackedJob(
  tracker: Pick<DownloadTracker, "addJob">,
  ...args: Parameters<DownloadTracker["addJob"]>
): string {
  const id = tracker.addJob(...args);
  assert.ok(id, "Expected the fixture to create a download job");
  return id;
}

// Unit tests drive the worker by hand. This applies the download process's
// rule, where queued work starts the worker, for one test.
export function startWorkerForQueuedWork(
  tracker: Pick<DownloadTracker, "onPendingWork">,
  startWorkerIfPending: () => unknown,
) {
  tracker.onPendingWork(startWorkerIfPending);
  onTestFinished(() => tracker.onPendingWork(null));
}

export function trackedJob(
  tracker: Pick<DownloadTracker, "getJob">,
  id: Parameters<DownloadTracker["getJob"]>[0],
) {
  const job = tracker.getJob(id);
  assert.ok(job, `Expected download job ${id}`);
  return job;
}

export function localDownloadWorker(
  worker: typeof import("../../backend/services/downloadJobs/downloadWorker.ts").downloadWorker,
) {
  assert.ok("processJob" in worker, "Expected the isolated backend's download owner");
  return worker;
}

export function audioMetadata({
  common = {},
  format = {},
}: {
  common?: Partial<import("music-metadata").ICommonTagsResult>;
  format?: Partial<import("music-metadata").IFormat>;
} = {}): import("music-metadata").IAudioMetadata {
  return {
    common: {
      track: { no: null, of: null },
      disk: { no: null, of: null },
      movementIndex: { no: null, of: null },
      ...common,
    },
    format: { tagTypes: [], trackInfo: [], ...format },
    native: {},
    quality: { warnings: [] },
  };
}

// A Usenet release as the Usenet source lists it, chosen for a step.
export function usenetCandidate({
  guid,
  title,
  album = title,
  downloadUrl = `https://indexer.test/${guid}.nzb`,
  indexerId = null,
}: {
  guid: string;
  title: string;
  album?: string;
  downloadUrl?: string;
  indexerId?: number | null;
}) {
  return {
    raw: {
      id: guid.toLowerCase(),
      title: album,
      artist: "Artist",
      data: { guid, title, downloadUrl, indexerId, indexer: null, score: 0 },
    },
    resolvedAlbumName: album,
    releaseVerified: false,
  };
}

type YtdlpResult = Awaited<
  ReturnType<ReturnType<typeof getDownloadClient<"ytdlp">>["search"]>
>[number];

export function ytdlpResult(overrides: Partial<YtdlpResult> & Pick<YtdlpResult, "id" | "title">) {
  const result = {
    url: `https://example.test/${overrides.id}`,
    channel: "Artist Name",
    durationSec: 1,
    liveStatus: "not_live",
    ...overrides,
  } satisfies YtdlpResult;
  return { ...result, artist: result.channel };
}

export function recordSourceFailures() {
  const reasons: string[] = [];
  return {
    reasons,
    helpers: {
      failOrTryNextSource: async (_payload: unknown, _job: unknown, reason: string) => {
        reasons.push(reason);
        return null;
      },
    },
  };
}

export function candidateFile(candidate: { raw?: unknown } | undefined) {
  assert.ok(candidate, "Expected a candidate");
  const { raw } = candidate;
  assert.ok(typeof raw === "object" && raw !== null && "file" in raw);
  assert.equal(typeof raw.file, "string");
  return String(raw.file);
}

export function usenetIndexer(id: number, name: string) {
  return {
    id,
    name,
    musicSearch: true,
    protocol: "usenet" as const,
    enabledInProwlarr: true,
    enabled: true,
    supportsSearch: true,
    priority: 25,
    categories: [3000],
  };
}

export function usenetRelease(release: {
  guid: string;
  title: string;
  downloadUrl: string;
  indexerId: number;
  size: number;
  categories: number[];
}) {
  return {
    files: null,
    grabs: null,
    indexer: null,
    publishDate: null,
    protocol: "usenet" as const,
    ...release,
  };
}

export function isStepFrom<Source extends PipelinePayload["source"]>(
  payload: PipelinePayload | null | undefined,
  source: Source,
): payload is PipelinePayload & { source: Source } {
  return payload?.source === source;
}

export function sourceless(payload: PipelinePayload | null | undefined) {
  assert.ok(payload && !payload.source, "Expected a step no source has taken yet");
  return payload;
}

export function stepFrom<Source extends PipelinePayload["source"]>(
  payload: PipelinePayload | null | undefined,
  source: Source,
) {
  assert.ok(isStepFrom(payload, source), `Expected a ${source} step`);
  return payload;
}

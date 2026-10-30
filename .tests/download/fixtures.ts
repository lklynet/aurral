import assert from "node:assert/strict";
import type { DownloadTracker } from "../../backend/services/downloadJobs/downloadTracker.ts";
import type { getDownloadClient } from "../../backend/services/download/downloadClientSettings.ts";

export function createTrackedJob(
  tracker: Pick<DownloadTracker, "addJob">,
  ...args: Parameters<DownloadTracker["addJob"]>
): string {
  const id = tracker.addJob(...args);
  assert.ok(id, "Expected the fixture to create a download job");
  return id;
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

type UsenetCandidate = NonNullable<
  Parameters<
    typeof import("../../backend/services/usenetOrchestrator.ts").processUsenetPipelinePayload
  >[0]["candidates"]
>[number];

export function usenetCandidate({
  raw,
  ...overrides
}: Partial<Omit<UsenetCandidate, "raw">> & {
  raw: Pick<UsenetCandidate["raw"], "release"> & Partial<Omit<UsenetCandidate["raw"], "release">>;
}): UsenetCandidate {
  return {
    score: 0,
    resolvedAlbumName: null,
    releaseAdmissible: true,
    scores: { artist: 100, track: 100, album: 100, year: 0, format: 0, size: 0 },
    ...overrides,
    raw: {
      file: raw.release.title ?? "",
      size: raw.release.size ?? 0,
      downloadUrl: raw.release.downloadUrl ?? "",
      indexerId: raw.release.indexerId,
      indexer: raw.release.indexer,
      guid: raw.release.guid,
      ...raw,
    },
  };
}

type YtdlpResult = Awaited<
  ReturnType<ReturnType<typeof getDownloadClient<"ytdlp">>["search"]>
>[number];

export function ytdlpResult(overrides: Partial<YtdlpResult> & Pick<YtdlpResult, "id" | "title">) {
  return {
    url: `https://example.test/${overrides.id}`,
    channel: "Artist Name",
    durationSec: 1,
    liveStatus: "not_live",
    ...overrides,
  } satisfies YtdlpResult;
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

import type { PipelinePayload } from "./downloadPipeline.ts";
import path from "path";
import { asAppError } from "../../lib/errors.ts";
import fs from "fs/promises";
import {
  downloadTracker,
  type DownloadJob,
  type HeldForReviewDraft,
  type JobFields,
  type PipelinePayload as TrackerPayload,
} from "./downloadJobs/downloadTracker.ts";
import { prowlarrClient } from "./prowlarrClient.ts";
import { getUsenetClient } from "./download/downloadClientSettings.ts";
import { logger } from "./logger.ts";
import {
  buildUsenetSearchQueries,
  isAudioFile,
  isProwlarrMusicQuery,
  rankUsenetReleases,
  selectRankedUsenetCandidates,
  type UsenetRelease,
  type UsenetSearchContext,
} from "./downloadJobs/usenetReleaseSearch.ts";
import { cacheSearchResults, getCachedSearchResults } from "./downloadJobs/searchResultCache.ts";
import { selectVerifiedDownloadedFile } from "./trackMatching/index.ts";
import { resolveDownloadRoot } from "./downloadPaths.ts";
import { getPathMappings, resolveLocalPath } from "./pathMappings.ts";
import {
  commitDownloadedFile,
  joinUnderRoot,
  buildTrackFileName,
  writeImportedFileMetadata,
} from "./downloadUtils.ts";
import { deferForInactiveOwner } from "./downloadJobs/playlistOwnerStatus.ts";
import {
  getPayloadCandidate,
  hasNextCandidate,
  buildNextCandidatePayload,
  mergeSearchResults,
  holdForReview,
  finalizePipelineJobSuccess,
} from "./pipelineHelpers.ts";
import {
  isPipelinePayloadActive,
  withPipelineCommitLock,
} from "./downloadJobs/downloadCancellation.ts";
import { getQualityProfile } from "./qualityProfileService.ts";
import { orderAdvertisedQualityCandidates } from "./qualityProfileModel.ts";
import { albumGrabJobs, deniedAlbumSources, finishAlbumGrab } from "./albumGrab.ts";
import { attemptTrackRequest } from "./releaseManifest.ts";
import { attemptRelease } from "./releaseResolver.ts";

const MIN_USENET_CANDIDATES = 2;
const MAX_DOWNLOAD_CANDIDATES = 5;
const MAX_TRACK_NZB_GRABS = 2;
const POLL_DELAY_SECONDS = 5;
const MAX_MISSING_POLLS = 60;
const UNREAD_POLL_DELAY_SECONDS = 30;
const MAX_UNREAD_POLLS = 60;

type NzbId = number | string;

interface UsenetHistoryItem {
  Status?: string | null;
  status?: string | null;
  FinalDir?: string | null;
  DestDir?: string;
  storage?: string | null;
  path?: string | null;
  folder?: string | null;
  dir?: string | null;
}

type UsenetJob = Pick<DownloadJob, "id"> &
  JobFields<
    | "status"
    | "upgradeForJobId"
    | "manualReplacementSearch"
    | "artistName"
    | "albumName"
    | "trackName"
    | "trackMbid"
    | "downloadSource"
    | "downloadClient"
    | "downloadClientId"
    | "releaseGuid"
    | "heldForReview"
  >;

type RankedRelease = ReturnType<typeof rankUsenetReleases>[number];

type UsenetCandidate = Pick<RankedRelease, "raw" | "score" | "scores" | "resolvedAlbumName"> & {
  releaseAdmissible: boolean;
  releaseVerified?: boolean;
};

type ResolvedTrack = ReturnType<typeof attemptTrackRequest> & { upgradeForJobId: string | null };

type ReleaseManifestOrNull = Awaited<ReturnType<typeof attemptRelease>>;

type QualityOptions = {
  profile: ReturnType<typeof getQualityProfile>;
  currentTier: string | null | undefined;
  upgrade: boolean;
};

type ValidationOptions = { manualSelection?: boolean; release?: ReleaseManifestOrNull };

type UsenetRemoveOptions = { deleteFiles?: boolean; historyItem?: UsenetHistoryItem | null };

interface UsenetPayload extends Omit<TrackerPayload, "candidates"> {
  jobId: string;
  phase: string;
  source?: string | null;
  albumGrab?: boolean;
  releaseMbid?: string | null;
  track?: Parameters<typeof attemptTrackRequest>[2];
  destination?: string | null;
  upgradeForJobId?: string | null;
  upgrade?: boolean;
  manualSelection?: boolean;
  manualDownloadClient?: string | null;
  downloadClient?: string | null;
  nzbId?: NzbId | null;
  nzbGrabs?: number;
  searchQueries?: string[] | null;
  searchQueryIndex?: number;
  searchError?: string | null;
  candidates?: UsenetCandidate[];
  candidateIndex?: number;
  pollAttempts?: number;
  missingPolls?: number;
  unreadPolls?: number;
  history?: UsenetHistoryItem | null;
  heldForReview?: HeldForReviewDraft | null;
  downloadedPath?: string | null;
}

type UsenetRemovePayload = Pick<
  UsenetPayload,
  "downloadClient" | "manualDownloadClient" | "nzbId" | "albumGrab"
>;

interface PipelineHelpers {
  failOrTryNextSource: (
    payload: UsenetPayload,
    job: UsenetJob,
    message: string,
    logDetails?: Record<string, number>,
  ) => PipelinePayload | null | Promise<PipelinePayload | null>;
}

interface PendingUpgrade {
  nzbId: Promise<NzbId | null>;
  settle: (nzbId: NzbId | null) => void;
  job: UsenetJob;
}

const isAutomaticUpgrade = (job: UsenetJob) =>
  Boolean(job?.upgradeForJobId) && !job.manualReplacementSearch;

// A job that is done with a shared download no longer counts as using it.
// A download being removed is retired, so no new track attaches to it while
// its jobs still point at it. Release-level album attempts stay isolated.
const releasedNzbs = new Set<string>();
const retiredNzbs = new Set<string>();
const MAX_RETIRED_NZBS = 1000;
const nzbKey = (clientKey: string, nzbId: NzbId | null | undefined) =>
  `${clientKey}\0${String(nzbId ?? "").trim()}`;

function retireNzb(key: string) {
  retiredNzbs.add(key);
  if (retiredNzbs.size > MAX_RETIRED_NZBS) retiredNzbs.delete(retiredNzbs.values().next().value!);
  for (const released of releasedNzbs) {
    if (released.endsWith(`\0${key}`)) releasedNzbs.delete(released);
  }
}

function trackedConsumers(clientKey: string, nzbId: NzbId | null | undefined) {
  const id = String(nzbId ?? "").trim();
  if (!id) return [];
  return downloadTracker.getAll().filter((entry: UsenetJob) => {
    if (
      !downloadTracker.hasPersistedJob(entry.id) ||
      releasedNzbs.has(`${entry.id}\0${nzbKey(clientKey, id)}`)
    )
      return false;
    const currentMatches =
      (entry.status === "downloading" || entry.status === "blocked") &&
      !downloadTracker.isInActiveAlbumGrab(entry.id) &&
      entry.downloadSource === "usenet" &&
      entry.downloadClient === clientKey &&
      String(entry.downloadClientId ?? "").trim() === id;
    const held = entry.heldForReview;
    const heldMatches =
      held?.source === "usenet" &&
      held.metadata?.downloadClient === clientKey &&
      String(held.transferId ?? "").trim() === id;
    return currentMatches || heldMatches;
  });
}

function consumersForNzb(
  clientKey: string,
  nzbId: NzbId | null | undefined,
  jobId: string | null = null,
) {
  const consumers = new Set(trackedConsumers(clientKey, nzbId).map((entry) => entry.id));
  if (jobId) consumers.add(jobId);
  return consumers;
}

function hasOtherNzbConsumers(clientKey: string, nzbId: NzbId | null | undefined, jobId: string) {
  return [...consumersForNzb(clientKey, nzbId, jobId)].some((id) => id !== jobId);
}

// Track-level jobs can independently rank the same album release. They share
// one client download by GUID, including duplicate requests for the same song.
// Album grabs remain separate because they own and judge the complete release.
const pendingTrackSubmissions = new Map<string, PendingUpgrade>();

function sharedTrackNzb(clientKey: string, release: UsenetRelease, job: UsenetJob) {
  const guid = String(release?.guid || "").trim();
  if (!guid) return null;
  const users = downloadTracker
    .getAll()
    .filter(
      (entry: UsenetJob) =>
        entry.id !== job.id &&
        downloadTracker.hasPersistedJob(entry.id) &&
        entry.status === "downloading" &&
        entry.downloadSource === "usenet" &&
        entry.downloadClient === clientKey &&
        entry.releaseGuid === guid &&
        entry.downloadClientId != null &&
        !downloadTracker.isInActiveAlbumGrab(entry.id) &&
        !retiredNzbs.has(nzbKey(clientKey, entry.downloadClientId)) &&
        !releasedNzbs.has(`${entry.id}\0${nzbKey(clientKey, entry.downloadClientId)}`),
    );
  const pending = pendingTrackSubmissions.get(`${clientKey}\0${guid}`);
  return { nzbId: users[0]?.downloadClientId ?? pending?.nzbId ?? null };
}

// Both clients drop the queue and history entry. With deleteFiles, Aurral also
// removes the completed folder unless that client's setting is off. A download
// another upgrade still reads is left to the last one.
// Both clients drop the queue and history entry. SABnzbd also deletes the
// job's files; NZBGet does with deleteFiles, unless its setting is off. A
// shared track download is left in place until its final consumer releases it.
async function removeUsenetItem(
  payload: UsenetRemovePayload,
  jobId: string,
  options: UsenetRemoveOptions = {},
) {
  const client = getUsenetClient(payload.downloadClient || payload.manualDownloadClient);
  const key = nzbKey(client.key, payload.nzbId);
  releasedNzbs.add(`${jobId}\0${key}`);
  if (payload.albumGrab !== true) {
    const consumers = consumersForNzb(client.key, payload.nzbId, jobId);
    consumers.delete(jobId);
    if (consumers.size > 0) return false;
  }
  retireNzb(key);
  for (const [entry, remove] of [
    ["queue", () => client.deleteQueueItem(payload.nzbId)],
    ["history", () => client.deleteHistoryItem(payload.nzbId, options)],
  ] as const) {
    await remove().catch((error) => {
      logger.warn("usenet", `Could not remove the ${client.key} ${entry} item`, {
        jobId,
        reason: error?.message || String(error),
      });
    });
  }
  return true;
}

export async function discardUsenetWork(payload: UsenetPayload) {
  if (payload.nzbId != null) await removeUsenetItem(payload, payload.jobId, { deleteFiles: true });
}

// A song held for review keeps its release until it is approved, denied, or removed.
export async function removeReviewedUsenetDownload(
  job: Pick<UsenetJob, "id" | "downloadSource" | "downloadClient"> & {
    downloadClientId?: NzbId | null;
  },
) {
  if (job?.downloadSource !== "usenet" || !job.downloadClientId) return;
  return removeUsenetItem(
    { downloadClient: job.downloadClient, nzbId: job.downloadClientId },
    job.id,
    { deleteFiles: true },
  );
}

export function shouldPreserveReviewedUsenetSource(job: UsenetJob | null | undefined) {
  if (job?.downloadSource !== "usenet" || !job.downloadClientId || !job.id) return false;
  const client = getUsenetClient(job.downloadClient);
  return hasOtherNzbConsumers(client.key, job.downloadClientId, job.id);
}

const RELEASE_RESET = Object.freeze({
  nzbId: null,
  history: null,
  missingPolls: 0,
  unreadPolls: 0,
});

const hasNextRelease = (payload: UsenetPayload) =>
  hasNextCandidate(payload) &&
  (payload.albumGrab === true || Number(payload.nzbGrabs || 0) < MAX_TRACK_NZB_GRABS);
const withNzbGrab = (payload: UsenetPayload) => ({
  ...payload,
  nzbGrabs: Number(payload.nzbGrabs || 0) + 1,
});

// A release that failed or held no matching file is blocked for every track
// it was meant to fill.
function blockRelease(payload: UsenetPayload, job: UsenetJob) {
  const guid = String(getPayloadCandidate(payload)?.raw?.release?.guid || "").trim();
  if (!guid) return;
  const jobs = payload.albumGrab === true ? albumGrabJobs(payload) : [job];
  for (const entry of jobs) downloadTracker.recordDeniedSource(entry.id, "usenet", guid);
}

function hasEnoughCandidates(
  aggregated: UsenetRelease[],
  resolvedTrack: UsenetSearchContext,
  qualityOptions: QualityOptions,
  albumGrab: boolean,
) {
  const ranked = rankUsenetReleases(aggregated, resolvedTrack).filter(
    (entry) => entry.releaseAdmissible && (!albumGrab || entry.resolvedAlbumName),
  );
  return (
    orderAdvertisedQualityCandidates(ranked, {
      ...qualityOptions,
      readName: (entry) => entry?.raw?.release?.title,
    }).length >= MIN_USENET_CANDIDATES
  );
}

function classifyHistoryStatus(item: UsenetHistoryItem) {
  const status = String(item?.Status || item?.status || "").toUpperCase();
  if (!status) return "pending";
  if (
    status.startsWith("SUCCESS") ||
    status.startsWith("WARNING") ||
    status.startsWith("COMPLETED")
  ) {
    return "success";
  }
  if (status.startsWith("FAILED") || status.startsWith("FAILURE") || status.startsWith("DELETED")) {
    return "failed";
  }
  return "pending";
}

async function findAudioFilesRecursive(root: string, depth = 0, matches: string[] = []) {
  if (depth > 7) return matches;
  let entries = [];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return matches;
  }
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isFile() && isAudioFile(fullPath)) {
      matches.push(fullPath);
    }
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = entry.name.toLowerCase();
    if (name === "__macosx" || name === ".sync" || name === ".DS_Store") {
      continue;
    }
    await findAudioFilesRecursive(path.join(root, entry.name), depth + 1, matches);
  }
  return matches;
}

function uniqueResolvedPaths(values: (string | null | undefined)[], source: string) {
  const seen = new Set();
  const out = [];
  const mappings = getPathMappings(source);
  for (const value of values) {
    const raw = String(value || "").trim();
    if (!raw) continue;
    const resolved = path.resolve(resolveLocalPath(raw, mappings));
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  return out;
}

export async function collectDownloadedAudioFiles(
  historyItem: UsenetHistoryItem | null | undefined,
  preferredClient: string | null = null,
) {
  const clientKey = getUsenetClient(preferredClient).key;
  const roots = uniqueResolvedPaths(
    [
      historyItem?.FinalDir,
      historyItem?.DestDir,
      historyItem?.storage,
      historyItem?.path,
      historyItem?.folder,
      historyItem?.dir,
    ],
    clientKey,
  );
  const files = [];
  for (const root of roots) {
    const stat = await fs.stat(root).catch(() => null);
    if (stat?.isFile() && isAudioFile(root)) {
      files.push(root);
      continue;
    }
    if (stat?.isDirectory()) {
      files.push(...(await findAudioFilesRecursive(root)));
    }
  }
  return uniqueResolvedPaths(files, clientKey);
}

async function validateDownloadedRelease(
  audioFilePaths: string[],
  candidate: UsenetCandidate | null | undefined,
  resolvedTrack: ResolvedTrack,
  options: ValidationOptions = {},
) {
  return selectVerifiedDownloadedFile({
    request: resolvedTrack,
    filePaths: audioFilePaths,
    candidate,
    source: "usenet",
    options,
  });
}

const releaseKey = (release: UsenetRelease) =>
  [release.guid, release.downloadUrl, release.indexerId, release.title]
    .map((entry) =>
      String(entry || "")
        .trim()
        .toLowerCase(),
    )
    .join("\0");

// One Prowlarr query per pipeline step, so a slow indexer never holds the
// pipeline for the whole search plan.
async function advanceUsenetSearch(
  payload: UsenetPayload,
  queries: string[],
  enough: (results: UsenetRelease[]) => boolean,
  runQuery: (query: string) => Promise<UsenetRelease[]>,
) {
  const aggregated: UsenetRelease[] = [];
  const seen = new Set();
  let index = Number(payload.searchQueryIndex || 0);
  for (let queryIndex = 0; queryIndex < index; queryIndex += 1) {
    const cached = getCachedSearchResults("usenet", queries[queryIndex]);
    if (!cached) {
      index = queryIndex;
      break;
    }
    mergeSearchResults(aggregated, seen, cached, releaseKey);
  }
  let searchError = payload.searchError || "";
  let searched = false;
  while (index < queries.length && !enough(aggregated)) {
    if (searched) {
      return { payload: { ...payload, searchQueryIndex: index, searchError, delaySeconds: 0 } };
    }
    const query = queries[index];
    let releases = getCachedSearchResults("usenet", query);
    if (!releases) {
      searched = true;
      try {
        releases = await runQuery(query);
        cacheSearchResults("usenet", query, releases);
      } catch (error) {
        searchError = asAppError(error)?.message || String(error);
        logger.warn("usenet", "Prowlarr search failed", {
          jobId: payload.jobId,
          query,
          error: searchError,
        });
        releases = [];
        cacheSearchResults("usenet", query, releases);
      }
    }
    mergeSearchResults(aggregated, seen, releases, releaseKey);
    index += 1;
  }
  return { aggregated, queryCount: index, searchError };
}

async function handleUsenetSearch(payload: UsenetPayload, helpers: PipelineHelpers) {
  const job = downloadTracker.getJob(payload.jobId);
  if (!job) return null;
  if (job.status === "failed" || job.status === "done") return null;
  if (!payload.searchQueries) {
    downloadTracker.setDownloading(job.id);
    downloadTracker.updateDownloadMetadata(job.id, {
      downloadSource: "usenet",
    });
    import("./aurralHistoryService.ts")
      .then(({ recordTrackJobSearching }) => recordTrackJobSearching(job))
      .catch((err) => {
        console.warn(err);
      });
  }

  const release = await attemptRelease(payload, job);
  const resolvedTrack = {
    ...attemptTrackRequest(job, release, payload.track),
    upgradeForJobId: payload.upgradeForJobId || null,
  };
  const qualityOptions = {
    profile: getQualityProfile(),
    currentTier: payload.upgradeForJobId
      ? downloadTracker.getJob(payload.upgradeForJobId)?.qualityTier
      : null,
    upgrade: payload.upgrade === true,
  };
  const albumGrab = payload.albumGrab === true;
  const albumJobs = albumGrab ? albumGrabJobs(payload) : [];
  const compilation = albumGrab && release?.compilation === true;
  const indexers = await prowlarrClient.getEnabledUsenetIndexers().catch(() => []);
  const musicIndexers = indexers.filter((indexer) => indexer.musicSearch);
  const searchContext = {
    ...resolvedTrack,
    compilation,
    releaseTracks: albumGrab ? release?.tracks : undefined,
  };
  const queries =
    payload.searchQueries ||
    buildUsenetSearchQueries(searchContext, { musicSearch: musicIndexers.length > 0, albumGrab });
  const runQuery = (query: string) =>
    isProwlarrMusicQuery(query)
      ? prowlarrClient.search(query, { type: "music", indexers: musicIndexers })
      : prowlarrClient.search(query);
  const deniedSourceGuidSet = deniedAlbumSources([job, ...albumJobs], "usenet");
  const allowed = (releases: UsenetRelease[]) =>
    releases.filter(
      (release: UsenetRelease) =>
        !deniedSourceGuidSet.has(
          String(release.guid || "")
            .trim()
            .toLowerCase(),
        ),
    );
  const step = await advanceUsenetSearch(
    { ...payload, searchQueries: queries },
    queries,
    (results) => hasEnoughCandidates(allowed(results), searchContext, qualityOptions, albumGrab),
    runQuery,
  );
  if (!isPipelinePayloadActive(payload)) return null;
  if (step.payload) return step.payload;
  const aggregated = allowed(step.aggregated);
  const lastError = step.searchError;
  const queryCount = step.queryCount;
  const ranked = rankUsenetReleases(aggregated, searchContext);
  const filteredRanked =
    deniedSourceGuidSet.size > 0
      ? ranked.filter(
          (entry) =>
            !deniedSourceGuidSet.has(
              String(entry?.raw?.guid || "")
                .trim()
                .toLowerCase(),
            ),
        )
      : ranked;
  const qualityRanked = orderAdvertisedQualityCandidates(
    filteredRanked.filter(
      (entry) => entry.releaseAdmissible && (payload.albumGrab !== true || entry.resolvedAlbumName),
    ),
    {
      ...qualityOptions,
      readName: (entry) => entry?.raw?.release?.title,
    },
  );
  const candidates = selectRankedUsenetCandidates(qualityRanked, MAX_DOWNLOAD_CANDIDATES).map(
    (entry) => ({
      raw: entry.raw,
      score: entry.score,
      scores: entry.scores,
      resolvedAlbumName: entry.resolvedAlbumName,
      releaseAdmissible: entry.releaseAdmissible === true,
      // A release title cannot show the tracklist, so the download is judged
      // against the release before anything is imported.
      ...(albumGrab ? { releaseVerified: false } : {}),
    }),
  );
  if (candidates.length === 0) {
    const message =
      lastError && aggregated.length === 0
        ? `Prowlarr search failed: ${lastError}`
        : "No suitable Usenet search results";
    return helpers.failOrTryNextSource(payload, job, message, {
      queryCount,
      rawResultCount: aggregated.length,
      rankedCount: ranked.length,
    });
  }
  return {
    ...payload,
    searchQueries: null,
    searchQueryIndex: 0,
    searchError: null,
    phase: "download",
    source: "usenet",
    candidates,
    candidateIndex: 0,
    nzbGrabs: 0,
    resolvedTrack,
  };
}

async function handleUsenetDownload(payload: UsenetPayload, helpers: PipelineHelpers) {
  const job = downloadTracker.getJob(payload.jobId);
  if (!job) return null;
  if (job.status === "failed" || job.status === "done") return null;
  const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
  const index = Number(payload.candidateIndex || 0);
  const candidate = candidates[index];
  const release = candidate?.raw?.release;
  if (!release?.downloadUrl) {
    return helpers.failOrTryNextSource(payload, job, "No Usenet release URL available");
  }
  import("./aurralHistoryService.ts")
    .then(({ recordTrackJobDownloading }) => recordTrackJobDownloading(job))
    .catch((err) => {
      console.warn(err);
    });

  const indexerClient = prowlarrClient.getIndexerDownloadClient(release.indexerId);
  const client = getUsenetClient(indexerClient ?? payload.manualDownloadClient);
  const clientKey = client.key;
  const releaseMetadata = {
    downloadSource: "usenet",
    downloadClient: clientKey,
    releaseGuid: release.guid,
    releaseTitle: release.title,
    indexerId: release.indexerId,
    indexerName: release.indexer,
    remoteUsername: release.indexer,
    remoteFilename: release.title,
  };
  const pollPayload = (nzbId: NzbId) => ({
    ...payload,
    phase: "poll",
    source: "usenet",
    downloadClient: clientKey,
    nzbId,
    candidate,
    candidateIndex: index,
    pollAttempts: 0,
    missingPolls: 0,
    unreadPolls: 0,
  });
  const shareable = payload.albumGrab !== true && Boolean(String(release.guid || "").trim());
  const submissionKey = `${clientKey}\0${String(release.guid || "").trim()}`;
  let claimed: PendingUpgrade | null = null;
  let sharedNzbId: NzbId | null = null;
  // Checking for a shared download and claiming the submission happen in one
  // synchronous step, so one waiter at a time takes over a failed submission.
  while (shareable && sharedNzbId == null && !claimed) {
    const shared = sharedTrackNzb(clientKey, release, job);
    if (shared?.nzbId == null) {
      let settle!: (nzbId: NzbId | null) => void;
      const nzbId = new Promise<NzbId | null>((resolve) => {
        settle = resolve;
      });
      claimed = { nzbId, settle, job };
      pendingTrackSubmissions.set(submissionKey, claimed);
    } else {
      const sharedId = await shared.nzbId;
      if (!retiredNzbs.has(nzbKey(clientKey, sharedId))) sharedNzbId = sharedId;
    }
  }
  if (sharedNzbId != null) {
    if (!isPipelinePayloadActive(payload)) return null;
    downloadTracker.updateDownloadMetadata(job.id, {
      ...releaseMetadata,
      downloadClientId: sharedNzbId,
    });
    return pollPayload(sharedNzbId);
  }
  let submission;
  try {
    if (indexerClient && !client.isConfigured()) throw new Error(`${client.name} is not set up`);
    const nzb = await prowlarrClient.downloadNzb(release.downloadUrl, release);
    payload = withNzbGrab(payload);
    if (!isPipelinePayloadActive(payload)) return null;
    submission = await withPipelineCommitLock(payload, async () => {
      const appended = await client.appendNzb({
        name: release.title,
        content: nzb,
        dupeKey: `aurral-${job.id}`,
        dupeScore: Number(candidate.score || 0),
      });
      downloadTracker.updateDownloadMetadata(job.id, {
        ...releaseMetadata,
        downloadClientId: appended.nzbId,
      });
      // Client IDs can be reused after an earlier item was removed. A
      // successful append establishes a new item that may be shared again.
      retiredNzbs.delete(nzbKey(clientKey, appended.nzbId));
      return appended;
    });
  } catch (error) {
    const failure = asAppError(error);
    if (failure && "nzbGrabSpent" in failure && failure.nzbGrabSpent) {
      payload = withNzbGrab(payload);
    }
    const message = failure?.message || String(error);
    logger.warn("usenet", "Usenet release could not be sent to the download client", {
      jobId: job.id,
      client: clientKey,
      releaseTitle: release.title,
      error: message,
    });
    if (hasNextRelease(payload)) return buildNextCandidatePayload(payload, RELEASE_RESET);
    return helpers.failOrTryNextSource(payload, job, message);
  } finally {
    if (claimed) {
      if (pendingTrackSubmissions.get(submissionKey) === claimed)
        pendingTrackSubmissions.delete(submissionKey);
      claimed.settle(submission?.result?.nzbId ?? null);
    }
  }
  if (submission.cancelled || !isPipelinePayloadActive(payload)) return null;
  if (isAutomaticUpgrade(job) && payload.albumGrab === true)
    retireNzb(nzbKey(clientKey, submission.result.nzbId));
  return pollPayload(submission.result.nzbId);
}

async function handleUsenetPoll(payload: UsenetPayload, helpers: PipelineHelpers) {
  const job = downloadTracker.getJob(payload.jobId);
  if (!job) return null;
  if (job.status === "failed" || job.status === "done") return null;
  const pollAttempts = Number(payload.pollAttempts || 0) + 1;
  const client = getUsenetClient(payload.downloadClient || payload.manualDownloadClient);
  let historyItem;
  let queueItem = null;
  try {
    historyItem = await client.getHistoryItem(payload.nzbId);
    if (!historyItem) queueItem = await client.getQueueItem(payload.nzbId);
  } catch (error) {
    // The download keeps going in the client while Aurral cannot read it,
    // so a client outage waits instead of ending the download.
    const unreadPolls = Number(payload.unreadPolls || 0) + 1;
    if (unreadPolls > MAX_UNREAD_POLLS) throw error;
    logger.warn("usenet", "Could not read the Usenet download; waiting", {
      jobId: job.id,
      nzbId: payload.nzbId,
      error: asAppError(error)?.message || String(error),
    });
    return {
      ...payload,
      phase: "poll",
      delaySeconds: UNREAD_POLL_DELAY_SECONDS,
      pollAttempts,
      unreadPolls,
    };
  }
  if (historyItem) {
    const state = classifyHistoryStatus(historyItem);
    logger.debug("slskd", "usenet poll history status", {
      state,
      raw: historyItem?.Status || historyItem?.status,
      nzbId: payload.nzbId,
    });
    if (state === "success") {
      return {
        ...payload,
        phase: "finalize",
        history: historyItem,
        pollAttempts,
      };
    }
    if (state === "failed") {
      await removeUsenetItem(payload, job.id, { deleteFiles: true, historyItem });
      blockRelease(payload, job);
      if (hasNextRelease(payload)) return buildNextCandidatePayload(payload, RELEASE_RESET);
      return helpers.failOrTryNextSource(
        payload,
        job,
        `Usenet download failed: ${historyItem.Status || historyItem.status || "failed"}`,
      );
    }
  }
  // A queued, paused, slow, or post-processing download keeps waiting like it
  // would in Lidarr. Only a download that left both the queue and the history
  // moves on.
  const present = Boolean(historyItem) || Boolean(queueItem);
  const missingPolls = present ? 0 : Number(payload.missingPolls || 0) + 1;
  if (missingPolls > MAX_MISSING_POLLS) {
    if (hasNextRelease(payload)) return buildNextCandidatePayload(payload, RELEASE_RESET);
    return helpers.failOrTryNextSource(
      payload,
      job,
      "The Usenet download left the download client",
    );
  }
  return {
    ...payload,
    phase: "poll",
    delaySeconds: POLL_DELAY_SECONDS,
    pollAttempts,
    missingPolls,
    unreadPolls: 0,
  };
}

async function handleUsenetFinalize(payload: UsenetPayload, helpers: PipelineHelpers) {
  const job = downloadTracker.getJob(payload.jobId);
  if (!job) return null;
  if (job.status === "failed" || job.status === "done") return null;
  const candidate = getPayloadCandidate(payload);
  const client = getUsenetClient(payload.downloadClient || payload.manualDownloadClient);
  const historyItem = payload.history || (await client.getHistoryItem(payload.nzbId));
  if (payload.albumGrab === true) {
    const filePaths = await collectDownloadedAudioFiles(
      historyItem,
      payload.downloadClient || payload.manualDownloadClient,
    );
    const next = await finishAlbumGrab(payload, {
      filePaths,
      source: "usenet",
      album: candidate?.resolvedAlbumName,
      resetFields: RELEASE_RESET,
    });
    await removeUsenetItem(payload, job.id, { deleteFiles: true, historyItem });
    return next;
  }
  const release = await attemptRelease(payload, job);
  const resolvedTrack = {
    ...attemptTrackRequest(job, release, payload.track),
    upgradeForJobId: payload.upgradeForJobId || null,
  };
  const audioFiles = await collectDownloadedAudioFiles(
    historyItem,
    payload.downloadClient || payload.manualDownloadClient,
  );
  const found = await validateDownloadedRelease(audioFiles, candidate, resolvedTrack, {
    manualSelection: payload.manualSelection === true,
    release,
  });
  if (!isPipelinePayloadActive(payload)) {
    await removeUsenetItem(payload, job.id, { deleteFiles: true, historyItem });
    return null;
  }
  // A file worth a review keeps its download while the other releases and
  // sources are tried, as every other source does.
  if (found.filePath && found.validation?.blocked && !payload.heldForReview) {
    const heldPayload = {
      ...payload,
      heldForReview: holdForReview(job, {
        source: "usenet",
        sourcePath: found.filePath,
        reason: found.validation.reason,
        transferId: payload.nzbId,
      }),
    };
    return hasNextRelease(payload)
      ? buildNextCandidatePayload(heldPayload, RELEASE_RESET)
      : helpers.failOrTryNextSource(heldPayload, job, heldPayload.heldForReview.reason);
  }
  if (!found.filePath || found.validation?.blocked) {
    const reason =
      found.validation?.reason || "Usenet download completed, but no matching audio file was found";
    await removeUsenetItem(payload, job.id, { deleteFiles: true, historyItem });
    if (audioFiles.length > 0) blockRelease(payload, job);
    if (hasNextRelease(payload)) return buildNextCandidatePayload(payload, RELEASE_RESET);
    return helpers.failOrTryNextSource(payload, job, reason);
  }

  const playlistRoot = resolveDownloadRoot();
  const destination = String(payload.destination || "").trim();
  const ext = path.extname(found.filePath).toLowerCase();
  const finalDir = joinUnderRoot(playlistRoot, destination);
  const finalName = buildTrackFileName(job, ext || ".mp3");
  const finalPath = path.join(finalDir, finalName);
  const inactiveOwner = deferForInactiveOwner(payload, job);
  if (inactiveOwner) return inactiveOwner;
  const committed = await withPipelineCommitLock(payload, async () => {
    import("./aurralHistoryService.ts")
      .then(({ recordTrackJobMoving }) => recordTrackJobMoving(job))
      .catch((err) => {
        console.warn(err);
      });
    const preserveSource = hasOtherNzbConsumers(client.key, payload.nzbId, job.id);
    // Once the last consumer commits, no later job may attach to a source
    // that this operation is about to move away.
    if (!preserveSource) retireNzb(nzbKey(client.key, payload.nzbId));
    const committedFinalPath = await commitDownloadedFile(found.filePath!, finalPath, {
      preserveSource,
    });
    await writeImportedFileMetadata(committedFinalPath, resolvedTrack, {
      source: "usenet",
      jobId: job.id,
    });
    return finalizePipelineJobSuccess({
      downloadTracker,
      job,
      committedFinalPath,
      album: candidate?.resolvedAlbumName,
      quality: found.validation?.quality,
    });
  });
  if (committed.cancelled) {
    return null;
  }
  await removeUsenetItem(payload, job.id, { deleteFiles: true, historyItem });
  return committed.result;
}

export async function processUsenetPipelinePayload(
  payload: UsenetPayload,
  helpers: PipelineHelpers,
): Promise<PipelinePayload | null> {
  logger.debug("slskd", "usenet pipeline phase", {
    phase: payload.phase,
    jobId: payload.jobId,
    source: payload.source,
  });
  if (!isPipelinePayloadActive(payload)) return null;
  switch (payload.phase) {
    case "search":
      return handleUsenetSearch(payload, helpers);
    case "download":
      return handleUsenetDownload(payload, helpers);
    case "poll":
      return handleUsenetPoll(payload, helpers);
    case "finalize":
      return handleUsenetFinalize(payload, helpers);
    default:
      throw new Error(`Unknown Usenet pipeline phase: ${payload.phase}`);
  }
}

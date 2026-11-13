import {
  registerDownloadProviderWork,
  clearDownloadProviderWork,
} from "./downloadJobs/downloadCancellation.ts";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getDownloadClient } from "./download/downloadClientSettings.ts";
import { getDownloadSourceStatus, getEnabledDownloadSources } from "./downloadSourceService.ts";
import { downloadTracker, type DownloadJob } from "./downloadJobs/downloadTracker.ts";
import type { JsonObject } from "./jobs/queue.ts";
import { contractSource } from "./download/nativeSources.ts";
import { albumQuery, isSourceContractId, resolveTrack } from "./download/sourcePipeline.ts";
import type { DownloadSource } from "./download/downloadSource.ts";

const SESSION_TTL_MS = 10 * 60 * 1000;
const MAX_RESULTS = 100;
const MAX_SESSIONS = 250;
const sessions = new Map<string, ManualSearchSession>();
const AUDIO_EXTENSIONS = new Set([
  ".aac",
  ".aiff",
  ".alac",
  ".ape",
  ".flac",
  ".m4a",
  ".mp3",
  ".ogg",
  ".opus",
  ".wav",
  ".wma",
]);

type ManualSearchMode = "missing" | "replacement";
type ManualSource = { id: string; label: string; source: string };
type ManualSearchJob = Pick<DownloadJob, "id"> &
  Partial<Pick<DownloadJob, "artistName" | "trackName" | "albumName">>;
type ManualWorkContext = { jobId: string; playlistId: string | null };
type RawSearchResult = JsonObject;
type ManualResult = Awaited<ReturnType<typeof searchSource>>[number];
type ManualSearchSession = {
  actorId: string;
  jobId: string;
  mode: ManualSearchMode;
  playlistId: string;
  sourceId: string | undefined;
  results: Map<string, ManualResult["selection"]>;
  expiresAt: number;
};

function text(value: unknown) {
  return String(value ?? "").trim();
}

function buildQuery(job: ManualSearchJob) {
  return [job?.artistName, job?.trackName, job?.albumName].map(text).filter(Boolean).join(" ");
}

function pruneSessions(now = Date.now()) {
  for (const [id, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(id);
  }
}

function formatBytes(value: unknown) {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let amount = bytes;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount >= 10 || unit === 0 ? Math.round(amount) : amount.toFixed(1)} ${units[unit]}`;
}

function formatDuration(value: unknown) {
  const seconds = Number(value || 0);
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

function fileFormat(filename: unknown) {
  return path.extname(text(filename)).replace(/^\./, "").toUpperCase();
}

function resultView(source: string, raw: Record<string, unknown>) {
  if (source === "slskd") {
    const normalizedFile = text(raw.file).replace(/\\/g, "/");
    const parent = normalizedFile.includes("/")
      ? normalizedFile.slice(0, normalizedFile.lastIndexOf("/"))
      : "";
    return {
      title: path.basename(normalizedFile) || "Untitled file",
      subtitle: [text(raw.user), parent].filter(Boolean).join(" · "),
      details: [
        fileFormat(raw.file),
        raw.bitrate ? `${raw.bitrate} kbps` : "",
        formatDuration(raw.length),
        formatBytes(raw.size),
        Number(raw.slots) > 0 ? "Free slot" : "Queued",
        Number(raw.speed) > 0 ? `${formatBytes(raw.speed)}/s` : "",
      ].filter(Boolean),
    };
  }
  if (source === "deemix") {
    return {
      title: text(raw.title) || "Untitled track",
      subtitle: [text(raw.artist), text(raw.album)].filter(Boolean).join(" · "),
      details: [formatDuration(raw.durationSec), "Deezer"].filter(Boolean),
    };
  }
  if (isSourceContractId(source)) {
    return {
      title: text(raw.title) || "Untitled result",
      subtitle: [text(raw.artist), text(raw.album), text(raw.year)].filter(Boolean).join(" · "),
      details: [
        text(raw.format).toUpperCase(),
        raw.bitrate ? `${text(raw.bitrate)} kbps` : "",
        formatDuration(Number(raw.durationMs) / 1000),
        raw.trackCount ? `${text(raw.trackCount)} tracks` : "",
      ].filter(Boolean),
    };
  }
  return { title: text(raw.title) || "Untitled result", subtitle: "", details: [] };
}

const manualResults = <Source extends string, Raw extends RawSearchResult>(
  source: Source,
  results: Raw[],
) => results.map((raw) => ({ raw, selection: { source, candidate: { raw } } }));

async function searchSlskd(query: string, workContext: ManualWorkContext) {
  const results = await getDownloadClient("slskd").searchQuery(query, {
    fileLimit: 5000,
    responseLimit: 250,
    timeoutMs: 120000,
    emptyTimeoutMs: 120000,
    gracePeriodMs: 0,
    cleanupTimeoutMs: 20000,
    onSearchCreated: (id: string) =>
      registerDownloadProviderWork({ ...workContext, provider: "slskd-search", workId: id }),
    onSearchSettled: (id: string) =>
      clearDownloadProviderWork({ provider: "slskd-search", workId: id }),
  });
  return results.filter((entry: RawSearchResult) => {
    if (entry?.locked === true) return false;
    return AUDIO_EXTENSIONS.has(path.extname(text(entry?.file)).toLowerCase());
  });
}

// A track source lists the results for the track, and an album source the
// albums that hold it.
async function searchContractSource(source: DownloadSource, jobId: string) {
  const job = downloadTracker.getJob(jobId);
  if (!job) throw new Error("This track is no longer tracked");
  if (source.tracks) {
    const track = resolveTrack({}, job);
    const found = await (source.tracks.manualSearch?.(track) ??
      source.tracks.search(track, { upgrade: null, denied: new Set() }));
    return found.map((raw) => ({ raw, selection: { source: source.id, candidate: { raw } } }));
  }
  if (!source.albums) return [];
  const album = await albumQuery({}, job);
  const track = resolveTrack({}, job);
  const found = await (source.albums.manualSearch?.(album, track) ??
    source.albums.search(album, { upgrade: null, track, denied: new Set() }));
  return found.map((raw) => ({
    raw,
    selection: {
      source: source.id,
      candidate: { raw, resolvedAlbumName: raw.title, releaseVerified: false },
    },
  }));
}

async function searchSource(source: string, query: string, workContext: ManualWorkContext) {
  if (source === "slskd") return manualResults(source, await searchSlskd(query, workContext));
  if (source === "deemix") {
    const found = await getDownloadClient("deemix").search(query, { limit: 50 });
    return manualResults(
      source,
      found.filter((entry) => entry?.readable !== false),
    );
  }
  const contract = contractSource(source);
  if (contract) return searchContractSource(contract, workContext.jobId);
  throw new Error("Unknown manual search source");
}

export function getManualDownloadSources() {
  const status = getDownloadSourceStatus();
  const sources: ManualSource[] = [];
  if (status.slskd.configured) sources.push({ id: "slskd", label: "Soulseek", source: "slskd" });
  if (status.deemix.configured) sources.push({ id: "deemix", label: "deemix", source: "deemix" });
  for (const { id, label } of getEnabledDownloadSources()) {
    if (contractSource(id)) sources.push({ id, label, source: id });
  }
  return sources;
}

export async function createManualMissingSearch({
  job,
  sourceId,
  actorId,
  mode = "missing",
  playlistId = null,
}: {
  job: ManualSearchJob;
  sourceId: string;
  actorId: string | number;
  mode?: ManualSearchMode;
  playlistId?: string | null;
}) {
  pruneSessions();
  const sourceOption = getManualDownloadSources().find((entry) => entry.id === text(sourceId));
  if (!sourceOption) throw new Error("That download client is not currently available");
  const query = buildQuery(job);
  if (!query) throw new Error("This track has no searchable artist or title");
  const found = await searchSource(sourceOption.source, query, { jobId: job.id, playlistId });
  return storeManualMissingSearch({
    jobId: job.id,
    actorId,
    mode,
    playlistId,
    sourceOption,
    query,
    found,
  });
}

export function storeManualMissingSearch({
  jobId,
  actorId,
  mode = "missing",
  playlistId = null,
  sourceOption,
  query,
  found,
}: {
  jobId: string;
  actorId: string | number;
  mode?: ManualSearchMode;
  playlistId?: string | null;
  sourceOption: ManualSource;
  query: string;
  found: ManualResult[];
}) {
  pruneSessions();
  while (sessions.size >= MAX_SESSIONS) {
    sessions.delete(sessions.keys().next().value!);
  }
  const storedResults = new Map<string, ManualResult["selection"]>();
  const source = text(sourceOption?.source);
  const results = found.slice(0, MAX_RESULTS).map(({ raw, selection }) => {
    const resultId = randomUUID();
    storedResults.set(resultId, selection);
    return { id: resultId, ...resultView(source, raw) };
  });
  const sessionId = randomUUID();
  sessions.set(sessionId, {
    actorId: text(actorId),
    jobId: text(jobId),
    mode: mode === "replacement" ? "replacement" : "missing",
    playlistId: text(playlistId),
    sourceId: sourceOption?.id,
    results: storedResults,
    expiresAt: Date.now() + SESSION_TTL_MS,
  });
  return { sessionId, source: sourceOption, query, results, expiresInMs: SESSION_TTL_MS };
}

export function getManualMissingSelection({
  sessionId,
  resultId,
  jobId,
  actorId,
}: {
  sessionId: string;
  resultId: string;
  jobId: string;
  actorId: string | number;
}) {
  pruneSessions();
  const session = sessions.get(text(sessionId));
  if (!session || session.jobId !== text(jobId) || session.actorId !== text(actorId)) {
    throw new Error("This manual search has expired. Search again to refresh the results.");
  }
  const selection = session.results.get(text(resultId));
  if (!selection) throw new Error("That search result is no longer available");
  return {
    ...selection,
    sourceId: session.sourceId,
    mode: session.mode,
    playlistId: session.playlistId || null,
  };
}

export function consumeManualMissingSelection(sessionId: string) {
  return sessions.delete(text(sessionId));
}

export function clearManualMissingSearchSessions() {
  sessions.clear();
}

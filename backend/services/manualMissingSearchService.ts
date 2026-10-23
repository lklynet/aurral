import {
  registerDownloadProviderWork,
  clearDownloadProviderWork,
} from "./downloadJobs/downloadCancellation.ts";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getDownloadClient } from "./download/downloadClientSettings.ts";
import { USENET_CLIENT_KEYS } from "./usenetClientCommon.ts";
import { getDownloadSourceStatus } from "./downloadSourceService.ts";
import { prowlarrClient } from "./prowlarrClient.ts";
import type { DownloadJob } from "./downloadJobs/downloadTracker.ts";
import type { HonkerPayload } from "./honkerDb.ts";

const SESSION_TTL_MS = 10 * 60 * 1000;
const MAX_RESULTS = 100;
const MAX_SESSIONS = 250;
const sessions = new Map<string, ManualSearchSession>();
const YTDLP_LIVE_STATUSES = new Set(["is_live", "was_live", "post_live", "is_upcoming"]);
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
type ManualSource = { id: string; label: string; source: string; downloadClient?: string };
type ManualSearchJob = Pick<DownloadJob, "id"> &
  Partial<Pick<DownloadJob, "artistName" | "trackName" | "albumName">>;
type ManualWorkContext = { jobId: string; playlistId: string | null };
type RawSearchResult = HonkerPayload;
type StoredCandidate = ReturnType<typeof toStoredCandidate>;
type ManualSearchSession = {
  actorId: string;
  jobId: string;
  mode: ManualSearchMode;
  playlistId: string;
  source: string;
  sourceId: string | undefined;
  downloadClient: string | null;
  results: Map<string, StoredCandidate>;
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

function isYtdlpLiveResult(result: RawSearchResult | null | undefined) {
  return YTDLP_LIVE_STATUSES.has(text(result?.liveStatus).toLowerCase());
}

function resultView(source: string, raw: RawSearchResult) {
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
  if (source === "ytdlp") {
    return {
      title: text(raw.title) || "Untitled video",
      subtitle: text(raw.channel),
      details: [formatDuration(raw.durationSec), "YouTube"].filter(Boolean),
    };
  }
  return {
    title: text(raw.title) || "Untitled release",
    subtitle: text(raw.indexer),
    details: [
      formatBytes(raw.size),
      raw.files ? `${raw.files} files` : "",
      raw.grabs ? `${raw.grabs} grabs` : "",
      typeof raw.publishDate === "string" && raw.publishDate
        ? new Date(raw.publishDate).toLocaleDateString("en-GB")
        : "",
    ].filter(Boolean),
  };
}

function toStoredCandidate(source: string, raw: RawSearchResult) {
  if (source === "usenet") {
    return { raw: { release: raw }, score: 0 };
  }
  return { raw };
}

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

async function searchSource(source: string, query: string, workContext: ManualWorkContext) {
  if (source === "slskd") return searchSlskd(query, workContext);
  if (source === "deemix") {
    return (await getDownloadClient("deemix").search(query, { limit: 50 })).filter(
      (entry: RawSearchResult) => entry?.readable !== false,
    );
  }
  if (source === "ytdlp") {
    return (await getDownloadClient("ytdlp").search(query, { limit: 10 })).filter(
      (entry: RawSearchResult) => !isYtdlpLiveResult(entry),
    );
  }
  if (source === "usenet") return prowlarrClient.search(query, { limit: MAX_RESULTS });
  throw new Error("Unknown manual search source");
}

export function getManualDownloadSources() {
  const status = getDownloadSourceStatus();
  const sources: ManualSource[] = [];
  if (status.slskd.configured) sources.push({ id: "slskd", label: "Soulseek", source: "slskd" });
  if (status.deemix.configured) sources.push({ id: "deemix", label: "deemix", source: "deemix" });
  if (status.ytdlp.configured) sources.push({ id: "ytdlp", label: "yt-dlp", source: "ytdlp" });
  if (status.usenet.prowlarrConfigured) {
    for (const client of USENET_CLIENT_KEYS.map((key) => getDownloadClient(key))) {
      if (!client.isConfigured()) continue;
      sources.push({
        id: `usenet:${client.key}`,
        label: `Usenet · ${client.name}`,
        source: "usenet",
        downloadClient: client.key,
      });
    }
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
  const rawResults = (
    await searchSource(sourceOption.source, query, { jobId: job.id, playlistId })
  ).slice(0, MAX_RESULTS);
  return storeManualMissingSearch({
    jobId: job.id,
    actorId,
    mode,
    playlistId,
    sourceOption,
    query,
    rawResults,
  });
}

export function storeManualMissingSearch({
  jobId,
  actorId,
  mode = "missing",
  playlistId = null,
  sourceOption,
  query,
  rawResults,
}: {
  jobId: string;
  actorId: string | number;
  mode?: ManualSearchMode;
  playlistId?: string | null;
  sourceOption: ManualSource;
  query: string;
  rawResults: RawSearchResult[];
}) {
  pruneSessions();
  while (sessions.size >= MAX_SESSIONS) {
    sessions.delete(sessions.keys().next().value!);
  }
  const storedResults = new Map<string, StoredCandidate>();
  const source = text(sourceOption?.source);
  const results = (Array.isArray(rawResults) ? rawResults : []).slice(0, MAX_RESULTS).map((raw) => {
    const resultId = randomUUID();
    storedResults.set(resultId, toStoredCandidate(source, raw));
    return { id: resultId, ...resultView(source, raw) };
  });
  const sessionId = randomUUID();
  sessions.set(sessionId, {
    actorId: text(actorId),
    jobId: text(jobId),
    mode: mode === "replacement" ? "replacement" : "missing",
    playlistId: text(playlistId),
    source,
    sourceId: sourceOption?.id,
    downloadClient: sourceOption?.downloadClient || null,
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
  const candidate = session.results.get(text(resultId));
  if (!candidate) throw new Error("That search result is no longer available");
  return {
    source: session.source,
    sourceId: session.sourceId,
    downloadClient: session.downloadClient,
    mode: session.mode,
    playlistId: session.playlistId || null,
    candidate,
  };
}

export function consumeManualMissingSelection(sessionId: string) {
  return sessions.delete(text(sessionId));
}

export function clearManualMissingSearchSessions() {
  sessions.clear();
}

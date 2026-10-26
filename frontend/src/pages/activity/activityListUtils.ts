import type { LidarrRequestItem } from "../../../../backend/services/lidarrRequestBuilder.ts";
import type {
  AurralAlbumGrab,
  AurralRequestItem,
} from "../../../../backend/services/aurralHistoryService.ts";
import { formatDate, formatTime } from "../../utils/dateTime.ts";

const SOURCE_NAMES: Partial<Record<string, string>> = {
  slskd: "Soulseek",
  usenet: "Usenet",
  deemix: "deemix",
  ytdlp: "yt-dlp",
  share: "Aurral share",
};

const ALBUM_PHASE_LABELS: Partial<Record<string, string>> = {
  search: "Searching for album",
  download: "Downloading album",
  poll: "Downloading album",
  finalize: "Processing",
};

export const lookupLabel = (
  table: Partial<Record<string, string>>,
  key: string | null | undefined,
) => (key != null && Object.hasOwn(table, key) ? table[key] : undefined);

type SharedKeys = keyof LidarrRequestItem & keyof AurralRequestItem;

export type ActivityRequest = {
  [K in SharedKeys]: LidarrRequestItem[K] | AurralRequestItem[K];
} & Partial<Omit<LidarrRequestItem, SharedKeys>> &
  Partial<Omit<AurralRequestItem, SharedKeys>> & {
    children?: ActivityRequest[];
    createdAt?: number | null;
    error?: string | null;
    qualityLabel?: string | null;
    qualityState?: string | null;
    playlistType?: string | null;
    downloadSource?: string | null;
    downloadClient?: string | null;
    progressLabel?: string | null;
    sourceSummary?: string | null;
    activeStatusLabel?: string | null;
    downloadMethodLabel?: string | null;
  };

export type AlbumActivityRequest = ActivityRequest & {
  children: ActivityRequest[];
  albumGrab: AurralAlbumGrab;
};

export const isAlbumActivityRequest = (request: ActivityRequest): request is AlbumActivityRequest =>
  request.kind === "album_download" && Boolean(request.children && request.albumGrab);

export function groupAlbumGrabRequests(requests: ActivityRequest[]) {
  const rows: ActivityRequest[] = [];
  const groups = new Map<string, Map<string, ActivityRequest>>();
  for (const request of requests) {
    const grab = request.albumGrab;
    if (
      request.kind !== "track_download" ||
      request.playlistId !== "library" ||
      !grab?.id ||
      request.jobId == null ||
      !grab.memberJobIds?.includes(request.jobId)
    ) {
      rows.push(request);
      continue;
    }
    const members = groups.get(grab.id) ?? new Map<string, ActivityRequest>();
    groups.set(grab.id, members);
    members.set(request.jobId, request);
  }
  for (const [id, members] of groups) {
    const children = [...members.values()].sort(
      (left, right) =>
        Number(left.discNumber || 1) - Number(right.discNumber || 1) ||
        Number(left.trackNumber || 0) - Number(right.trackNumber || 0) ||
        String(left.jobId).localeCompare(String(right.jobId)),
    );
    const first = children[0];
    const grab = first.albumGrab!;
    const total = grab.memberJobIds.length;
    const ready = children.filter(
      (child) => child.status === "completed" || child.status === "available",
    ).length;
    const missing = Math.max(0, total - children.length);
    const blocked = children.some((child) => child.status === "blocked");
    const processing = children.some((child) => child.status === "processing");
    const pending = children.some((child) => child.status === "pending");
    const active = blocked || processing || pending;
    const albumFiles = children.filter((child) => child.downloadMethod === "album").length;
    const trackFiles = children.some((child) => child.downloadMethod === "track");
    const fallback = grab.phase === "tracks" || Boolean(grab.fallbackReason) || trackFiles;
    const activeLabel = fallback
      ? processing
        ? "Downloading tracks"
        : "Searching for tracks"
      : lookupLabel(ALBUM_PHASE_LABELS, grab.phase) || "Queued";
    const allCancelled = children.every((child) => child.status === "cancelled");
    const status = blocked
      ? "blocked"
      : active
        ? "processing"
        : ready === total
          ? "completed"
          : allCancelled && !missing
            ? "cancelled"
            : "failed";
    const statusLabel = blocked
      ? "Needs review"
      : active
        ? activeLabel
        : ready === total
          ? "Completed"
          : ready > 0 || missing
            ? "Incomplete"
            : allCancelled
              ? "Cancelled"
              : "Failed";
    const times = [grab.completedAt, ...children.map((child) => child.completedAt)]
      .map((value) => Date.parse(String(value)))
      .filter(Number.isFinite);
    const completedAt = !active && times.length ? new Date(Math.max(...times)).toISOString() : null;
    const sources = [
      ...new Set(
        children
          .map((child) => child.actualDownloadSource)
          .filter((source): source is string => Boolean(source)),
      ),
    ];
    const sourceSummary = sources.length
      ? sources.map((source) => lookupLabel(SOURCE_NAMES, source) || source).join(", ")
      : active && grab.source
        ? lookupLabel(SOURCE_NAMES, grab.source) || grab.source
        : "Unknown";
    const progressLabel =
      `${ready} of ${total} tracks ready` +
      (missing ? ` · ${missing} track detail${missing === 1 ? "" : "s"} unavailable` : "");
    rows.push({
      ...first,
      id,
      jobId: null,
      kind: "album_download",
      source: "aurral",
      trackName: null,
      title: first.albumName || "Album download",
      children,
      status,
      statusLabel,
      inQueue: active,
      canReSearch: false,
      requestedAt: grab.requestedAt,
      completedAt,
      progressLabel,
      sourceSummary,
      activeStatusLabel: blocked && (processing || pending) ? activeLabel : null,
      downloadMethodLabel: albumFiles
        ? fallback
          ? "Album download with track fallback"
          : "Album download"
        : fallback
          ? "Album attempt with track fallback"
          : "Album attempt",
      previousErrors: [...new Set(children.flatMap((child) => child.previousErrors || []))],
    });
  }
  return rows;
}

export function matchesActivitySearch(
  request: ActivityRequest,
  query: string | null | undefined,
): boolean {
  const value = String(query || "")
    .trim()
    .toLocaleLowerCase();
  if (!value) return true;
  return (
    [
      request.title,
      request.name,
      request.trackName,
      request.albumName,
      request.artistName,
      request.subtitle,
      request.statusLabel,
    ]
      .filter(Boolean)
      .join(" ")
      .toLocaleLowerCase()
      .includes(value) ||
    (request.children || []).some((child) => matchesActivitySearch(child, value))
  );
}

const getRequestIdentity = (request: ActivityRequest | null | undefined) =>
  String(
    request?.id ||
      [
        request?.source,
        request?.kind,
        request?.type,
        request?.jobId,
        request?.albumId,
        request?.mbid,
        request?.title,
        request?.name,
      ]
        .filter(Boolean)
        .join(":"),
  );

const buildRequestChangeSignature = (request: ActivityRequest | null | undefined) =>
  JSON.stringify({
    source: request?.source || null,
    kind: request?.kind || null,
    type: request?.type || null,
    title: request?.title || null,
    subtitle: request?.subtitle || null,
    name: request?.name || null,
    trackName: request?.trackName || null,
    albumName: request?.albumName || null,
    artistName: request?.artistName || null,
    status: request?.status || null,
    statusLabel: request?.statusLabel || null,
    sourceFilename: request?.sourceFilename || null,
    releaseTitle: request?.releaseTitle || null,
    href: request?.href || null,
    inQueue: request?.inQueue === true,
    canReSearch: request?.canReSearch === true,
  });

export const mergeActivityRequests = (
  previousRequests: ActivityRequest[] | null | undefined,
  nextRequests: ActivityRequest[] | null | undefined,
) => {
  const incoming = Array.isArray(nextRequests) ? nextRequests : [];
  if (!Array.isArray(previousRequests) || previousRequests.length === 0) {
    return incoming;
  }

  const previousById = new Map(
    previousRequests.map((request) => [getRequestIdentity(request), request]),
  );

  return incoming.map((request) => {
    const previous = previousById.get(getRequestIdentity(request));
    if (!previous) return request;
    if (buildRequestChangeSignature(previous) !== buildRequestChangeSignature(request)) {
      return request;
    }
    return {
      ...request,
      requestedAt: previous.requestedAt || request.requestedAt,
    };
  });
};

export const formatTimelineTime = (value: string | number | null | undefined) => {
  if (value == null) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return formatTime(date, {
    hour: "numeric",
    minute: "2-digit",
  });
};

const formatReviewDuration = (ms: number) => {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
};

export const formatReviewReasonSummary = (subtitle: string | null | undefined) => {
  const raw = String(subtitle || "").trim();
  if (!raw) return null;
  const colon = raw.indexOf(":");
  const code = (colon === -1 ? raw : raw.slice(0, colon)).trim();
  const fields = Object.create(null);
  for (const part of (colon === -1 ? "" : raw.slice(colon + 1)).split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = Number(part.slice(eq + 1).trim());
    if (key && Number.isFinite(value)) fields[key] = value;
  }
  const parts = [code.replace(/-/g, " ").replace(/^\w/, (c) => c.toUpperCase())];
  if (Number.isFinite(fields.title)) parts.push(`title ${fields.title}`);
  if (Number.isFinite(fields.artist)) parts.push(`artist ${fields.artist}`);
  if (Number.isFinite(fields.album)) parts.push(`album ${fields.album}`);
  const actual = formatReviewDuration(fields.actualDurationMs);
  const expected = formatReviewDuration(fields.expectedDurationMs);
  if (actual && expected) parts.push(`${actual} vs ${expected}`);
  else if (actual) parts.push(actual);
  return parts.join(" · ");
};

const formatDateGroupLabel = (value: string | null | undefined) => {
  if (value == null) return "Unknown date";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown date";
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.round(
    (startOfToday.getTime() - startOfDate.getTime()) / (24 * 60 * 60 * 1000),
  );
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return formatDate(date, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: date.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
  });
};

export type ActivityListEntry =
  | { type: "date"; label: string; key: string }
  | { type: "item"; request: ActivityRequest; key: string | null | undefined };

const groupRequestsByDate = (requests: ActivityRequest[]) => {
  const groups: ActivityListEntry[] = [];
  let currentLabel = null;
  for (const request of requests) {
    const label = formatDateGroupLabel(request.completedAt || request.requestedAt);
    if (label !== currentLabel) {
      currentLabel = label;
      groups.push({ type: "date", label, key: `date-${label}` });
    }
    groups.push({ type: "item", request, key: request.id || request.mbid });
  }
  return groups;
};

export const compareActivityRequests = (a: ActivityRequest, b: ActivityRequest) => {
  const aReSearchable = a?.canReSearch === true ? 1 : 0;
  const bReSearchable = b?.canReSearch === true ? 1 : 0;
  if (aReSearchable !== bReSearchable) {
    return bReSearchable - aReSearchable;
  }
  return (
    new Date((b.completedAt || b.requestedAt) ?? 0).getTime() -
      new Date((a.completedAt || a.requestedAt) ?? 0).getTime() ||
    String(b.id || "").localeCompare(String(a.id || ""))
  );
};

export const buildHistoryListEntries = (requests: ActivityRequest[]) => {
  const reSearchable = [];
  const rest = [];
  for (const request of requests) {
    if (request?.canReSearch === true) {
      reSearchable.push(request);
    } else {
      rest.push(request);
    }
  }
  const entries = reSearchable.map((request): ActivityListEntry => ({
    type: "item",
    request,
    key: request.id || request.mbid,
  }));
  return [...entries, ...groupRequestsByDate(rest)];
};

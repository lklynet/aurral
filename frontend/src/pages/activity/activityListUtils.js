import { formatDate, formatTime } from "../../utils/dateTime.js";

const SOURCE_NAMES = { slskd: "Soulseek", usenet: "Usenet", deemix: "deemix", ytdlp: "yt-dlp" };

export function groupAlbumGrabRequests(requests) {
  const rows = [];
  const groups = new Map();
  for (const request of requests) {
    const grab = request.albumGrab;
    if (request.kind !== "track_download" || request.playlistId !== "library"
      || !grab?.id || !grab.memberJobIds?.includes(request.jobId)) {
      rows.push(request);
      continue;
    }
    if (!groups.has(grab.id)) groups.set(grab.id, new Map());
    groups.get(grab.id).set(request.jobId, request);
  }
  for (const [id, members] of groups) {
    const children = [...members.values()].sort((left, right) =>
      Number(left.discNumber || 1) - Number(right.discNumber || 1)
      || Number(left.trackNumber || 0) - Number(right.trackNumber || 0)
      || String(left.jobId).localeCompare(String(right.jobId)));
    const first = children[0];
    const grab = first.albumGrab;
    const total = grab.memberJobIds.length;
    const ready = children.filter((child) => child.status === "completed" || child.status === "available").length;
    const missing = Math.max(0, total - children.length);
    const blocked = children.some((child) => child.status === "blocked");
    const processing = children.some((child) => child.status === "processing");
    const pending = children.some((child) => child.status === "pending");
    const active = blocked || processing || pending;
    const albumFiles = children.filter((child) => child.downloadMethod === "album").length;
    const trackFiles = children.some((child) => child.downloadMethod === "track");
    const fallback = grab.phase === "tracks" || Boolean(grab.fallbackReason) || trackFiles;
    const activeLabel = fallback
      ? processing ? "Downloading tracks" : "Searching for tracks"
      : { search: "Searching for album", download: "Downloading album", poll: "Downloading album", finalize: "Processing" }[grab.phase] || "Queued";
    const allCancelled = children.every((child) => child.status === "cancelled");
    const status = blocked ? "blocked" : active ? "processing" : ready === total ? "completed"
      : allCancelled && !missing ? "cancelled" : "failed";
    const statusLabel = blocked ? "Needs review" : active ? activeLabel
      : ready === total ? "Completed" : ready > 0 || missing ? "Incomplete" : allCancelled ? "Cancelled" : "Failed";
    const times = [grab.completedAt, ...children.map((child) => child.completedAt)].map(Date.parse).filter(Number.isFinite);
    const completedAt = !active && times.length ? new Date(Math.max(...times)).toISOString() : null;
    const sources = [...new Set(children.map((child) => child.actualDownloadSource).filter(Boolean))];
    const sourceSummary = sources.length ? sources.map((source) => SOURCE_NAMES[source] || source).join(", ")
      : active && grab.source ? SOURCE_NAMES[grab.source] || grab.source : "Unknown";
    const progressLabel = `${ready} of ${total} tracks ready`
      + (missing ? ` · ${missing} track detail${missing === 1 ? "" : "s"} unavailable` : "");
    rows.push({
      ...first, id, jobId: null, kind: "album_download", source: "aurral",
      trackName: null, title: first.albumName || "Album download", children,
      status, statusLabel, inQueue: active, canReSearch: false,
      requestedAt: grab.requestedAt, completedAt, progressLabel, sourceSummary,
      activeStatusLabel: blocked && (processing || pending) ? activeLabel : null,
      downloadMethodLabel: albumFiles ? fallback ? "Album download with track fallback" : "Album download"
        : fallback ? "Album attempt with track fallback" : "Album attempt",
      previousErrors: [...new Set(children.flatMap((child) => child.previousErrors || []))],
    });
  }
  return rows;
}

export function matchesActivitySearch(request, query) {
  const value = String(query || "").trim().toLocaleLowerCase();
  if (!value) return true;
  return [request.title, request.name, request.trackName, request.albumName,
    request.artistName, request.subtitle, request.statusLabel]
    .filter(Boolean).join(" ").toLocaleLowerCase().includes(value)
    || (request.children || []).some((child) => matchesActivitySearch(child, value));
}

const getRequestIdentity = (request) =>
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

const buildRequestChangeSignature = (request) =>
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
    href: request?.href || null,
    inQueue: request?.inQueue === true,
    canReSearch: request?.canReSearch === true,
  });

export const mergeActivityRequests = (previousRequests, nextRequests) => {
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

export const formatTimelineTime = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return formatTime(date, {
    hour: "numeric",
    minute: "2-digit",
  });
};

const formatReviewDuration = (ms) => {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
};

export const formatReviewReasonSummary = (subtitle) => {
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

const formatDateGroupLabel = (value) => {
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

const groupRequestsByDate = (requests) => {
  const groups = [];
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

export const compareActivityRequests = (a, b) => {
  const aReSearchable = a?.canReSearch === true ? 1 : 0;
  const bReSearchable = b?.canReSearch === true ? 1 : 0;
  if (aReSearchable !== bReSearchable) {
    return bReSearchable - aReSearchable;
  }
  return (
    new Date(b.completedAt || b.requestedAt) - new Date(a.completedAt || a.requestedAt) ||
    String(b.id || "").localeCompare(String(a.id || ""))
  );
};

export const buildHistoryListEntries = (requests) => {
  const reSearchable = [];
  const rest = [];
  for (const request of requests) {
    if (request?.canReSearch === true) {
      reSearchable.push(request);
    } else {
      rest.push(request);
    }
  }
  const entries = reSearchable.map((request) => ({
    type: "item",
    request,
    key: request.id || request.mbid,
  }));
  return [...entries, ...groupRequestsByDate(rest)];
};

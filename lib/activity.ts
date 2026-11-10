import type { LidarrRequestItem } from "../backend/services/lidarrRequestBuilder.ts";
import type {
  AurralAlbumGrab,
  AurralRequestItem,
} from "../backend/services/aurralHistoryRequests.ts";

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
    downloadMethodLabel?: string | null;
  };

export type AlbumActivityRequest = ActivityRequest & {
  children: ActivityRequest[];
  albumGrab: AurralAlbumGrab;
};

export const DOWNLOAD_CLIENTS: Partial<Record<string, string>> = {
  slskd: "slskd",
  usenet: "Usenet",
  nzbget: "NZBGet",
  sabnzbd: "SABnzbd",
  tidarr: "Tidarr",
  deemix: "deemix",
  ytdlp: "yt-dlp",
  qbittorrent: "qBittorrent",
  share: "Aurral share",
};

const ALBUM_PHASE_LABELS: Partial<Record<string, string>> = {
  search: "Searching for album",
  download: "Downloading album",
  poll: "Downloading album",
  finalize: "Processing",
};

const ALBUM_TRACK_PHASE_LABELS: Partial<Record<string, string>> = {
  search: "Searching",
  download: "Downloading",
  poll: "Downloading",
  finalize: "Processing",
};

export const lookupLabel = (
  table: Partial<Record<string, string>>,
  key: string | null | undefined,
) => (key != null && Object.hasOwn(table, key) ? table[key] : undefined);

export const ACTIVITY_VIEW_IDS = ["queue", "history"] as const;
export type ActivityView = (typeof ACTIVITY_VIEW_IDS)[number];

const ACTIVITY_STATUS_LABELS = {
  searching: "Searching",
  downloading: "Downloading",
  queued: "Queued",
  review: "Review",
  downloaded: "Downloaded",
  upgraded: "Upgraded",
  failed: "Failed",
  cancelled: "Cancelled",
};

export type ActivityStatus = keyof typeof ACTIVITY_STATUS_LABELS;

const VIEW_STATUSES: Partial<Record<string, ActivityStatus[]>> = {
  queue: ["searching", "downloading", "queued", "review", "failed"],
  history: ["downloaded", "upgraded", "failed", "cancelled"],
};

const DOWNLOAD_KINDS = new Set(["track_download", "album_download"]);

type ActivityStatusInput = {
  status?: string;
  statusLabel?: string | null;
  kind?: string | null;
  inQueue?: boolean;
  upgrade?: unknown;
};

export function getActivityStatus(
  request: ActivityStatusInput | null | undefined,
): ActivityStatus | null {
  const label = request?.statusLabel ?? "";
  switch (request?.status) {
    case "blocked":
      return "review";
    case "pending":
      return "queued";
    case "processing":
      if (/queued/i.test(label)) return "queued";
      if (/search|requested/i.test(label)) return "searching";
      if (/download|waiting|moving|processing/i.test(label)) return "downloading";
      return null;
    case "completed":
    case "available":
      if (request.upgrade) return "upgraded";
      return DOWNLOAD_KINDS.has(request.kind ?? "") || label === "Downloaded" ? "downloaded" : null;
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return null;
  }
}

export function getActivityStatusFilters(
  view: string,
  requests: readonly ActivityStatusInput[],
  active: ActivityStatus | null,
) {
  const counts = new Map<ActivityStatus, number>();
  for (const request of requests) {
    const status = getActivityStatus(request);
    if (status) counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  return (VIEW_STATUSES[view] ?? [])
    .map((id) => ({ id, label: ACTIVITY_STATUS_LABELS[id], count: counts.get(id) ?? 0 }))
    .filter((filter) => view !== "queue" || filter.count > 0 || filter.id === active);
}

export function normalizeActivityStatus(
  view: string,
  status: string | null | undefined,
): ActivityStatus | null {
  return VIEW_STATUSES[view]?.find((id) => id === status) ?? null;
}

export function isActivityQueueItem(request: ActivityStatusInput | null | undefined) {
  return (
    request?.status === "blocked" ||
    request?.inQueue === true ||
    request?.status === "processing" ||
    request?.status === "pending"
  );
}

export function matchesActivityView(request: ActivityStatusInput | null | undefined, view: string) {
  if (view === "queue") return isActivityQueueItem(request);
  if (view === "review") return false;
  if (view === "missing") return false;
  return !isActivityQueueItem(request) && request?.status !== "blocked";
}

export const isCancelableDownload = (request: ActivityRequest) =>
  request.kind === "track_download" &&
  !!request.jobId &&
  (request.status === "pending" || request.status === "processing");

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
  const groupedRequestIds = new Set<string>();
  for (const [id, members] of groups) {
    const sorted = [...members.values()].sort(
      (left, right) =>
        Number(left.discNumber || 1) - Number(right.discNumber || 1) ||
        Number(left.trackNumber || 0) - Number(right.trackNumber || 0) ||
        String(left.jobId).localeCompare(String(right.jobId)),
    );
    const [first] = sorted;
    if (!first) continue;
    const grab = first.albumGrab!;
    const total = grab.memberJobIds.length;
    const albumFiles = sorted.filter((child) => child.downloadMethod === "album").length;
    const trackFiles = sorted.some((child) => child.downloadMethod === "track");
    const fallback = grab.phase === "tracks" || Boolean(grab.fallbackReason) || trackFiles;
    const albumTrackLabel = fallback ? null : lookupLabel(ALBUM_TRACK_PHASE_LABELS, grab.phase);
    const children = albumTrackLabel
      ? sorted.map((child) =>
          child.status === "pending" || child.status === "processing"
            ? { ...child, status: "processing", statusLabel: albumTrackLabel }
            : child,
        )
      : sorted;
    const ready = children.filter(
      (child) => child.status === "completed" || child.status === "available",
    ).length;
    const missing = Math.max(0, total - children.length);
    const blocked = children.some((child) => child.status === "blocked");
    const processing = children.some((child) => child.status === "processing");
    const pending = children.some((child) => child.status === "pending");
    const active = blocked || processing || pending;
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
      ? sources.map((source) => lookupLabel(DOWNLOAD_CLIENTS, source) || source).join(", ")
      : active && grab.source
        ? lookupLabel(DOWNLOAD_CLIENTS, grab.source) || grab.source
        : null;
    const progressLabel =
      `${ready} of ${total} tracks ready` +
      (missing ? ` · ${missing} track detail${missing === 1 ? "" : "s"} unavailable` : "");
    if (first.requestGroupId) groupedRequestIds.add(first.requestGroupId);
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
  return rows.filter(
    (row) =>
      row.kind !== "album_requested" ||
      !row.requestGroupId ||
      !groupedRequestIds.has(row.requestGroupId),
  );
}

const activityTime = (request: ActivityRequest) =>
  new Date((request.completedAt || request.requestedAt) ?? 0).getTime();

export function buildActivityPage(
  requests: ActivityRequest[],
  { view, status, limit }: { view: ActivityView; status: ActivityStatus | null; limit: number },
) {
  const viewRequests = groupAlbumGrabRequests(requests).filter((request) =>
    matchesActivityView(request, view),
  );
  const matching = status
    ? viewRequests.filter((request) => getActivityStatus(request) === status)
    : viewRequests;
  const times = new Map(matching.map((request) => [request, activityTime(request)]));
  const items = matching
    .toSorted((a, b) => {
      const reSearch = Number(b.canReSearch === true) - Number(a.canReSearch === true);
      return (
        reSearch ||
        times.get(b)! - times.get(a)! ||
        String(b.id || "").localeCompare(String(a.id || ""))
      );
    })
    .slice(0, limit);
  return {
    view,
    items,
    total: viewRequests.length,
    matching: matching.length,
    filters: getActivityStatusFilters(view, viewRequests, status),
  };
}

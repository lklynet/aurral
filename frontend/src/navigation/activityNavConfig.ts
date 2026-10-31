export const ACTIVITY_VIEWS = [
  { id: "queue", label: "Queue" },
  { id: "history", label: "History" },
  { id: "missing", label: "Missing" },
];

export const WANTED_VIEWS = [
  { id: "missing", label: "Missing", path: "/activity/missing" },
  { id: "cutoff", label: "Cutoff unmet", path: "/activity/missing?tab=cutoff" },
];

export const DEFAULT_ACTIVITY_VIEW = "queue";

export function normalizeActivityView(view: string | null | undefined) {
  if (!view) return DEFAULT_ACTIVITY_VIEW;
  return ACTIVITY_VIEWS.some((entry) => entry.id === view) ? view : DEFAULT_ACTIVITY_VIEW;
}

type ActivityRequest = {
  status?: string;
  statusLabel?: string | null;
  kind?: string | null;
  inQueue?: boolean;
  upgrade?: unknown;
};

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

export function getActivityStatus(
  request: ActivityRequest | null | undefined,
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
  requests: readonly ActivityRequest[],
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

export function isActivityQueueItem(request: ActivityRequest | null | undefined) {
  return (
    request?.status === "blocked" ||
    request?.inQueue === true ||
    request?.status === "processing" ||
    request?.status === "pending"
  );
}

export function matchesActivityView(request: ActivityRequest | null | undefined, view: string) {
  if (view === "queue") return isActivityQueueItem(request);
  if (view === "review") return false;
  if (view === "missing") return false;
  return !isActivityQueueItem(request) && request?.status !== "blocked";
}

export function buildActivityPath(view: string | null | undefined) {
  const nextView = normalizeActivityView(view);
  return `/activity/${nextView}`;
}

export function buildWantedPath(view = "missing") {
  return WANTED_VIEWS.find((entry) => entry.id === view)?.path || WANTED_VIEWS[0].path;
}

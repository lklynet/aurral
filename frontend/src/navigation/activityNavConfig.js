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

export function normalizeActivityView(view) {
  if (!view) return DEFAULT_ACTIVITY_VIEW;
  return ACTIVITY_VIEWS.some((entry) => entry.id === view) ? view : DEFAULT_ACTIVITY_VIEW;
}

export function isActivityQueueItem(request) {
  return (
    request?.status === "blocked" ||
    request?.inQueue === true ||
    request?.status === "processing" ||
    request?.status === "pending"
  );
}

export function matchesActivityView(request, view) {
  if (view === "queue") return isActivityQueueItem(request);
  if (view === "review") return false;
  if (view === "missing") return false;
  return !isActivityQueueItem(request) && request?.status !== "blocked";
}

export function buildActivityPath(view) {
  const nextView = normalizeActivityView(view);
  return `/activity/${nextView}`;
}

export function buildWantedPath(view = "missing") {
  return WANTED_VIEWS.find((entry) => entry.id === view)?.path || WANTED_VIEWS[0].path;
}

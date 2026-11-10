export const ACTIVITY_VIEWS = [
  { id: "queue", label: "Queue" },
  { id: "history", label: "History" },
  { id: "missing", label: "Missing" },
];

export const WANTED_VIEWS = [
  { id: "missing", label: "Missing", path: "/activity/missing" },
  { id: "cutoff", label: "Cutoff unmet", path: "/activity/missing?tab=cutoff" },
] satisfies [unknown, ...unknown[]];

export const DEFAULT_ACTIVITY_VIEW = "queue";

export function normalizeActivityView(view: string | null | undefined) {
  if (!view) return DEFAULT_ACTIVITY_VIEW;
  return ACTIVITY_VIEWS.some((entry) => entry.id === view) ? view : DEFAULT_ACTIVITY_VIEW;
}

export function buildActivityPath(view: string | null | undefined) {
  const nextView = normalizeActivityView(view);
  return `/activity/${nextView}`;
}

export function buildWantedPath(view = "missing") {
  return WANTED_VIEWS.find((entry) => entry.id === view)?.path || WANTED_VIEWS[0].path;
}
